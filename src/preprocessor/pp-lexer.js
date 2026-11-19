'use strict';

/**
 * Preprocessing-token lexer (translation phases 1-3 of C++11).
 *
 * - Phase 1: a leading UTF-8 byte order mark is ignored. Trigraphs are not
 *   replaced (D-033).
 * - Phase 2: every backslash-newline is removed (line splicing), except
 *   inside raw string literals, where the original characters are kept.
 * - Phase 3: the text is split into preprocessing tokens; comments become
 *   whitespace. Newlines are not tokens: each token records whether it is
 *   the first of its logical line (`lineStart`) and whether whitespace
 *   precedes it (`spaceBefore`).
 *
 * Token positions (`start`, `end`, end exclusive) are offsets into the
 * original text of the source file, so diagnostics point at what the user
 * wrote even across line splices.
 */

var TokenKind = {
  IDENTIFIER: 'identifier',
  NUMBER: 'number',
  CHAR: 'char',
  STRING: 'string',
  PUNCT: 'punct',
  HEADER_NAME: 'header-name',
  OTHER: 'other',
  EOF: 'eof'
};

// Punctuators, longest first within each leading character (C++11 2.13),
// including the alternative tokens (digraphs). Values are canonical
// spellings: `<:` is `[`, `%:` is `#`, and so on.
var PUNCTUATORS = [
  ['%:%:', '##'], ['...', '...'], ['<<=', '<<='], ['>>=', '>>='], ['->*', '->*'],
  ['::', '::'], ['->', '->'], ['++', '++'], ['--', '--'], ['<<', '<<'], ['>>', '>>'],
  ['<=', '<='], ['>=', '>='], ['==', '=='], ['!=', '!='], ['&&', '&&'], ['||', '||'],
  ['+=', '+='], ['-=', '-='], ['*=', '*='], ['/=', '/='], ['%=', '%='], ['&=', '&='],
  ['|=', '|='], ['^=', '^='], ['.*', '.*'], ['##', '##'],
  ['<:', '['], [':>', ']'], ['<%', '{'], ['%>', '}'], ['%:', '#'],
  ['{', '{'], ['}', '}'], ['[', '['], [']', ']'], ['#', '#'], ['(', '('], [')', ')'],
  [';', ';'], [':', ':'], ['?', '?'], ['.', '.'], ['+', '+'], ['-', '-'], ['*', '*'],
  ['/', '/'], ['%', '%'], ['^', '^'], ['&', '&'], ['|', '|'], ['~', '~'], ['!', '!'],
  ['=', '='], ['<', '<'], ['>', '>'], [',', ',']
];

// Encoding prefixes of character and string literals (C++11 2.14.3, 2.14.5).
var STRING_PREFIXES = ['u8R', 'uR', 'UR', 'LR', 'R', 'u8', 'u', 'U', 'L'];
var CHAR_PREFIXES = ['u', 'U', 'L'];

var RAW_DELIMITER_MAX = 16;

function isIdentStart(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch === '$' ||
    ch.charCodeAt(0) > 0x7f;
}

function isIdentPart(ch) {
  return isIdentStart(ch) || (ch >= '0' && ch <= '9');
}

function isDigit(ch) {
  return ch >= '0' && ch <= '9';
}

/**
 * Applies phase 2: removes backslash-newlines and records, for every
 * character of the resulting logical text, its offset in the original text.
 *
 * @param {string} text Original text.
 * @param {number} begin Offset where the text starts (after a BOM).
 * @returns {{text: string, map: Array.<number>}} `map` has one entry more
 *   than `text`, for the end offset.
 */
function spliceLines(text, begin) {
  var out = [];
  var map = [];
  var i = begin;
  var ch;
  while (i < text.length) {
    ch = text.charAt(i);
    if (ch === '\\') {
      if (text.charAt(i + 1) === '\n') {
        i += 2;
        continue;
      }
      if (text.charAt(i + 1) === '\r') {
        i += text.charAt(i + 2) === '\n' ? 3 : 2;
        continue;
      }
    }
    out.push(ch);
    map.push(i);
    i++;
  }
  map.push(text.length);
  return { text: out.join(''), map: map };
}

/**
 * Lexer over one source file.
 *
 * @constructor
 * @param {SourceFile} source File to tokenize.
 * @param {DiagnosticBag} diagnostics Receives lexical errors.
 */
function PPLexer(source, diagnostics) {
  var begin = source.text.charCodeAt(0) === 0xfeff ? 1 : 0;
  var spliced = spliceLines(source.text, begin);
  this.source = source;
  this._diagnostics = diagnostics;
  this._text = spliced.text;
  this._map = spliced.map;
  this._pos = 0;
  this._lineStart = true;
  // When true, lexical errors are not reported: used for skipped groups
  // and for the text of #error/#warning, which need not be valid C++.
  this.quiet = false;
}

/**
 * Reports an error at a range of the logical text.
 *
 * @param {string} message
 * @param {number} start Logical offset.
 * @param {number} end Logical offset.
 * @returns {void}
 */
PPLexer.prototype._error = function (message, start, end) {
  if (this.quiet) {
    return;
  }
  this._diagnostics.error(message, {
    source: this.source,
    start: this._map[start],
    end: this._map[end]
  });
};

/**
 * Skips whitespace and comments.
 *
 * @param {boolean} stopAtNewline Stop before a newline instead of
 *   consuming it (used inside directives).
 * @returns {boolean} Whether anything was skipped.
 */
PPLexer.prototype._skipSpace = function (stopAtNewline) {
  var text = this._text;
  var start = this._pos;
  var ch;
  var end;
  while (this._pos < text.length) {
    ch = text.charAt(this._pos);
    if (ch === '\n' || ch === '\r') {
      if (stopAtNewline) {
        break;
      }
      this._lineStart = true;
      this._pos++;
    } else if (ch === ' ' || ch === '\t' || ch === '\f' || ch === '\v') {
      this._pos++;
    } else if (ch === '/' && text.charAt(this._pos + 1) === '/') {
      while (this._pos < text.length && text.charAt(this._pos) !== '\n' &&
          text.charAt(this._pos) !== '\r') {
        this._pos++;
      }
    } else if (ch === '/' && text.charAt(this._pos + 1) === '*') {
      end = text.indexOf('*/', this._pos + 2);
      if (end === -1) {
        this._error('unterminated /* comment', this._pos, this._pos + 2);
        this._pos = text.length;
      } else {
        // A block comment spanning lines still counts as one space; the
        // token after it is not at the start of a line.
        this._pos = end + 2;
      }
    } else {
      break;
    }
  }
  return this._pos > start;
};

/**
 * Returns whether only whitespace and comments remain before the next
 * newline (or the end of the file).
 *
 * @returns {boolean}
 */
PPLexer.prototype.atEndOfLine = function () {
  var ch;
  this._skipSpace(true);
  ch = this._text.charAt(this._pos);
  return this._pos >= this._text.length || ch === '\n' || ch === '\r';
};

/**
 * Builds a token from logical offsets.
 *
 * @returns {Object}
 */
PPLexer.prototype._make = function (kind, start, end, value, spaceBefore, lineStart) {
  return {
    kind: kind,
    text: this._text.slice(start, end),
    value: value,
    source: this.source,
    start: this._map[start],
    end: this._map[end],
    spaceBefore: spaceBefore,
    lineStart: lineStart,
    hideset: null,
    expansion: null
  };
};

/**
 * Lexes the next token.
 *
 * @param {boolean} [inDirective] When true, the lexer does not cross a
 *   newline: at the end of the line it returns an EOF token and leaves the
 *   newline unread.
 * @returns {Object} A token; `kind` is `eof` at the end of the input (or
 *   of the line, in a directive).
 */
PPLexer.prototype.next = function (inDirective) {
  var space = this._skipSpace(!!inDirective);
  var lineStart = this._lineStart;
  var text = this._text;
  var start = this._pos;
  var ch = text.charAt(start);
  var tok;

  if (start >= text.length || (inDirective && (ch === '\n' || ch === '\r'))) {
    return this._make(TokenKind.EOF, start, start, '', space, lineStart);
  }
  this._lineStart = false;

  tok = this._lexLiteral(start, space, lineStart);
  if (tok) {
    return tok;
  }
  if (isIdentStart(ch)) {
    this._pos = this._scanIdentifier(start);
    return this._make(TokenKind.IDENTIFIER, start, this._pos, text.slice(start, this._pos),
      space, lineStart);
  }
  if (isDigit(ch) || (ch === '.' && isDigit(text.charAt(start + 1)))) {
    this._pos = this._scanNumber(start);
    return this._make(TokenKind.NUMBER, start, this._pos, text.slice(start, this._pos),
      space, lineStart);
  }
  return this._lexPunctuator(start, space, lineStart);
};

/**
 * Lexes a `<...>` header name if one starts at the current position. Used
 * right after `#include` and in `__has_include`.
 *
 * @returns {?Object} The header-name token, or null (nothing consumed).
 */
PPLexer.prototype.nextHeaderName = function () {
  var text = this._text;
  var space = this._skipSpace(true);
  var start = this._pos;
  var end;
  if (text.charAt(start) !== '<') {
    return null;
  }
  end = start + 1;
  while (end < text.length && text.charAt(end) !== '>' && text.charAt(end) !== '\n' &&
      text.charAt(end) !== '\r') {
    end++;
  }
  if (text.charAt(end) !== '>') {
    return null;
  }
  this._pos = end + 1;
  this._lineStart = false;
  return this._make(TokenKind.HEADER_NAME, start, end + 1, text.slice(start + 1, end), space,
    false);
};

/**
 * Skips the rest of the current line (used for skipped groups and for the
 * remainder of erroneous directives).
 *
 * @returns {void}
 */
PPLexer.prototype.skipLine = function () {
  var quiet = this.quiet;
  var tok;
  this.quiet = true;
  do {
    tok = this.next(true);
  } while (tok.kind !== TokenKind.EOF);
  this.quiet = quiet;
};

PPLexer.prototype._scanIdentifier = function (pos) {
  while (pos < this._text.length && isIdentPart(this._text.charAt(pos))) {
    pos++;
  }
  return pos;
};

// pp-number: digit or .digit, then digits, letters, `_`, `.`, and the sign
// after an exponent letter (e, E, p, P).
PPLexer.prototype._scanNumber = function (pos) {
  var text = this._text;
  var ch;
  var prev;
  pos++;
  while (pos < text.length) {
    ch = text.charAt(pos);
    prev = text.charAt(pos - 1);
    if ((ch === '+' || ch === '-') && (prev === 'e' || prev === 'E' || prev === 'p' ||
        prev === 'P')) {
      pos++;
    } else if (isIdentPart(ch) || ch === '.') {
      pos++;
    } else {
      break;
    }
  }
  return pos;
};

/**
 * Lexes a character or string literal (with prefix, raw strings and a
 * user-defined suffix) starting at `start`, or returns null.
 */
PPLexer.prototype._lexLiteral = function (start, space, lineStart) {
  var text = this._text;
  var i;
  var prefix = '';
  var quote;
  var end;
  for (i = 0; i < STRING_PREFIXES.length; i++) {
    if (text.substr(start, STRING_PREFIXES[i].length) === STRING_PREFIXES[i] &&
        text.charAt(start + STRING_PREFIXES[i].length) === '"') {
      prefix = STRING_PREFIXES[i];
      break;
    }
  }
  if (!prefix) {
    for (i = 0; i < CHAR_PREFIXES.length; i++) {
      if (text.charAt(start) === CHAR_PREFIXES[i] && text.charAt(start + 1) === '\'') {
        prefix = CHAR_PREFIXES[i];
        break;
      }
    }
  }
  quote = text.charAt(start + prefix.length);
  if (quote !== '"' && quote !== '\'') {
    return null;
  }
  if (prefix.charAt(prefix.length - 1) === 'R') {
    return this._lexRawString(start, prefix, space, lineStart);
  }
  end = start + prefix.length + 1;
  while (end < text.length && text.charAt(end) !== quote) {
    if (text.charAt(end) === '\n' || text.charAt(end) === '\r') {
      break;
    }
    end += text.charAt(end) === '\\' ? 2 : 1;
  }
  if (text.charAt(end) !== quote) {
    this._error(quote === '"' ? 'missing terminating \'"\' character' :
      'missing terminating \' character', start, Math.min(end, text.length));
    this._pos = Math.min(end, text.length);
    return this._make(TokenKind.OTHER, start, this._pos, text.slice(start, this._pos), space,
      lineStart);
  }
  end++;
  if (end < text.length && isIdentStart(text.charAt(end))) {
    end = this._scanIdentifier(end);
  }
  this._pos = end;
  return this._make(quote === '"' ? TokenKind.STRING : TokenKind.CHAR, start, end,
    text.slice(start, end), space, lineStart);
};

/**
 * Lexes a raw string literal. Line splices inside it are reverted: its
 * spelling is taken from the original text (C++11 2.14.5/2).
 */
PPLexer.prototype._lexRawString = function (start, prefix, space, lineStart) {
  var text = this._text;
  var open = start + prefix.length + 1;
  var paren = text.indexOf('(', open);
  var delimiter;
  var close;
  var end;
  var tok;
  var original;
  if (paren === -1 || paren - open > RAW_DELIMITER_MAX ||
      /[\s()\\]/.test(text.slice(open, paren))) {
    this._error('invalid raw string delimiter', start, Math.min(open + 1, text.length));
    this._pos = open;
    return this._make(TokenKind.OTHER, start, open, text.slice(start, open), space, lineStart);
  }
  delimiter = text.slice(open, paren);
  // The terminator is searched in the original text, where splices are
  // still present; the logical text could join `)` and the delimiter.
  original = this.source.text;
  close = original.indexOf(')' + delimiter + '"', this._map[paren]);
  if (close === -1) {
    this._error('unterminated raw string', start, open);
    this._pos = text.length;
    return this._make(TokenKind.OTHER, start, text.length, text.slice(start), space,
      lineStart);
  }
  end = this._logicalOffset(close + delimiter.length + 2);
  if (end < text.length && isIdentStart(text.charAt(end))) {
    end = this._scanIdentifier(end);
  }
  this._pos = end;
  tok = this._make(TokenKind.STRING, start, end, '', space, lineStart);
  tok.text = original.slice(tok.start, tok.end);
  tok.value = tok.text;
  return tok;
};

/**
 * Converts an original-text offset to the first logical offset at or after
 * it.
 *
 * @param {number} offset
 * @returns {number}
 */
PPLexer.prototype._logicalOffset = function (offset) {
  var low = 0;
  var high = this._map.length - 1;
  var mid;
  while (low < high) {
    mid = (low + high) >> 1;
    if (this._map[mid] < offset) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
};

PPLexer.prototype._lexPunctuator = function (start, space, lineStart) {
  var text = this._text;
  var i;
  var spelling;
  // `<::` is lexed as `<` `::` unless followed by `:` or `>` (C++11 2.5/3).
  if (text.substr(start, 3) === '<::' && text.charAt(start + 3) !== ':' &&
      text.charAt(start + 3) !== '>') {
    this._pos = start + 1;
    return this._make(TokenKind.PUNCT, start, start + 1, '<', space, lineStart);
  }
  for (i = 0; i < PUNCTUATORS.length; i++) {
    spelling = PUNCTUATORS[i][0];
    if (text.substr(start, spelling.length) === spelling) {
      this._pos = start + spelling.length;
      return this._make(TokenKind.PUNCT, start, this._pos, PUNCTUATORS[i][1], space,
        lineStart);
    }
  }
  // A character that cannot start any token (e.g. `@`, a stray backslash).
  this._pos = start + 1;
  return this._make(TokenKind.OTHER, start, start + 1, text.charAt(start), space, lineStart);
};

/**
 * Lexes a whole string into tokens, without a source position context
 * (used to re-lex the result of `##` and the operand of `_Pragma`).
 *
 * @param {SourceFile} source A source file wrapping the text.
 * @param {DiagnosticBag} diagnostics
 * @returns {Array.<Object>} Tokens, without the final EOF.
 */
function tokenizeAll(source, diagnostics) {
  var lexer = new PPLexer(source, diagnostics);
  var out = [];
  var tok = lexer.next();
  while (tok.kind !== TokenKind.EOF) {
    out.push(tok);
    tok = lexer.next();
  }
  return out;
}

module.exports = {
  TokenKind: TokenKind,
  PPLexer: PPLexer,
  tokenizeAll: tokenizeAll
};
