'use strict';

/**
 * Evaluator of `#if` / `#elif` controlling expressions (C++11 16.1).
 *
 * The caller has already replaced `defined` and `__has_include`, and
 * expanded macros. Remaining identifiers evaluate to 0, except `true`
 * (1) and `false` (0). Arithmetic is done in intmax_t / uintmax_t, i.e.
 * 64 bits, with the usual arithmetic conversions: if either operand is
 * unsigned, both are. Errors in an unevaluated operand (`0 && 1 / 0`) are
 * not reported, as in GCC and Clang.
 */

var I = require('../util/int64');
var TokenKind = require('./pp-lexer').TokenKind;
var literals = require('../lexer/literals');

// Binary operators by precedence, lowest first.
var BINARY_LEVELS = [
  ['||'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='], ['<', '>', '<=', '>='], ['<<', '>>'],
  ['+', '-'], ['*', '/', '%']
];

/**
 * Error raised to abort the evaluation after reporting a diagnostic.
 *
 * @constructor
 */
function EvalError() {}

/**
 * Value of a subexpression.
 *
 * @param {Int64} value
 * @param {boolean} unsigned
 * @returns {{value: Int64, unsigned: boolean}}
 */
function makeValue(value, unsigned) {
  return { value: value, unsigned: unsigned };
}

function boolValue(flag) {
  return makeValue(flag ? I.ONE : I.ZERO, false);
}

/**
 * Parser/evaluator over a token list.
 *
 * @constructor
 * @param {Array.<Object>} tokens Expanded tokens of the expression.
 * @param {Object} directive Token of the directive name, for locations.
 * @param {DiagnosticBag} diagnostics
 */
function Evaluator(tokens, directive, diagnostics) {
  this._tokens = tokens;
  this._pos = 0;
  this._directive = directive;
  this._diagnostics = diagnostics;
  // Depth of operands that are not evaluated (right side of a decided
  // `&&`/`||`, untaken branch of `?:`).
  this._unevaluated = 0;
}

Evaluator.prototype._spanOf = function (tok) {
  // Tokens produced by macro expansion are reported at the invocation.
  var origin = tok || this._directive;
  while (origin.expansion) {
    origin = origin.expansion.site;
  }
  return { source: origin.source, start: origin.start, end: origin.end };
};

Evaluator.prototype._fail = function (message, tok) {
  this._diagnostics.error(message, this._spanOf(tok));
  throw new EvalError();
};

Evaluator.prototype._warn = function (message, tok) {
  if (!this._unevaluated) {
    this._diagnostics.warning(message, this._spanOf(tok));
  }
};

Evaluator.prototype._peek = function () {
  return this._tokens[this._pos] || null;
};

Evaluator.prototype._isPunct = function (value) {
  var tok = this._peek();
  return !!tok && tok.kind === TokenKind.PUNCT && tok.value === value;
};

Evaluator.prototype._expect = function (value, opener) {
  var tok = this._peek();
  if (!this._isPunct(value)) {
    if (opener) {
      this._diagnostics.error('expected \'' + value + '\'', this._spanOf(tok ||
        this._tokens[this._tokens.length - 1]))
        .addNote('to match this \'' + opener.value + '\'', this._spanOf(opener));
      throw new EvalError();
    }
    this._fail('expected \'' + value + '\'', tok);
  }
  this._pos++;
};

/**
 * Evaluates the whole expression.
 *
 * @returns {?boolean} The truth value, or null after reporting an error.
 */
Evaluator.prototype.run = function () {
  var result;
  if (!this._tokens.length) {
    this._diagnostics.error('#' + this._directive.text + ' with no expression',
      this._spanOf(this._directive));
    return null;
  }
  try {
    result = this._conditional();
    if (this._pos < this._tokens.length) {
      this._fail('token is not a valid binary operator in a preprocessor subexpression',
        this._peek());
    }
  } catch (err) {
    if (err instanceof EvalError) {
      return null;
    }
    throw err;
  }
  return !I.isZero(result.value);
};

Evaluator.prototype._conditional = function () {
  var condition = this._binary(0);
  var question;
  var taken;
  var whenTrue;
  var whenFalse;
  var unsigned;
  if (!this._isPunct('?')) {
    return condition;
  }
  question = this._peek();
  this._pos++;
  taken = !I.isZero(condition.value);
  if (!taken) {
    this._unevaluated++;
  }
  whenTrue = this._conditional();
  if (!taken) {
    this._unevaluated--;
  }
  this._expect(':', question);
  if (taken) {
    this._unevaluated++;
  }
  whenFalse = this._conditional();
  if (taken) {
    this._unevaluated--;
  }
  unsigned = whenTrue.unsigned || whenFalse.unsigned;
  return makeValue(taken ? whenTrue.value : whenFalse.value, unsigned);
};

Evaluator.prototype._binary = function (level) {
  var left;
  var right;
  var op;
  var opTok;
  var decided;
  if (level >= BINARY_LEVELS.length) {
    return this._unary();
  }
  left = this._binary(level + 1);
  for (;;) {
    opTok = this._peek();
    if (!opTok || opTok.kind !== TokenKind.PUNCT ||
        BINARY_LEVELS[level].indexOf(opTok.value) === -1) {
      return left;
    }
    op = opTok.value;
    this._pos++;
    if (op === '&&' || op === '||') {
      // Short-circuit: the right operand is parsed but not evaluated.
      decided = (op === '&&') === I.isZero(left.value);
      if (decided) {
        this._unevaluated++;
      }
      right = this._binary(level + 1);
      if (decided) {
        this._unevaluated--;
        left = boolValue(op === '||');
      } else {
        left = boolValue(!I.isZero(right.value));
      }
    } else {
      right = this._binary(level + 1);
      left = this._apply(op, left, right, opTok);
    }
  }
};

Evaluator.prototype._apply = function (op, left, right, opTok) {
  var unsigned = left.unsigned || right.unsigned;
  var a = left.value;
  var b = right.value;
  var count;
  switch (op) {
    case '|': return makeValue(I.or(a, b), unsigned);
    case '^': return makeValue(I.xor(a, b), unsigned);
    case '&': return makeValue(I.and(a, b), unsigned);
    case '==': return boolValue(I.eq(a, b));
    case '!=': return boolValue(!I.eq(a, b));
    case '<': return boolValue(unsigned ? I.ltU(a, b) : I.ltS(a, b));
    case '>': return boolValue(unsigned ? I.ltU(b, a) : I.ltS(b, a));
    case '<=': return boolValue(!(unsigned ? I.ltU(b, a) : I.ltS(b, a)));
    case '>=': return boolValue(!(unsigned ? I.ltU(a, b) : I.ltS(a, b)));
    case '+': return makeValue(I.add(a, b), unsigned);
    case '-': return makeValue(I.sub(a, b), unsigned);
    case '*': return makeValue(I.mul(a, b), unsigned);
    case '<<':
    case '>>':
      // The result has the type of the left operand.
      if ((!right.unsigned && I.isNegative(b)) || !I.ltU(b, I.fromNumber(64))) {
        if (!this._unevaluated) {
          this._fail('shift count is negative or too large', opTok);
        }
        return makeValue(I.ZERO, left.unsigned);
      }
      count = b.lo;
      if (op === '<<') {
        return makeValue(I.shl(a, count), left.unsigned);
      }
      return makeValue(left.unsigned ? I.shrU(a, count) : I.shrS(a, count), left.unsigned);
    case '/':
    case '%':
      if (I.isZero(b)) {
        if (!this._unevaluated) {
          this._fail(op === '/' ? 'division by zero in preprocessor expression' :
            'remainder by zero in preprocessor expression', opTok);
        }
        return makeValue(I.ZERO, unsigned);
      }
      if (unsigned) {
        return makeValue(op === '/' ? I.divU(a, b) : I.modU(a, b), true);
      }
      return makeValue(op === '/' ? I.divS(a, b) : I.modS(a, b), false);
  }
  throw new Error('Unhandled operator ' + op);
};

Evaluator.prototype._unary = function () {
  var tok = this._peek();
  var operand;
  if (!tok) {
    this._fail('expected value in expression', this._tokens[this._tokens.length - 1]);
  }
  if (tok.kind === TokenKind.PUNCT) {
    switch (tok.value) {
      case '+':
        this._pos++;
        return this._unary();
      case '-':
        this._pos++;
        operand = this._unary();
        return makeValue(I.neg(operand.value), operand.unsigned);
      case '~':
        this._pos++;
        operand = this._unary();
        return makeValue(I.not(operand.value), operand.unsigned);
      case '!':
        this._pos++;
        return boolValue(I.isZero(this._unary().value));
      case '(':
        this._pos++;
        operand = this._conditional();
        this._expect(')', tok);
        return operand;
    }
  }
  return this._primary();
};

Evaluator.prototype._primary = function () {
  var tok = this._peek();
  this._pos++;
  switch (tok.kind) {
    case TokenKind.NUMBER:
      return this._number(tok);
    case TokenKind.CHAR:
      return this._character(tok);
    case TokenKind.IDENTIFIER:
      return boolValue(tok.value === 'true');
  }
  if (tok.kind === TokenKind.PUNCT && (tok.value === ')' || tok.value === ':')) {
    this._fail('expected value in expression', tok);
  }
  this._fail('token is not valid in preprocessor expressions', tok);
  return null;
};

/**
 * Evaluates an integer literal (C++11 2.14.2), with C++14 binary literals
 * accepted as an extension.
 */
Evaluator.prototype._number = function (tok) {
  var text = tok.text;
  var match = /^(0[xX][0-9a-fA-F]+|0[bB][01]+|[0-9]+)([a-zA-Z_]*)$/.exec(text);
  var digits;
  var radix;
  var suffix;
  var value;
  var unsigned;
  if (!match) {
    if (/^[0-9]*\.|^[0-9]+[eE]|^0[xX].*[pP]/.test(text)) {
      this._fail('floating constant in preprocessor expression', tok);
    }
    this._fail('invalid integer constant \'' + text + '\'', tok);
  }
  digits = match[1];
  suffix = match[2];
  if (!/^(|[uU]|[uU]?(l|L|ll|LL)|(l|L|ll|LL)[uU])$/.test(suffix)) {
    this._fail('invalid suffix \'' + suffix + '\' on integer constant', tok);
  }
  unsigned = /[uU]/.test(suffix);
  if (/^0[xX]/.test(digits)) {
    radix = 16;
    digits = digits.slice(2);
  } else if (/^0[bB]/.test(digits)) {
    radix = 2;
    digits = digits.slice(2);
  } else if (digits.length > 1 && digits.charAt(0) === '0') {
    radix = 8;
    if (/[89]/.test(digits)) {
      this._fail('invalid digit in octal constant', tok);
    }
  } else {
    radix = 10;
  }
  value = I.parse(digits, radix);
  if (value === null) {
    this._fail('integer constant is too large for its type', tok);
  }
  if (!unsigned && I.isNegative(value)) {
    // Too large for intmax_t: the literal becomes unsigned (as in GCC).
    if (radix === 10) {
      this._warn('integer constant is so large that it is unsigned', tok);
    }
    unsigned = true;
  }
  return makeValue(value, unsigned);
};

/**
 * Evaluates a character literal; see `literals.characterValue` for the
 * types of each kind (D-033).
 */
Evaluator.prototype._character = function (tok) {
  var match = /^(u|U|L)?'(.*)'([A-Za-z_]\w*)?$/.exec(tok.text);
  var self = this;
  var failure = null;
  var result;
  if (!match || match[3]) {
    this._fail('token is not valid in preprocessor expressions', tok);
  }
  result = literals.characterValue(match[1] || '', match[2], function (severity, message) {
    if (severity === 'error') {
      failure = failure || message;
    } else {
      self._warn(message, tok);
    }
  });
  if (result === null) {
    this._fail(failure, tok);
  }
  return makeValue(I.fromNumber(result.value), result.unsigned);
};

/**
 * Evaluates a controlling expression.
 *
 * @param {Array.<Object>} tokens Expanded tokens of the expression.
 * @param {Object} directive Token of the directive name (`if`, `elif`).
 * @param {DiagnosticBag} diagnostics
 * @returns {?boolean} The truth value, or null if an error was reported
 *   (the group is then skipped).
 */
function evaluate(tokens, directive, diagnostics) {
  return new Evaluator(tokens, directive, diagnostics).run();
}

module.exports = {
  evaluate: evaluate
};
