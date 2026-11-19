'use strict';

/**
 * Lexer (translation phases 5-7 up to parsing), D-034.
 *
 * Converts the preprocessing tokens of a translation unit into C++ tokens:
 *   - identifiers are split into keywords and identifiers;
 *   - numeric, character and string literals are decoded and checked;
 *   - adjacent string literals are concatenated (phase 6);
 *   - tokens that cannot appear after preprocessing (`#`, `##`, stray
 *     characters) are reported.
 *
 * The lexer does not choose the type of integer literals (`int`, `long`,
 * ...): it records value, radix and suffix, and semantic analysis applies
 * the rules of C++11 2.14.2 with the target's type sizes.
 */

var I = require('../util/int64');
var literals = require('./literals');
var PPKind = require('../preprocessor/pp-lexer').TokenKind;

var TokenKind = {
  IDENTIFIER: 'identifier',
  KEYWORD: 'keyword',
  INTEGER: 'integer',
  FLOAT: 'float',
  CHAR: 'char',
  STRING: 'string',
  PUNCT: 'punct',
  EOF: 'eof'
};

/** C++11 keywords (2.12, table 4) plus `__js__` (D-026). */
var KEYWORDS = {};
('alignas alignof asm auto bool break case catch char char16_t char32_t class const ' +
  'constexpr const_cast continue decltype default delete do double dynamic_cast else enum ' +
  'explicit export extern false float for friend goto if inline int long mutable namespace ' +
  'new noexcept nullptr operator private protected public register reinterpret_cast return ' +
  'short signed sizeof static static_assert static_cast struct switch template this ' +
  'thread_local throw true try typedef typeid typename union unsigned using virtual void ' +
  'volatile wchar_t while __js__').split(' ').forEach(function (word) {
  KEYWORDS[word] = true;
});

var INTEGER_SUFFIX = /^(|[uU]|[uU]?(l|L|ll|LL)|(l|L|ll|LL)[uU])$/;

/**
 * Creates a C++ token from a preprocessing token.
 */
function makeToken(kind, pp, value) {
  return {
    kind: kind,
    text: pp.text,
    value: value,
    source: pp.source,
    start: pp.start,
    end: pp.end,
    spaceBefore: pp.spaceBefore,
    lineStart: pp.lineStart,
    expansion: pp.expansion
  };
}

function rootOf(tok) {
  while (tok.expansion) {
    tok = tok.expansion.site;
  }
  return tok;
}

/**
 * @constructor
 * @param {DiagnosticBag} diagnostics
 */
function Lexer(diagnostics) {
  this._diagnostics = diagnostics;
}

/**
 * Reports a diagnostic at the user's code. For a token produced by a macro,
 * the error points at the outermost invocation and notes show the macro
 * definitions the token was spelled in, innermost first (as Clang).
 */
Lexer.prototype._report = function (severity, message, pp) {
  var root = rootOf(pp);
  var span = { source: root.source, start: root.start, end: root.end };
  var diag = severity === 'error' ? this._diagnostics.error(message, span) :
    this._diagnostics.warning(message, span);
  var tok = pp;
  while (tok.expansion) {
    diag.addNote('expanded from macro \'' + tok.expansion.macro + '\'',
      { source: tok.source, start: tok.start, end: tok.end });
    tok = tok.expansion.site;
  }
};

/** Returns a `report(severity, message)` callback located at `pp`. */
Lexer.prototype._reporter = function (pp) {
  var self = this;
  return function (severity, message) {
    self._report(severity, message, pp);
  };
};

/**
 * Lexes a translation unit.
 *
 * @param {Array.<Object>} ppTokens Output of the preprocessor.
 * @param {SourceFile} main Main file, where the end-of-file token is placed.
 * @returns {Array.<Object>} C++ tokens, ending with an `eof` token.
 *   Tokens that are invalid are reported and left out.
 */
Lexer.prototype.lex = function (ppTokens, main) {
  var out = [];
  var strings = [];
  var i;
  var pp;
  var tok;
  for (i = 0; i < ppTokens.length; i++) {
    pp = ppTokens[i];
    if (pp.kind === PPKind.STRING) {
      strings.push(pp);
      continue;
    }
    if (strings.length) {
      this._pushString(out, strings);
      strings = [];
    }
    tok = this._convert(pp);
    if (tok) {
      out.push(tok);
    }
  }
  if (strings.length) {
    this._pushString(out, strings);
  }
  out.push({
    kind: TokenKind.EOF,
    text: '',
    value: null,
    source: main,
    start: main.text.length,
    end: main.text.length,
    spaceBefore: false,
    lineStart: true,
    expansion: null
  });
  return out;
};

Lexer.prototype._pushString = function (out, pieces) {
  var tok = this._string(pieces);
  if (tok) {
    out.push(tok);
  }
};

/**
 * Converts one non-string preprocessing token.
 *
 * @returns {?Object} The token, or null if it was invalid.
 */
Lexer.prototype._convert = function (pp) {
  switch (pp.kind) {
    case PPKind.IDENTIFIER:
      return makeToken(KEYWORDS.hasOwnProperty(pp.value) ? TokenKind.KEYWORD :
        TokenKind.IDENTIFIER, pp, pp.value);
    case PPKind.NUMBER:
      return this._number(pp);
    case PPKind.CHAR:
      return this._character(pp);
    case PPKind.PUNCT:
      if (pp.value === '#' || pp.value === '##') {
        this._report('error', 'stray \'' + pp.text + '\' in program', pp);
        return null;
      }
      return makeToken(TokenKind.PUNCT, pp, pp.value);
  }
  // An unterminated literal was already reported by the pp-lexer.
  if (!/^(u8|u|U|L)?R?["']/.test(pp.text)) {
    this._report('error', 'stray \'' + pp.text + '\' in program', pp);
  }
  return null;
};

/**
 * Integer and floating literals (C++11 2.14.2, 2.14.4). Binary integers and
 * hexadecimal floats are accepted as extensions (C++14 / C++17), D-034.
 */
Lexer.prototype._number = function (pp) {
  var text = pp.text;
  var match;
  var value;
  if (/^0[xX]/.test(text)) {
    if (/[.pP]/.test(text)) {
      return this._hexFloat(pp);
    }
    match = /^0[xX]([0-9a-fA-F]*)(.*)$/.exec(text);
    return this._integer(pp, match[1], 16, match[2]);
  }
  if (/^0[bB]/.test(text)) {
    match = /^0[bB]([01]*)(.*)$/.exec(text);
    return this._integer(pp, match[1], 2, match[2]);
  }
  if (/^[0-9]*\./.test(text) || /^[0-9]+[eE]/.test(text)) {
    match = /^(([0-9]*\.[0-9]*)([eE]([+-]?[0-9]*))?|[0-9]+[eE]([+-]?[0-9]*))(.*)$/.exec(text);
    if ((match[3] !== undefined && !/[0-9]/.test(match[4])) ||
        (match[5] !== undefined && !/[0-9]/.test(match[5]))) {
      this._report('error', 'exponent has no digits', pp);
      return null;
    }
    value = Number(match[1]);
    return this._float(pp, value, match[6]);
  }
  match = /^([0-9]+)(.*)$/.exec(text);
  if (match[1].length > 1 && match[1].charAt(0) === '0') {
    if (/[89]/.test(match[1])) {
      this._report('error', 'invalid digit \'' + /[89]/.exec(match[1])[0] +
        '\' in octal constant', pp);
      return null;
    }
    return this._integer(pp, match[1].slice(1), 8, match[2]);
  }
  return this._integer(pp, match[1], 10, match[2]);
};

Lexer.prototype._integer = function (pp, digits, radix, suffix) {
  var value;
  var ud = null;
  if (!digits.length) {
    if (radix === 8) {
      digits = '0';
    } else {
      this._report('error', 'invalid integer constant \'' + pp.text + '\'', pp);
      return null;
    }
  }
  if (suffix.charAt(0) === '_') {
    ud = suffix;
    suffix = '';
  }
  if (!INTEGER_SUFFIX.test(suffix)) {
    this._report('error', 'invalid suffix \'' + suffix + '\' on integer constant', pp);
    return null;
  }
  value = I.parse(digits, radix);
  if (value === null) {
    this._report('error', 'integer literal is too large to be represented in any ' +
      'integer type', pp);
    return null;
  }
  return makeToken(TokenKind.INTEGER, pp, {
    value: value,
    radix: radix,
    unsigned: /[uU]/.test(suffix),
    longs: /ll|LL/.test(suffix) ? 2 : (/[lL]/.test(suffix) ? 1 : 0),
    udSuffix: ud
  });
};

Lexer.prototype._hexFloat = function (pp) {
  var match = /^0[xX]([0-9a-fA-F]*)(\.([0-9a-fA-F]*))?([pP]([+-]?[0-9]*))?(.*)$/.exec(pp.text);
  var intDigits = match[1];
  var fracDigits = match[3] || '';
  var value;
  if (!match[4]) {
    this._report('error', 'hexadecimal floating literal requires an exponent', pp);
    return null;
  }
  if (!/[0-9]/.test(match[5])) {
    this._report('error', 'exponent has no digits', pp);
    return null;
  }
  if (!intDigits.length && !fracDigits.length) {
    this._report('error', 'invalid hexadecimal floating constant', pp);
    return null;
  }
  value = parseInt(intDigits + fracDigits || '0', 16) *
    Math.pow(2, Number(match[5]) - 4 * fracDigits.length);
  return this._float(pp, value, match[6]);
};

Lexer.prototype._float = function (pp, value, suffix) {
  var ud = null;
  if (suffix.charAt(0) === '_') {
    ud = suffix;
    suffix = '';
  }
  if (!/^[fFlL]?$/.test(suffix)) {
    this._report('error', 'invalid suffix \'' + suffix + '\' on floating constant', pp);
    return null;
  }
  if (!isFinite(value)) {
    this._report('warning', 'floating constant exceeds range of \'double\'', pp);
  }
  return makeToken(TokenKind.FLOAT, pp, {
    value: value,
    suffix: suffix.toLowerCase(),
    udSuffix: ud
  });
};

Lexer.prototype._character = function (pp) {
  var match = /^(u|U|L)?'(.*)'([A-Za-z_]\w*)?$/.exec(pp.text);
  var result = literals.characterValue(match[1] || '', match[2], this._reporter(pp));
  if (result === null) {
    return null;
  }
  return makeToken(TokenKind.CHAR, pp, {
    value: result.value,
    encoding: match[1] || '',
    multi: result.multi,
    udSuffix: match[3] || null
  });
};

/**
 * Splits a string literal spelling into prefix, raw flag, body and suffix.
 */
function splitString(text) {
  var match = /^(u8|u|U|L)?(R?)"/.exec(text);
  var prefix = match[1] || '';
  var raw = match[2] === 'R';
  var close;
  var delimiter;
  var body;
  if (raw) {
    delimiter = text.slice(match[0].length, text.indexOf('(', match[0].length));
    close = text.lastIndexOf(')' + delimiter + '"');
    body = text.slice(text.indexOf('(', match[0].length) + 1, close)
      // A raw string keeps its splices, but line ends are newlines.
      .replace(/\r\n?/g, '\n');
    return { prefix: prefix, raw: true, body: body,
      suffix: text.slice(close + delimiter.length + 2) };
  }
  close = text.lastIndexOf('"');
  return { prefix: prefix, raw: false, body: text.slice(match[0].length, close),
    suffix: text.slice(close + 1) };
}

/**
 * Concatenates adjacent string literals (C++11 2.14.5/13) into one token.
 */
Lexer.prototype._string = function (pieces) {
  var parts = [];
  var encoding = '';
  var suffix = '';
  var units = [];
  var report;
  var chars;
  var piece;
  var i;
  var tok;
  for (i = 0; i < pieces.length; i++) {
    parts.push(splitString(pieces[i].text));
    if (parts[i].prefix) {
      if (encoding && encoding !== parts[i].prefix &&
          !(isNarrow(encoding) && isNarrow(parts[i].prefix))) {
        this._report('error', 'unsupported non-standard concatenation of string literals',
          pieces[i]);
        return null;
      }
      if (!encoding) {
        encoding = parts[i].prefix;
      }
    }
    if (parts[i].suffix) {
      if (suffix && suffix !== parts[i].suffix) {
        this._report('error', 'differing user-defined suffixes (\'' + suffix + '\' and \'' +
          parts[i].suffix + '\') in string literal concatenation', pieces[i]);
        return null;
      }
      suffix = parts[i].suffix;
    }
  }
  for (i = 0; i < parts.length; i++) {
    piece = parts[i];
    report = this._reporter(pieces[i]);
    if (piece.raw) {
      chars = literals.decodeEscapes(piece.body.replace(/\\/g, '\\\\'), report);
    } else {
      chars = literals.decodeEscapes(piece.body, report);
    }
    if (chars === null) {
      return null;
    }
    chars = literals.encode(chars, encoding, report);
    if (chars === null) {
      return null;
    }
    units = units.concat(chars);
  }
  tok = makeToken(TokenKind.STRING, pieces[0], {
    encoding: encoding,
    units: units,
    udSuffix: suffix || null
  });
  tok.text = pieces.map(function (p) { return p.text; }).join(' ');
  // Span the whole sequence when it lies in one file region.
  if (pieces[pieces.length - 1].source === tok.source && !tok.expansion &&
      !pieces[pieces.length - 1].expansion) {
    tok.end = pieces[pieces.length - 1].end;
  }
  tok.pieces = pieces;
  return tok;
};

/** `u8` and no prefix both denote UTF-8 narrow strings. */
function isNarrow(prefix) {
  return prefix === '' || prefix === 'u8';
}

module.exports = {
  TokenKind: TokenKind,
  KEYWORDS: KEYWORDS,
  Lexer: Lexer
};
