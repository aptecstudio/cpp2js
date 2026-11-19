'use strict';

/**
 * Evaluation of integral constant expressions (C++11 5.19), D-047.
 *
 * Works on typed AST nodes. Values are Int64 bit patterns truncated to the
 * width of each node's type (ILP32, D-036), so `(char)300` is 44 and
 * unsigned arithmetic wraps exactly as in C++.
 *
 * `evaluate` returns null when the expression is not a constant
 * expression; `reason` (if given) receives a short explanation.
 */

var I = require('../util/int64');
var T = require('./types');

/**
 * Truncates a value to the width and signedness of an integral (or
 * enumeration / bool) type.
 */
function truncate(value, type) {
  var size;
  var bits;
  var mask;
  var lo;
  if (T.isEnum(type)) {
    type = type.decl.underlyingType;
  }
  if (T.isBool(type)) {
    return I.isZero(value) ? I.ZERO : I.ONE;
  }
  size = T.sizeOf(type);
  if (size === 8) {
    return value;
  }
  bits = size * 8;
  if (bits === 32) {
    lo = value.lo;
    return T.isUnsigned(type) ? new I.Int64(0, lo) : I.fromNumber(lo | 0);
  }
  mask = (1 << bits) - 1;
  lo = value.lo & mask;
  if (!T.isUnsigned(type) && (lo & (1 << (bits - 1)))) {
    lo -= 1 << bits;
  }
  return I.fromNumber(lo);
}

function isUnsignedType(type) {
  if (T.isEnum(type)) {
    type = type.decl.underlyingType;
  }
  return T.isUnsigned(type) || T.isBool(type);
}

/**
 * @constructor
 * @param {Sema} sema
 */
function Evaluator(sema) {
  this.sema = sema;
  this.reason = null;
  this._depth = 0;
}

Evaluator.prototype.fail = function (reason) {
  if (!this.reason) {
    this.reason = reason;
  }
  return null;
};

/**
 * @returns {?Int64}
 */
Evaluator.prototype.evaluate = function (expr) {
  var value;
  if (!expr || !expr.type) {
    return null;
  }
  if (this._depth > 512) {
    return this.fail('expression is too deeply nested');
  }
  this._depth++;
  try {
    value = this._evaluate(expr);
  } finally {
    this._depth--;
  }
  return value;
};

Evaluator.prototype._evaluate = function (expr) {
  var decl;
  var operand;
  switch (expr.kind) {
    case 'IntegerLiteral':
      return truncate(expr.value, expr.type);
    case 'CharLiteral':
      return truncate(I.fromNumber(expr.value), expr.type);
    case 'BoolLiteral':
      return expr.value ? I.ONE : I.ZERO;
    case 'ParenExpr':
      return this.evaluate(expr.expr);
    case 'SizeofExpr':
      return expr.value === null ? this.fail('invalid sizeof') : I.fromNumber(expr.value);
    case 'DeclRefExpr':
      decl = expr.decl;
      if (decl.kind === 'EnumeratorDecl') {
        // Enumerator values are Int64 (D-049).
        return decl.value === null ? this.fail('enumerator value is not known yet') :
          truncate(decl.value, expr.type);
      }
      // A const integral variable initialized with a constant (5.19/2).
      if (decl.kind === 'VarDecl' && !decl.init && decl.previous && decl.previous.init) {
        decl = decl.previous;
      }
      if (decl.kind === 'VarDecl' && (decl.type.isConst || decl.isConstexpr) &&
          (T.isIntegral(decl.type) || T.isEnum(decl.type)) && decl.init) {
        operand = this.evaluate(decl.init.kind === 'InitListExpr' ? decl.init.inits[0] :
          decl.init);
        return operand === null ? null : truncate(operand, decl.type);
      }
      return this.fail('read of non-const variable \'' + decl.name + '\' is not allowed in a ' +
        'constant expression');
    case 'CastExpr':
      return this._cast(expr);
    case 'UnaryExpr':
      return this._unary(expr);
    case 'BinaryExpr':
      return this._binary(expr);
    case 'ConditionalExpr':
      operand = this.evaluate(expr.condition);
      if (operand === null) {
        return null;
      }
      return this.evaluate(I.isZero(operand) ? expr.otherwise : expr.then);
  }
  return this.fail('expression is not an integral constant expression');
};

Evaluator.prototype._cast = function (expr) {
  var operand;
  var from = expr.operand.type;
  if (!(T.isIntegral(expr.type) || T.isEnum(expr.type))) {
    return this.fail('cast to a non-integral type');
  }
  if (expr.operand.kind === 'FloatLiteral' && T.isFloating(from)) {
    // Floating literals may appear as operands of casts to integral types.
    if (T.isBool(expr.type)) {
      return expr.operand.value ? I.ONE : I.ZERO;
    }
    return truncate(I.fromNumber(expr.operand.value < 0 ? Math.ceil(expr.operand.value) :
      Math.floor(expr.operand.value)), expr.type);
  }
  if (!(T.isIntegral(from) || T.isEnum(from))) {
    return this.fail('cast from a non-integral type');
  }
  operand = this.evaluate(expr.operand);
  if (operand === null) {
    return null;
  }
  if (T.isBool(expr.type)) {
    return I.isZero(operand) ? I.ZERO : I.ONE;
  }
  return truncate(operand, expr.type);
};

Evaluator.prototype._unary = function (expr) {
  var v = this.evaluate(expr.operand);
  if (v === null) {
    return null;
  }
  switch (expr.operator) {
    case '+': return truncate(v, expr.type);
    case '-': return truncate(I.neg(v), expr.type);
    case '~': return truncate(I.not(v), expr.type);
    case '!': return I.isZero(v) ? I.ONE : I.ZERO;
  }
  return this.fail('operator \'' + expr.operator + '\' is not allowed in a constant expression');
};

Evaluator.prototype._binary = function (expr) {
  var op = expr.operator;
  var a;
  var b;
  var unsigned;
  var count;
  if (op === '&&' || op === '||') {
    a = this.evaluate(expr.left);
    if (a === null) {
      return null;
    }
    if ((op === '&&') === I.isZero(a)) {
      return op === '||' ? I.ONE : I.ZERO;
    }
    b = this.evaluate(expr.right);
    return b === null ? null : (I.isZero(b) ? I.ZERO : I.ONE);
  }
  if (op === ',' || /=$/.test(op) && op !== '==' && op !== '!=' && op !== '<=' && op !== '>=') {
    return this.fail('operator \'' + op + '\' is not allowed in a constant expression');
  }
  a = this.evaluate(expr.left);
  b = this.evaluate(expr.right);
  if (a === null || b === null) {
    return null;
  }
  // Operands were converted to the common type by semantic analysis.
  unsigned = isUnsignedType(expr.left.type);
  switch (op) {
    case '+': return truncate(I.add(a, b), expr.type);
    case '-': return truncate(I.sub(a, b), expr.type);
    case '*': return truncate(I.mul(a, b), expr.type);
    case '/':
    case '%':
      if (I.isZero(b)) {
        return this.fail('division by zero');
      }
      if (unsigned) {
        return truncate(op === '/' ? I.divU(a, b) : I.modU(a, b), expr.type);
      }
      return truncate(op === '/' ? I.divS(a, b) : I.modS(a, b), expr.type);
    case '<<':
    case '>>':
      if ((!isUnsignedType(expr.right.type) && I.isNegative(b)) ||
          !I.ltU(b, I.fromNumber(T.sizeOf(expr.type) * 8))) {
        return this.fail('shift count is negative or too large');
      }
      count = b.lo;
      if (op === '<<') {
        return truncate(I.shl(a, count), expr.type);
      }
      return truncate(isUnsignedType(expr.left.type) ? I.shrU(a, count) : I.shrS(a, count),
        expr.type);
    case '&': return truncate(I.and(a, b), expr.type);
    case '|': return truncate(I.or(a, b), expr.type);
    case '^': return truncate(I.xor(a, b), expr.type);
    case '==': return I.eq(a, b) ? I.ONE : I.ZERO;
    case '!=': return I.eq(a, b) ? I.ZERO : I.ONE;
    case '<': return (unsigned ? I.ltU(a, b) : I.ltS(a, b)) ? I.ONE : I.ZERO;
    case '>': return (unsigned ? I.ltU(b, a) : I.ltS(b, a)) ? I.ONE : I.ZERO;
    case '<=': return (unsigned ? I.ltU(b, a) : I.ltS(b, a)) ? I.ZERO : I.ONE;
    case '>=': return (unsigned ? I.ltU(a, b) : I.ltS(a, b)) ? I.ZERO : I.ONE;
  }
  return this.fail('operator \'' + op + '\' is not allowed in a constant expression');
};

/**
 * Evaluates an integral constant expression.
 *
 * @param {Sema} sema
 * @param {Object} expr
 * @param {Object} [out] Receives `reason` when the result is null.
 * @returns {?Int64}
 */
function evaluate(sema, expr, out) {
  var evaluator = new Evaluator(sema);
  var value = evaluator.evaluate(expr);
  if (out) {
    out.reason = evaluator.reason;
  }
  return value;
}

module.exports = {
  evaluate: evaluate,
  truncate: truncate
};
