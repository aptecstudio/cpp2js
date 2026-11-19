'use strict';

/**
 * Decoding of C++11 character and string literal bodies, shared by the
 * `#if` evaluator and the lexer (D-034).
 *
 * Literal contents are represented faithfully as the *code units* of their
 * encoding, as a C++ compiler stores them:
 *   - no prefix and `u8`: UTF-8 bytes;
 *   - `u`: UTF-16 code units;
 *   - `U` and `L`: code points (32-bit units).
 * How strings are represented at run time is decided later; the lexer only
 * delivers these units.
 *
 * Errors and warnings are reported through a callback
 * `report(severity, message)` so that callers can attach a location.
 */

var SIMPLE_ESCAPES = {
  'n': 10, 't': 9, 'v': 11, 'b': 8, 'r': 13, 'f': 12, 'a': 7,
  '\\': 92, '?': 63, '\'': 39, '"': 34
};

/** Largest unit value of each encoding. */
var UNIT_MAX = { '': 0xff, 'u8': 0xff, 'u': 0xffff, 'U': 0xffffffff, 'L': 0xffffffff };

/**
 * Decodes escape sequences.
 *
 * @param {string} body Text between the quotes.
 * @param {function(string, string)} report Called as (severity, message).
 * @returns {?Array.<{code: number, isUnit: boolean, escape: (string|undefined)}>}
 *   The characters: a code point, or a raw code unit for numeric escapes
 *   (`\xff`, `\377`, with `escape` set to 'hex' or 'octal'), which bypass
 *   encoding. Null after an error.
 */
function decodeEscapes(body, report) {
  var out = [];
  var i = 0;
  var ch;
  var code;
  var match;
  var rest;
  while (i < body.length) {
    ch = body.charAt(i);
    if (ch !== '\\') {
      code = body.charCodeAt(i);
      // Combine a UTF-16 surrogate pair of the source text into one code point.
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < body.length) {
        code = 0x10000 + ((code - 0xd800) << 10) + (body.charCodeAt(i + 1) - 0xdc00);
        i++;
      }
      out.push({ code: code, isUnit: false });
      i++;
      continue;
    }
    ch = body.charAt(i + 1);
    rest = body.slice(i + 2);
    if (SIMPLE_ESCAPES.hasOwnProperty(ch)) {
      out.push({ code: SIMPLE_ESCAPES[ch], isUnit: false });
      i += 2;
    } else if (ch >= '0' && ch <= '7') {
      match = /^[0-7]{1,3}/.exec(body.slice(i + 1));
      out.push({ code: parseInt(match[0], 8), isUnit: true, escape: 'octal' });
      i += 1 + match[0].length;
    } else if (ch === 'x') {
      match = /^[0-9a-fA-F]+/.exec(rest);
      if (!match) {
        report('error', '\\x used with no following hex digits');
        return null;
      }
      out.push({ code: match[0].length > 8 ? Infinity : parseInt(match[0], 16), isUnit: true,
        escape: 'hex' });
      i += 2 + match[0].length;
    } else if (ch === 'u' || ch === 'U') {
      match = (ch === 'u' ? /^[0-9a-fA-F]{4}/ : /^[0-9a-fA-F]{8}/).exec(rest);
      if (!match) {
        report('error', 'incomplete universal character name');
        return null;
      }
      code = parseInt(match[0], 16);
      if ((code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff) {
        report('error', 'invalid universal character');
        return null;
      }
      out.push({ code: code, isUnit: false });
      i += 2 + match[0].length;
    } else {
      // Conditionally-supported in C++11; GCC and Clang warn and keep the
      // character itself.
      report('warning', 'unknown escape sequence \'\\' + ch + '\'');
      out.push({ code: body.charCodeAt(i + 1), isUnit: false });
      i += 2;
    }
  }
  return out;
}

/**
 * Appends the UTF-8 bytes of a code point.
 */
function utf8(units, code) {
  if (code < 0x80) {
    units.push(code);
  } else if (code < 0x800) {
    units.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
  } else if (code < 0x10000) {
    units.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  } else {
    units.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f),
      0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
}

/**
 * Encodes decoded characters into the code units of an encoding.
 *
 * @param {Array.<{code: number, isUnit: boolean}>} chars
 * @param {string} encoding '', 'u8', 'u', 'U' or 'L'.
 * @param {function(string, string)} report
 * @returns {?Array.<number>} The units, or null after an error.
 */
function encode(chars, encoding, report) {
  var units = [];
  var i;
  var code;
  for (i = 0; i < chars.length; i++) {
    code = chars[i].code;
    if (chars[i].isUnit) {
      if (code > UNIT_MAX[encoding]) {
        report('error', chars[i].escape + ' escape sequence out of range');
        return null;
      }
      units.push(code);
    } else if (encoding === '' || encoding === 'u8') {
      utf8(units, code);
    } else if (encoding === 'u' && code > 0xffff) {
      code -= 0x10000;
      units.push(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff));
    } else {
      units.push(code);
    }
  }
  return units;
}

/**
 * Computes the value of a character literal (C++11 2.14.3). Plain `char`
 * is signed 8-bit; `wchar_t` is signed 32-bit; `char16_t` and `char32_t`
 * are unsigned (D-033). A plain literal of several bytes is an `int` built
 * from them, as in GCC, with a warning.
 *
 * @param {string} prefix '', 'u', 'U' or 'L'.
 * @param {string} body Text between the quotes.
 * @param {function(string, string)} report
 * @returns {?{value: number, unsigned: boolean, multi: boolean}}
 */
function characterValue(prefix, body, report) {
  var chars = decodeEscapes(body, report);
  var units;
  var value;
  var i;
  if (chars === null) {
    return null;
  }
  if (!chars.length) {
    report('error', 'empty character constant');
    return null;
  }
  if (prefix) {
    if (chars.length > 1) {
      report('error', 'character constant with more than one character');
      return null;
    }
    if (chars[0].code > UNIT_MAX[prefix] || (prefix === 'u' && chars[0].code > 0xffff)) {
      report('error', 'character too large for enclosing character literal type');
      return null;
    }
    if (prefix === 'L') {
      return { value: chars[0].code | 0, unsigned: false, multi: false };
    }
    return { value: chars[0].code, unsigned: true, multi: false };
  }
  units = [];
  for (i = 0; i < chars.length; i++) {
    if (chars[i].isUnit) {
      if (chars[i].code > 0xff) {
        report('error', 'character too large for enclosing character literal type');
        return null;
      }
      units.push(chars[i].code);
    } else {
      utf8(units, chars[i].code);
    }
  }
  if (units.length === 1) {
    // Plain char is signed: '\xff' is -1.
    return { value: units[0] > 0x7f ? units[0] - 0x100 : units[0], unsigned: false,
      multi: false };
  }
  if (units.length > 4) {
    report('error', 'character constant too long for its type');
    return null;
  }
  report('warning', 'multi-character character constant');
  value = 0;
  for (i = 0; i < units.length; i++) {
    value = ((value << 8) | units[i]) | 0;
  }
  return { value: value, unsigned: false, multi: true };
}

module.exports = {
  decodeEscapes: decodeEscapes,
  encode: encode,
  characterValue: characterValue
};
