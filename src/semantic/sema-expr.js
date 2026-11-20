'use strict';

/**
 * Semantic analysis of expressions and initialization (extends
 * Sema.prototype), D-047.
 *
 * Every expression gets a type and a value category; operands are
 * converted explicitly with implicit `CastExpr` nodes, so later phases see
 * every conversion. Built-in operators only: overloaded operators come
 * with classes (Phase 5 step 5).
 */

var ast = require('../ast/nodes');
var T = require('./types');
var I = require('../util/int64');
var scopes = require('./scope');
var conv = require('./conversions');
var constant = require('./constant');
var Sema = require('./sema').Sema;

// ---------------------------------------------------------------------------
// Helpers.

Sema.prototype.quote = function (type) {
  return '\'' + T.typeToString(type) + '\'';
};

/** Category word used by Clang in conversion messages. */
function categoryWord(expr) {
  return expr.valueCategory === 'lvalue' ? 'lvalue' : 'rvalue';
}

Sema.prototype.implicitCast = function (expr, castKind, type, valueCategory) {
  return this._expr('CastExpr', expr.range, { castKind: 'implicit', conversion: castKind,
    operand: expr, written: false }, type, valueCategory);
};

/** Replaces a reference to an overload set by the chosen function. */
Sema.prototype.selectOverload = function (expr, decl) {
  var node;
  if (expr.kind === 'UnaryExpr') {
    node = this._unary('&', this.selectOverload(expr.operand, decl),
      this.types.pointer(decl.type), 'prvalue', expr.range);
    return node;
  }
  node = this._expr('DeclRefExpr', expr.range, { decl: decl, qualifier: expr.qualifier },
    decl.type, 'lvalue');
  node.candidates = [decl];
  return node;
};

function isOverloadSet(expr) {
  return (expr.kind === 'DeclRefExpr' || (expr.kind === 'UnaryExpr' && expr.operator === '&')) &&
    ((!!expr.candidates && expr.candidates.length > 1) ||
      (!!expr.templateCandidates && expr.templateCandidates.length > 0));
}

/**
 * Keeps one declaration per function: the most recent redeclaration, which
 * carries the merged default arguments.
 */
function uniqueFunctions(decls) {
  var out = [];
  var seen = [];
  var i;
  var root;
  for (i = decls.length - 1; i >= 0; i--) {
    root = decls[i];
    while (root.previous) {
      root = root.previous;
    }
    if (seen.indexOf(root) === -1) {
      seen.push(root);
      out.unshift(decls[i]);
    }
  }
  return out;
}

/**
 * Applies lvalue-to-rvalue, array-to-pointer and function-to-pointer
 * conversions to an operand of a built-in operator.
 *
 * @returns {?Object} null after an error (overload set used as a value).
 */
Sema.prototype.rvalue = function (expr) {
  var t;
  var i;
  if (!expr) {
    return null;
  }
  if (isOverloadSet(expr)) {
    this.error('reference to overloaded function could not be resolved; did you mean to call ' +
      'it?', expr.range);
    return null;
  }
  t = conv.lvalueTransformation(this, expr);
  for (i = 0; i < t.steps.length; i++) {
    expr = this.implicitCast(expr, t.steps[i].castKind, t.steps[i].type,
      t.steps[i].valueCategory);
  }
  return expr;
};

/** Converts an rvalue of arithmetic type to `type` (no check). */
Sema.prototype._arithmeticCast = function (expr, type) {
  var kind;
  if (expr.type === type) {
    return expr;
  }
  if (T.isBool(type)) {
    kind = T.isFloating(expr.type) ? 'FloatingToBoolean' : 'IntegralToBoolean';
  } else if (T.isFloating(type)) {
    kind = T.isFloating(expr.type) ? 'FloatingCast' : 'IntegralToFloating';
  } else {
    kind = T.isFloating(expr.type) ? 'FloatingToIntegral' : 'IntegralCast';
  }
  return this.implicitCast(expr, kind, type, 'prvalue');
};

/** Integral promotion of an rvalue operand. */
Sema.prototype._promoted = function (expr) {
  return this._arithmeticCast(expr, T.promote(this.types, expr.type));
};

function isArithmeticOrUnscoped(type) {
  return T.isArithmetic(type) || (T.isEnum(type) && !T.isScopedEnum(type));
}

function isIntegralOrUnscoped(type) {
  return T.isIntegral(type) || (T.isEnum(type) && !T.isScopedEnum(type));
}

/**
 * Converts an expression to a type as copy-initialization does, reporting
 * an error in the style of the context.
 *
 * @param {Object} expr
 * @param {Object} type
 * @param {string} context 'variable', 'return', 'parameter', 'assign',
 *   'element'.
 * @returns {?Object} The converted expression, or null after an error.
 */
Sema.prototype.convertTo = function (expr, type, context, listInit) {
  var failure = {};
  var conversion;
  if (!expr) {
    return null;
  }
  conversion = conv.computeConversion(this, expr, type, failure);
  if (!conversion) {
    this._conversionError(expr, type, context, failure.message);
    return null;
  }
  // In list-initialization narrowing is an error, reported instead.
  if (!listInit) {
    this._checkLiteralConversion(expr, type);
  }
  return conv.applyConversion(this, expr, conversion);
};

Sema.prototype._conversionError = function (expr, type, context, detail) {
  var what;
  if (detail) {
    this.error(detail, expr.range);
    return;
  }
  if (isOverloadSet(expr)) {
    this.error('reference to overloaded function could not be resolved; did you mean to call ' +
      'it?', expr.range);
    return;
  }
  if (context === 'assign') {
    this.error('assigning to ' + this.quote(type) + ' from incompatible type ' +
      this.quote(expr.type), expr.range);
    return;
  }
  what = { variable: 'a variable', 'return': 'return object', parameter: 'a parameter',
    element: 'an array element' }[context] || 'a value';
  this.error('cannot initialize ' + what + ' of type ' + this.quote(type) + ' with an ' +
    categoryWord(expr) + ' of type ' + this.quote(expr.type), expr.range);
};

/**
 * Clang's default-on warnings for constants that change value when
 * converted (-Wliteral-conversion, -Wconstant-conversion).
 */
Sema.prototype._checkLiteralConversion = function (expr, type) {
  var target = T.removeReference(type).unqualified;
  var value;
  var truncated;
  if (expr.kind === 'FloatLiteral' && T.isIntegral(target) && !T.isBool(target) &&
      Math.floor(expr.value) !== expr.value) {
    this.warning('implicit conversion from ' + this.quote(expr.type) + ' to ' +
      this.quote(target) + ' changes value from ' + expr.value + ' to ' +
      (expr.value < 0 ? Math.ceil(expr.value) : Math.floor(expr.value)), expr.range);
    return;
  }
  if (T.isIntegral(target) && !T.isBool(target) && T.isIntegral(expr.type) &&
      T.sizeOf(target) < T.sizeOf(expr.type)) {
    value = constant.evaluate(this, expr);
    if (value === null) {
      return;
    }
    truncated = constant.truncate(value, target);
    if (!I.eq(constant.truncate(truncated, expr.type), value)) {
      this.warning('implicit conversion from ' + this.quote(expr.type) + ' to ' +
        this.quote(target) + ' changes value from ' + I.toString(value, !T.isUnsigned(expr.type)) +
        ' to ' + I.toString(truncated, !T.isUnsigned(target)), expr.range);
    }
  }
};

/**
 * Contextual conversion to bool (conditions, `!`, `&&`, `||`, `?:`).
 */
Sema.prototype.contextualBool = function (expr) {
  var operand;
  var t;
  var user;
  if (expr && T.isRecord(expr.type)) {
    // `explicit operator bool()` counts in contextual conversions.
    user = this.userConversion(expr, this.types.builtin('bool'), true);
    if (user) {
      return conv.applyConversion(this, expr, user);
    }
  }
  operand = this.rvalue(expr);
  if (!operand) {
    return null;
  }
  t = operand.type;
  if (T.isBool(t)) {
    return operand;
  }
  if (isArithmeticOrUnscoped(t)) {
    return this.implicitCast(operand, T.isFloating(t) ? 'FloatingToBoolean' :
      'IntegralToBoolean', this.types.builtin('bool'), 'prvalue');
  }
  if (T.isPointer(t) || T.isNullPointer(t)) {
    return this.implicitCast(operand, 'PointerToBoolean', this.types.builtin('bool'),
      'prvalue');
  }
  if (T.isScopedEnum(t)) {
    return this.implicitCast(operand, 'IntegralToBoolean', this.types.builtin('bool'),
      'prvalue');
  }
  this.error('value of type ' + this.quote(t) + ' is not contextually convertible to \'bool\'',
    expr.range);
  return null;
};

/**
 * Whether an expression is a modifiable lvalue; reports why not.
 */
Sema.prototype.checkModifiable = function (expr, range) {
  var decl;
  if (expr.valueCategory !== 'lvalue' || T.isFunction(expr.type)) {
    this.error('expression is not assignable', range || expr.range);
    return false;
  }
  if (T.isArray(expr.type)) {
    this.error('array type ' + this.quote(expr.type) + ' is not assignable', expr.range);
    return false;
  }
  if (expr.type.isConst && expr.kind === 'MemberExpr' && expr.object &&
      expr.object.kind === 'ThisExpr' && !expr.member.type.isConst) {
    this.error('cannot assign to non-static data member within const member function \'' +
      this.currentFunction().name + '\'', expr.range);
    return false;
  }
  if (expr.type.isConst && expr.kind === 'MemberExpr' && !expr.member.type.isConst) {
    decl = rootVariable(expr);
    this.error(decl ? 'cannot assign to variable \'' + decl.name +
      '\' with const-qualified type ' + this.quote(decl.type) :
      'read-only variable is not assignable', expr.range);
    return false;
  }
  if (expr.type.isConst && expr.kind === 'MemberExpr') {
    this.error('cannot assign to non-static data member \'' + expr.member.name +
      '\' with const-qualified type ' + this.quote(expr.member.type), expr.range);
    return false;
  }
  if (expr.type.isConst && expr.kind === 'DeclRefExpr' && expr.capturedByCopy) {
    this.error('cannot assign to a variable captured by copy in a non-mutable lambda',
      expr.range);
    return false;
  }
  if (expr.type.isConst) {
    decl = expr.kind === 'DeclRefExpr' ? expr.decl : null;
    this.error(decl ? 'cannot assign to variable \'' + decl.name +
      '\' with const-qualified type ' + this.quote(decl.type) :
      'read-only variable is not assignable', expr.range);
    return false;
  }
  return true;
};

/** Element type of (nested) arrays. */
function innermost(type) {
  while (T.isArray(type)) {
    type = type.element;
  }
  return type;
}

/** Variable at the root of a chain of `.` member accesses. */
function rootVariable(expr) {
  while (expr.kind === 'MemberExpr' && !expr.isArrow && expr.object) {
    expr = expr.object;
  }
  return expr.kind === 'DeclRefExpr' ? expr.decl : null;
}

// ---------------------------------------------------------------------------
// Constant expressions.

/**
 * Value of an integral constant expression as a JavaScript number, or
 * null if the expression is not constant.
 */
Sema.prototype.evaluateConstant = function (expr) {
  var value = constant.evaluate(this, expr);
  if (value === null) {
    return null;
  }
  return I.toNumber(value, !(T.isUnsigned(expr.type) || T.isBool(expr.type)));
};

/** Like evaluateConstant, returning the Int64 value. */
Sema.prototype.evaluateConstantInt64 = function (expr) {
  return constant.evaluate(this, expr);
};

// ---------------------------------------------------------------------------
// Names.

Sema.prototype.actOnIdExpression = function (name, range, qualifier) {
  var result = qualifier ? scopes.lookupQualified(qualifier, name) :
    scopes.lookupUnqualified(this.scope, name);
  var decl;
  var node;
  var functions;
  var templates;
  if (!result.decls.length) {
    this.error(qualifier ? 'no member named \'' + name + '\' in ' +
      this.describeQualifier(qualifier) : 'use of undeclared identifier \'' + name + '\'',
      range);
    return null;
  }
  if (result.ambiguous) {
    this.error('reference to \'' + name + '\' is ambiguous', range);
    return null;
  }
  decl = result.decls[0];
  if (this.packElements(decl)) {
    // A parameter pack may only be used inside a pack expansion.
    if (this.packIndex(decl) === undefined) {
      this.error('expression contains unexpanded parameter pack \'' + name + '\'', range);
      return null;
    }
    decl = this.packElementDecl(decl);
  }
  if (decl.kind === 'FieldDecl' || result.decls.some(function (d) {
    return (d.kind === 'FunctionDecl' && d.isMethod && !d.isStatic) ||
      (d.kind === 'TemplateDecl' && d.isMember && !d.isStatic && d.templateKind === 'function');
  })) {
    return this.implicitMemberAccess(result.decls, range, qualifier &&
      qualifier.kind === 'RecordDecl' ? qualifier : null);
  }
  if (decl.access && decl.parent && decl.parent.kind === 'RecordDecl' &&
      !this.checkAccess(decl, qualifier && qualifier.kind === 'RecordDecl' ? qualifier :
        decl.parent, range)) {
    return null;
  }
  if ((decl.kind === 'VarDecl' || decl.kind === 'ParamDecl') && decl.ownerFunction &&
      decl.ownerFunction !== this.currentFunction()) {
    return this.captureVariable(decl, range);
  }
  switch (decl.kind) {
    case 'VarDecl':
    case 'ParamDecl':
      node = this._expr('DeclRefExpr', range, { decl: decl }, T.removeReference(decl.type),
        'lvalue');
      break;
    case 'FunctionDecl':
    case 'TemplateDecl':
      if (decl.kind === 'TemplateDecl' && decl.templateKind !== 'function') {
        this.error('\'' + name + '\' does not refer to a value', range);
        return null;
      }
      functions = uniqueFunctions(result.decls.filter(function (d) {
        return d.kind === 'FunctionDecl';
      }));
      templates = result.decls.filter(function (d) {
        return d.kind === 'TemplateDecl' && d.templateKind === 'function';
      });
      node = functions.length ?
        this._expr('DeclRefExpr', range, { decl: functions[0] }, functions[0].type, 'lvalue') :
        this._expr('DeclRefExpr', range, { decl: templates[0] }, this.types.builtin('void'),
          'lvalue');
      node.candidates = functions;
      node.templateCandidates = templates;
      break;
    case 'EnumeratorDecl':
      node = this._expr('DeclRefExpr', range, { decl: decl }, decl.type, 'prvalue');
      break;
    default:
      this.error('\'' + name + '\' does not refer to a value', range);
      return null;
  }
  node.qualifier = qualifier || null;
  return node;
};

// ---------------------------------------------------------------------------
// Unary operators.

Sema.prototype.actOnUnaryOperator = function (op, operand, range) {
  var o;
  var t;
  var overloaded;
  if (!operand) {
    return null;
  }
  if (op !== '&') {
    overloaded = this.tryOverloadedOperator(op, [operand], range);
    if (overloaded !== undefined) {
      return overloaded;
    }
  }
  switch (op) {
    case '&':
      return this._addressOf(operand, range);
    case '*':
      o = this.rvalue(operand);
      if (!o) {
        return null;
      }
      if (!T.isPointer(o.type)) {
        this.error('indirection requires pointer operand (' + this.quote(o.type) +
          ' invalid)', range);
        return null;
      }
      if (T.isVoid(o.type.pointee)) {
        this.error('indirection not permitted on operand of type ' + this.quote(o.type),
          range);
        return null;
      }
      return this._unary(op, o, o.type.pointee, 'lvalue', range);
    case '+':
    case '-':
    case '~':
      o = this.rvalue(operand);
      if (!o) {
        return null;
      }
      t = o.type;
      if ((op === '~' ? isIntegralOrUnscoped(t) : isArithmeticOrUnscoped(t)) ||
          (op === '+' && T.isPointer(t))) {
        if (!T.isPointer(t)) {
          o = this._promoted(o);
        }
        return this._unary(op, o, o.type, 'prvalue', range);
      }
      this.error('invalid argument type ' + this.quote(t) + ' to unary expression', range);
      return null;
    case '!':
      o = this.contextualBool(operand);
      return o ? this._unary(op, o, this.types.builtin('bool'), 'prvalue', range) : null;
    case '++':
    case '--':
      return this._incrementDecrement(op, operand, false, range);
  }
  this.error('unsupported unary operator \'' + op + '\'', range);
  return null;
};

Sema.prototype._unary = function (op, operand, type, category, range) {
  return this._expr('UnaryExpr', range, { operator: op, operand: operand, isPostfix: false },
    type, category);
};

Sema.prototype._addressOf = function (operand, range) {
  var type;
  if (isOverloadSet(operand)) {
    // Resolved later by the target type; keep the set.
    type = this.types.pointer(operand.type);
    operand = this._expr('UnaryExpr', range, { operator: '&', operand: operand,
      isPostfix: false }, type, 'prvalue');
    operand.candidates = operand.operand.candidates;
    return operand;
  }
  if (operand.valueCategory !== 'lvalue') {
    this.error('cannot take the address of an rvalue of type ' + this.quote(operand.type),
      range);
    return null;
  }
  return this._unary('&', operand, this.types.pointer(operand.type), 'prvalue', range);
};

Sema.prototype._incrementDecrement = function (op, operand, postfix, range) {
  var t = operand.type;
  var node;
  if (!(T.isArithmetic(t) || T.isPointer(t)) || (op === '--' && T.isBool(t))) {
    this.error('cannot ' + (op === '++' ? 'increment' : 'decrement') + ' value of type ' +
      this.quote(t), range);
    return null;
  }
  if (T.isPointer(t) && !T.isComplete(t.pointee)) {
    this.error('arithmetic on a pointer to an incomplete type ' + this.quote(t.pointee),
      range);
    return null;
  }
  if (!this.checkModifiable(operand, range)) {
    return null;
  }
  if (T.isBool(t)) {
    this.warning('incrementing expression of type bool is deprecated', range);
  }
  node = this._expr('UnaryExpr', range, { operator: op, operand: operand, isPostfix: postfix },
    postfix ? t.unqualified : t, postfix ? 'prvalue' : 'lvalue');
  return node;
};

Sema.prototype.actOnPostfixIncDec = function (op, operand, range) {
  var overloaded;
  if (!operand) {
    return null;
  }
  // `x++` calls `operator++(int)` with a dummy 0 (13.5.7).
  overloaded = this.tryOverloadedOperator(op, [operand, this._expr('IntegerLiteral', range,
    { value: I.ZERO }, this.types.builtin('int'), 'prvalue')], range);
  if (overloaded !== undefined) {
    return overloaded;
  }
  return this._incrementDecrement(op, operand, true, range);
};

/** `sizeof(type)`, `sizeof expr`, `alignof(type)` (C++11 5.3.3, 5.3.6). */
Sema.prototype.actOnSizeof = function (type, operand, isAlignof, range) {
  var t = type || (operand ? operand.type : null);
  var word = isAlignof ? 'alignof' : 'sizeof';
  var value;
  if (!t) {
    return null;
  }
  t = T.removeReference(t);
  if (T.isFunction(t)) {
    this.error('invalid application of \'' + word + '\' to a function type', range);
    return null;
  }
  if (!T.isComplete(t)) {
    this.error('invalid application of \'' + word + '\' to an incomplete type ' +
      this.quote(t), range);
    return null;
  }
  value = isAlignof ? this.alignOf(t) : T.sizeOf(t);
  return this._expr('SizeofExpr', range, { operand: operand, argumentType: type || null,
    isAlignof: isAlignof, value: value }, this.types.builtin('unsigned int'), 'prvalue');
};

/** Alignment in bytes (ILP32: natural alignment, at most 8). */
Sema.prototype.alignOf = function (type) {
  if (T.isArray(type)) {
    return this.alignOf(type.element);
  }
  if (T.isRecord(type) || T.isEnum(type)) {
    return type.decl.align || T.sizeOf(type) || 1;
  }
  return Math.min(T.sizeOf(type) || 1, 8);
};

// ---------------------------------------------------------------------------
// Binary operators.

var ARITHMETIC_OPS = { '*': true, '/': true, '%': true, '+': true, '-': true };
var SHIFT_OPS = { '<<': true, '>>': true };
var RELATIONAL_OPS = { '<': true, '>': true, '<=': true, '>=': true };
var EQUALITY_OPS = { '==': true, '!=': true };
var BITWISE_OPS = { '&': true, '^': true, '|': true };
var COMPOUND_OPS = { '*=': '*', '/=': '/', '%=': '%', '+=': '+', '-=': '-', '<<=': '<<',
  '>>=': '>>', '&=': '&', '^=': '^', '|=': '|' };

Sema.prototype._binary = function (op, left, right, type, category, range) {
  return this._expr('BinaryExpr', range, { operator: op, left: left, right: right }, type,
    category);
};

Sema.prototype._invalidOperands = function (left, right, range) {
  this.error('invalid operands to binary expression (' + this.quote(left.type) + ' and ' +
    this.quote(right.type) + ')', range);
  return null;
};

/**
 * Applies the usual arithmetic conversions to two rvalue operands.
 *
 * @returns {{left: Object, right: Object, type: Object}}
 */
Sema.prototype._arithmeticOperands = function (left, right) {
  var common = T.usualArithmeticConversions(this.types, left.type, right.type);
  return {
    left: this._arithmeticCast(left, common),
    right: this._arithmeticCast(right, common),
    type: common
  };
};

/**
 * A built-in binary operator.
 *
 * @param {string} op
 * @param {?Object} left
 * @param {?Object} right
 * @param {Object} range Range of the whole expression.
 * @returns {?Object}
 */
Sema.prototype.actOnBinaryOperator = function (op, left, right, range) {
  var overloaded;
  if (!left || !right) {
    return null;
  }
  // `=` on classes goes through assignObject; `,` is never overloaded here.
  if (op !== '=' && op !== ',') {
    overloaded = this.tryOverloadedOperator(op, [left, right], range);
    if (overloaded !== undefined) {
      return overloaded;
    }
  }
  if (op === '=') {
    return this.actOnAssignment(left, right, range);
  }
  if (COMPOUND_OPS[op]) {
    return this._compoundAssignment(op, left, right, range);
  }
  if (op === ',') {
    if (isOverloadSet(right)) {
      return this._invalidOperands(left, right, range);
    }
    return this._binary(',', left, right, right.type, right.valueCategory, range);
  }
  if (op === '&&' || op === '||') {
    left = this.contextualBool(left);
    right = this.contextualBool(right);
    return left && right ? this._binary(op, left, right, this.types.builtin('bool'), 'prvalue',
      range) : null;
  }
  left = this.rvalue(left);
  right = this.rvalue(right);
  if (!left || !right) {
    return null;
  }
  if (ARITHMETIC_OPS[op]) {
    return this._arithmetic(op, left, right, range);
  }
  if (SHIFT_OPS[op]) {
    if (!isIntegralOrUnscoped(left.type) || !isIntegralOrUnscoped(right.type)) {
      return this._invalidOperands(left, right, range);
    }
    left = this._promoted(left);
    right = this._promoted(right);
    return this._binary(op, left, right, left.type, 'prvalue', range);
  }
  if (RELATIONAL_OPS[op] || EQUALITY_OPS[op]) {
    return this._comparison(op, left, right, range);
  }
  if (BITWISE_OPS[op]) {
    if (!isIntegralOrUnscoped(left.type) || !isIntegralOrUnscoped(right.type)) {
      return this._invalidOperands(left, right, range);
    }
    return this._finishArithmetic(op, this._arithmeticOperands(left, right), range);
  }
  this.error('unsupported binary operator \'' + op + '\'', range);
  return null;
};

Sema.prototype._finishArithmetic = function (op, operands, range) {
  return this._binary(op, operands.left, operands.right, operands.type, 'prvalue', range);
};

Sema.prototype._arithmetic = function (op, left, right, range) {
  var lt = left.type;
  var rt = right.type;
  var operands;
  if (isArithmeticOrUnscoped(lt) && isArithmeticOrUnscoped(rt)) {
    if (op === '%' && (!isIntegralOrUnscoped(lt) || !isIntegralOrUnscoped(rt))) {
      return this._invalidOperands(left, right, range);
    }
    operands = this._arithmeticOperands(left, right);
    if ((op === '/' || op === '%') && T.isIntegral(operands.type) &&
        this.evaluateConstant(operands.right) === 0) {
      this.warning((op === '/' ? 'division' : 'remainder') + ' by zero is undefined',
        right.range);
    }
    return this._finishArithmetic(op, operands, range);
  }
  if ((op === '+' || op === '-') && T.isPointer(lt) && isIntegralOrUnscoped(rt)) {
    return this._pointerArithmetic(op, left, right, lt, range);
  }
  if (op === '+' && isIntegralOrUnscoped(lt) && T.isPointer(rt)) {
    return this._pointerArithmetic(op, left, right, rt, range);
  }
  if (op === '-' && T.isPointer(lt) && T.isPointer(rt)) {
    if (lt.pointee.unqualified !== rt.pointee.unqualified) {
      this.error(this.quote(lt) + ' and ' + this.quote(rt) + ' are not pointers to compatible ' +
        'types', range);
      return null;
    }
    // ptrdiff_t is int in ILP32 (D-036).
    return this._binary('-', left, right, this.types.builtin('int'), 'prvalue', range);
  }
  return this._invalidOperands(left, right, range);
};

Sema.prototype._pointerArithmetic = function (op, left, right, pointerType, range) {
  if (!T.isComplete(pointerType.pointee)) {
    this.error('arithmetic on a pointer to an incomplete type ' +
      this.quote(pointerType.pointee), range);
    return null;
  }
  if (T.isPointer(left.type)) {
    right = this._promoted(right);
  } else {
    left = this._promoted(left);
  }
  return this._binary(op, left, right, pointerType, 'prvalue', range);
};

/**
 * Composite pointer type of two pointer (or null) operands (C++11 5/14):
 * the same type, one being `void *`, or one more cv-qualified.
 *
 * @returns {?Object}
 */
Sema.prototype._compositePointerType = function (left, right) {
  var lt = left.type;
  var rt = right.type;
  var lnull = conv.isNullPointerConstant(this, left);
  var rnull = conv.isNullPointerConstant(this, right);
  var a;
  var b;
  if (lnull && rnull) {
    return T.isPointer(lt) ? lt : T.isPointer(rt) ? rt : this.types.builtin('std::nullptr_t');
  }
  if (lnull && T.isPointer(rt)) {
    return rt;
  }
  if (rnull && T.isPointer(lt)) {
    return lt;
  }
  if (!T.isPointer(lt) || !T.isPointer(rt)) {
    return null;
  }
  if (lt === rt) {
    return lt;
  }
  if (conv.isQualificationConvertible(lt, rt)) {
    return rt;
  }
  if (conv.isQualificationConvertible(rt, lt)) {
    return lt;
  }
  a = lt.pointee;
  b = rt.pointee;
  if (T.isVoid(a) || T.isVoid(b)) {
    return this.types.pointer(this.types.qualified(this.types.builtin('void'),
      a.isConst || b.isConst, a.isVolatile || b.isVolatile));
  }
  if (a.unqualified === b.unqualified) {
    return this.types.pointer(this.types.qualified(a.unqualified, a.isConst || b.isConst,
      a.isVolatile || b.isVolatile));
  }
  return null;
};

Sema.prototype._toComposite = function (expr, type) {
  var conversion = conv.computeConversion(this, expr, type);
  return conversion ? conv.applyConversion(this, expr, conversion) : expr;
};

Sema.prototype._comparison = function (op, left, right, range) {
  var lt = left.type;
  var rt = right.type;
  var bool = this.types.builtin('bool');
  var composite;
  var operands;
  if (isArithmeticOrUnscoped(lt) && isArithmeticOrUnscoped(rt)) {
    operands = this._arithmeticOperands(left, right);
    return this._binary(op, operands.left, operands.right, bool, 'prvalue', range);
  }
  if (T.isScopedEnum(lt) && lt === rt) {
    return this._binary(op, left, right, bool, 'prvalue', range);
  }
  if ((T.isPointer(lt) || T.isNullPointer(lt) || T.isPointer(rt) || T.isNullPointer(rt))) {
    if (RELATIONAL_OPS[op] && (T.isNullPointer(lt) || T.isNullPointer(rt))) {
      return this._invalidOperands(left, right, range);
    }
    composite = this._compositePointerType(left, right);
    if (!composite) {
      if (T.isPointer(lt) && T.isPointer(rt)) {
        this.error('comparison of distinct pointer types (' + this.quote(lt) + ' and ' +
          this.quote(rt) + ')', range);
        return null;
      }
      return this._invalidOperands(left, right, range);
    }
    return this._binary(op, this._toComposite(left, composite),
      this._toComposite(right, composite), bool, 'prvalue', range);
  }
  return this._invalidOperands(left, right, range);
};

/** `a = b` for scalar types. */
Sema.prototype.actOnAssignment = function (left, right, range) {
  var converted;
  if (!left || !right) {
    return null;
  }
  if (T.isRecord(left.type)) {
    if (left.valueCategory !== 'lvalue') {
      this.error('expression is not assignable', range);
      return null;
    }
    return this.assignObject(left, right, range);
  }
  if (!this.checkModifiable(left, range)) {
    return null;
  }
  converted = right.kind === 'InitListExpr' ?
    this._scalarListInit(right, left.type.unqualified) :
    this.convertTo(right, left.type.unqualified, 'assign');
  if (!converted) {
    return null;
  }
  return this._binary('=', left, converted, left.type, 'lvalue', range);
};

Sema.prototype._compoundAssignment = function (op, left, right, range) {
  var base = COMPOUND_OPS[op];
  var lt = left.type;
  var r;
  var computation;
  var node;
  if (!this.checkModifiable(left, range)) {
    return null;
  }
  r = this.rvalue(right);
  if (!r) {
    return null;
  }
  if (T.isPointer(lt) && (base === '+' || base === '-') && isIntegralOrUnscoped(r.type)) {
    r = this._promoted(r);
    computation = lt;
  } else if (isArithmeticOrUnscoped(lt) && isArithmeticOrUnscoped(r.type) &&
      (ARITHMETIC_OPS[base] ? (base !== '%' || (isIntegralOrUnscoped(lt) &&
        isIntegralOrUnscoped(r.type))) : (isIntegralOrUnscoped(lt) &&
        isIntegralOrUnscoped(r.type)))) {
    computation = SHIFT_OPS[base] ? T.promote(this.types, lt.unqualified) :
      T.usualArithmeticConversions(this.types, lt, r.type);
    r = SHIFT_OPS[base] ? this._promoted(r) : this._arithmeticCast(r, computation);
  } else {
    return this._invalidOperands(left, r, range);
  }
  node = this._binary(op, left, r, lt, 'lvalue', range);
  node.computationType = computation;
  return node;
};

// ---------------------------------------------------------------------------
// Conditional operator (C++11 5.16, built-in cases).

Sema.prototype.actOnConditional = function (condition, then, otherwise, range) {
  var c = condition ? this.contextualBool(condition) : null;
  var lt;
  var rt;
  var composite;
  var operands;
  if (!c || !then || !otherwise) {
    return null;
  }
  lt = then.type;
  rt = otherwise.type;
  if (T.isVoid(lt) || T.isVoid(rt)) {
    if (!(T.isVoid(lt) && T.isVoid(rt))) {
      this.error('right operand to ? is void, but left operand is of type ' +
        this.quote(T.isVoid(lt) ? rt : lt), range);
      return null;
    }
    return this._conditional(c, then, otherwise, lt, 'prvalue', range);
  }
  // Two glvalues of the same type and category keep it.
  if (lt === rt && then.valueCategory === otherwise.valueCategory &&
      then.valueCategory !== 'prvalue') {
    return this._conditional(c, then, otherwise, lt, then.valueCategory, range);
  }
  then = this.rvalue(then);
  otherwise = this.rvalue(otherwise);
  if (!then || !otherwise) {
    return null;
  }
  lt = then.type;
  rt = otherwise.type;
  if (lt === rt) {
    return this._conditional(c, then, otherwise, lt, 'prvalue', range);
  }
  if (isArithmeticOrUnscoped(lt) && isArithmeticOrUnscoped(rt)) {
    operands = this._arithmeticOperands(then, otherwise);
    return this._conditional(c, operands.left, operands.right, operands.type, 'prvalue', range);
  }
  composite = this._compositePointerType(then, otherwise);
  if (composite) {
    return this._conditional(c, this._toComposite(then, composite),
      this._toComposite(otherwise, composite), composite, 'prvalue', range);
  }
  this.error('incompatible operand types (' + this.quote(lt) + ' and ' + this.quote(rt) + ')',
    range);
  return null;
};

Sema.prototype._conditional = function (c, then, otherwise, type, category, range) {
  return this._expr('ConditionalExpr', range, { condition: c, then: then,
    otherwise: otherwise }, type, category);
};

// ---------------------------------------------------------------------------
// Postfix: subscript and calls.

Sema.prototype.actOnSubscript = function (base, index, range) {
  var b;
  var i;
  var tmp;
  var overloaded;
  if (!base || !index) {
    return null;
  }
  overloaded = this.tryOverloadedOperator('[]', [base, index], range);
  if (overloaded !== undefined) {
    return overloaded;
  }
  b = this.rvalue(base);
  i = this.rvalue(index);
  if (!b || !i) {
    return null;
  }
  // `2[a]` is valid: either operand may be the pointer.
  if (!T.isPointer(b.type) && T.isPointer(i.type)) {
    tmp = b;
    b = i;
    i = tmp;
  }
  if (!T.isPointer(b.type)) {
    this.error('subscripted value is not an array, pointer, or vector', base.range);
    return null;
  }
  if (!isIntegralOrUnscoped(i.type)) {
    this.error('array subscript is not an integer', index.range);
    return null;
  }
  if (!T.isComplete(b.type.pointee)) {
    this.error('subscript of pointer to incomplete type ' + this.quote(b.type.pointee),
      range);
    return null;
  }
  return this._expr('SubscriptExpr', range, { base: b, index: this._promoted(i) },
    b.type.pointee, 'lvalue');
};

/** Type of a call expression: references removed, prvalues unqualified. */
function resultType(type) {
  if (T.isReference(type)) {
    return type.referee;
  }
  return T.isRecord(type) ? type : type.unqualified;
}

/** Value category of the result of a call returning `type`. */
function callCategory(type) {
  if (type.kind === T.TypeKind.LVALUE_REF) {
    return 'lvalue';
  }
  return type.kind === T.TypeKind.RVALUE_REF ? 'xvalue' : 'prvalue';
}

/**
 * A function call (C++11 5.2.2).
 *
 * @param {Object} callee
 * @param {Array.<Object>} args
 * @param {Object} range
 * @returns {?Object}
 */
Sema.prototype.actOnCall = function (callee, args, range) {
  var fnType;
  var target = null;
  var converted;
  var calleeExpr;
  var failures = [];
  var i;
  if (!callee || args.indexOf(null) !== -1) {
    return null;
  }
  if (callee.kind === 'MemberExpr' && callee.candidates) {
    return this.actOnMemberCall(callee, args, range);
  }
  if (T.isRecord(T.removeReference(callee.type))) {
    // A function object: `f(args)` calls `f.operator()(args)`.
    target = this.tryOverloadedOperator('()', [callee].concat(args), range);
    if (target === undefined) {
      this.error('type ' + this.quote(callee.type) + ' does not provide a call operator',
        callee.range);
      return null;
    }
    return target;
  }
  if (callee.kind === 'DeclRefExpr' && callee.candidates) {
    target = this.resolveOverload(this._withTemplateCandidates(callee, args, failures), args,
      range, callee.decl.name, failures);
    if (!target) {
      return null;
    }
    calleeExpr = this.rvalue(this.selectOverload(callee, target.decl));
    fnType = target.decl.type;
    converted = target.args;
  } else {
    calleeExpr = this.rvalue(callee);
    if (!calleeExpr) {
      return null;
    }
    fnType = T.isPointer(calleeExpr.type) ? calleeExpr.type.pointee : calleeExpr.type;
    if (!T.isFunction(fnType)) {
      this.error('called object type ' + this.quote(calleeExpr.type) + ' is not a function or ' +
        'function pointer', callee.range);
      return null;
    }
    converted = this._convertArguments(fnType, null, args, range);
    if (!converted) {
      return null;
    }
  }
  for (i = 0; i < converted.length; i++) {
    if (!converted[i]) {
      return null;
    }
  }
  return this._expr('CallExpr', range, { callee: calleeExpr, args: converted,
    'function': target ? target.decl : null }, resultType(fnType.returnType),
    callCategory(fnType.returnType));
};

/**
 * Adds the specializations of the function templates named by a callee:
 * arguments are deduced from the call (or given explicitly), then the
 * declaration is instantiated; deduction and substitution failures
 * remove the template silently (SFINAE) and are kept for the notes.
 */
Sema.prototype._withTemplateCandidates = function (callee, args, failures) {
  var templates = callee.templateCandidates || [];
  var explicit = callee.explicitTemplateArgs || null;
  // Explicit template arguments exclude non-template functions.
  var all = explicit ? [] : callee.candidates.slice();
  var self = this;
  templates.forEach(function (tmpl) {
    var deduction = self.deduceFromCall(tmpl, explicit || [], args);
    var specialization;
    if (!deduction.args) {
      failures.push({ decl: tmpl, reason: deduction.reason });
      return;
    }
    specialization = self.parser.instantiateFunctionTemplate(tmpl, deduction.args, true);
    if (!specialization) {
      failures.push({ decl: tmpl, reason: 'substitution failure' });
      return;
    }
    specialization.fromTemplate = tmpl;
    if (all.indexOf(specialization) === -1) {
      all.push(specialization);
    }
  });
  return all;
};

/**
 * Converts the arguments of a call to a known function type, with Clang's
 * messages for a single (non-overloaded) callee.
 *
 * @param {Object} fnType
 * @param {?Object} decl Function declaration (for default arguments).
 * @param {Array.<Object>} args
 * @returns {?Array.<Object>}
 */
Sema.prototype._convertArguments = function (fnType, decl, args, range) {
  var params = fnType.params;
  var required = params.length;
  var out = [];
  var diag;
  var expected;
  var i;
  if (decl) {
    while (required > 0 && decl.params[required - 1].defaultArg) {
      required--;
    }
  }
  if (args.length < required || (args.length > params.length && !fnType.variadic)) {
    if (args.length < required) {
      expected = required !== params.length || fnType.variadic ? 'at least ' + required :
        String(required);
    } else {
      expected = required !== params.length ? 'at most ' + params.length :
        String(params.length);
    }
    diag = this.error('too ' + (args.length < required ? 'few' : 'many') + ' arguments to ' +
      'function call, expected ' + expected + ', have ' + args.length, range);
    if (decl) {
      this.note(diag, '\'' + decl.name + '\' declared here', decl.range);
    }
    return null;
  }
  for (i = 0; i < args.length; i++) {
    out.push(i < params.length ? this.convertTo(args[i], params[i], 'parameter') :
      this.defaultArgumentPromotion(args[i]));
  }
  for (i = args.length; i < params.length; i++) {
    out.push(this._expr('DefaultArgExpr', range, { param: decl.params[i] }, params[i],
      'prvalue'));
  }
  return out;
};

/**
 * Default argument promotions for arguments matching `...` (C++11 5.2.2/7).
 */
Sema.prototype.defaultArgumentPromotion = function (arg) {
  var r = this.rvalue(arg);
  if (!r) {
    return null;
  }
  if (r.type.name === 'float') {
    return this._arithmeticCast(r, this.types.builtin('double'));
  }
  if (isIntegralOrUnscoped(r.type)) {
    return this._promoted(r);
  }
  if (T.isVoid(r.type)) {
    this.error('argument type \'void\' is incomplete', arg.range);
    return null;
  }
  return r;
};

// ---------------------------------------------------------------------------
// Casts.

/**
 * An explicit cast: `static_cast`, `const_cast`, `reinterpret_cast`,
 * C-style `(T)e` and functional `T(e)` (C++11 5.2.9-5.2.11, 5.4).
 *
 * @param {string} kind 'static', 'const', 'reinterpret', 'dynamic',
 *   'c-style', 'functional'.
 */
Sema.prototype.actOnCast = function (kind, type, operand, range) {
  var conversion;
  if (!operand) {
    return null;
  }
  if (kind === 'dynamic') {
    this.error('dynamic_cast is not supported yet', range);
    return null;
  }
  if (kind === 'functional' && T.isRecord(type)) {
    return this.construct(type.unqualified, [operand], 'direct', range);
  }
  if (kind === 'c-style' || kind === 'functional') {
    conversion = this._castConversion('const', type, operand) ||
      this._castConversion('static', type, operand) ||
      this._castConversion('reinterpret', type, operand, true) ||
      this._castConversion('static', type, operand, true);
  } else {
    conversion = this._castConversion(kind, type, operand);
  }
  if (!conversion) {
    this._castError(kind, type, operand, range);
    return null;
  }
  return this._expr('CastExpr', range, { castKind: kind, conversion: conversion.kind,
    operand: conversion.operand, written: true }, T.removeReference(type),
    callCategory(type));
};

Sema.prototype._castError = function (kind, type, operand, range) {
  var names = { 'static': 'static_cast', 'const': 'const_cast',
    'reinterpret': 'reinterpret_cast', 'c-style': 'C-style cast',
    'functional': 'functional-style cast' };
  if ((kind === 'static' || kind === 'reinterpret') && this._castsAwayConst(operand.type,
      type)) {
    this.error(names[kind] + ' from ' + this.quote(operand.type) + ' to ' + this.quote(type) +
      ' casts away qualifiers', range);
    return;
  }
  this.error(names[kind] + ' from ' + this.quote(operand.type) + ' to ' + this.quote(type) +
    ' is not allowed', range);
};

/** Whether converting between pointer types would drop cv-qualifiers. */
Sema.prototype._castsAwayConst = function (from, to) {
  var a = conv.lvalueTransformation(this, { type: from, valueCategory: 'prvalue' }).type;
  var b = T.removeReference(to);
  while (T.isPointer(a) && T.isPointer(b)) {
    a = a.pointee;
    b = b.pointee;
    if ((a.isConst && !b.isConst) || (a.isVolatile && !b.isVolatile)) {
      return true;
    }
  }
  return false;
};

/**
 * Tries one cast kind.
 *
 * @param {boolean} [ignoreConst] Allow casting away cv-qualifiers (the
 *   const_cast part of a C-style cast).
 * @returns {?{kind: string, operand: Object}} The conversion and the
 *   (possibly lvalue-converted) operand.
 */
Sema.prototype._castConversion = function (kind, type, operand, ignoreConst) {
  var target = T.removeReference(type);
  var isRef = T.isReference(type);
  var o;
  var from;
  var to;
  var implicit;
  if (kind === 'const') {
    return this._constCast(type, operand);
  }
  if (T.isVoid(type)) {
    return kind === 'static' ? { kind: 'ToVoid', operand: operand } : null;
  }
  if (isRef) {
    // Reference casts reinterpret (or, for static_cast, bind) an lvalue.
    if (operand.valueCategory === 'prvalue' && type.kind === T.TypeKind.LVALUE_REF) {
      return null;
    }
    if (kind === 'static') {
      if (T.isRecord(operand.type) && T.isRecord(target) &&
          this.isDerivedFrom(target.decl, operand.type.decl) &&
          operand.valueCategory === 'lvalue' && (ignoreConst || target.isConst ||
            !operand.type.isConst)) {
        return { kind: 'BaseToDerived', operand: operand };
      }
      if (operand.type.unqualified === target.unqualified &&
          (ignoreConst || (target.isConst || !operand.type.isConst))) {
        return { kind: 'NoOp', operand: operand };
      }
      implicit = conv.computeConversion(this, operand, type);
      return implicit ? { kind: 'NoOp', operand: conv.applyConversion(this, operand, implicit) } :
        null;
    }
    if (kind === 'reinterpret' && (ignoreConst || !(operand.type.isConst && !target.isConst))) {
      return { kind: 'LValueBitCast', operand: operand };
    }
    return null;
  }
  if (kind === 'static') {
    implicit = conv.computeConversion(this, operand, target);
    if (implicit) {
      return { kind: 'NoOp', operand: conv.applyConversion(this, operand, implicit) };
    }
  }
  o = this.rvalue(operand);
  if (!o) {
    return null;
  }
  from = o.type;
  to = target.unqualified;
  if (kind === 'static') {
    // Inverses of standard conversions (5.2.9/7-11).
    if ((T.isArithmetic(from) || T.isEnum(from)) && (T.isArithmetic(to) || T.isEnum(to))) {
      return { kind: arithmeticKind(from, to), operand: o };
    }
    if (T.isPointer(from) && T.isPointer(to) && T.isVoid(from.pointee) &&
        T.isObject(to.pointee) && (ignoreConst || !this._castsAwayConst(from, to))) {
      return { kind: 'BitCast', operand: o };
    }
    // Downcast from a base to a derived class (5.2.9/11).
    if (T.isPointer(from) && T.isPointer(to) && T.isRecord(from.pointee) &&
        T.isRecord(to.pointee) && this.isDerivedFrom(to.pointee.decl, from.pointee.decl) &&
        (ignoreConst || !this._castsAwayConst(from, to))) {
      return { kind: 'BaseToDerived', operand: o };
    }
    if (ignoreConst && T.isPointer(from) && T.isPointer(to) &&
        from.pointee.unqualified === to.pointee.unqualified) {
      return { kind: 'NoOp', operand: o };
    }
    return null;
  }
  // reinterpret_cast (5.2.10).
  if (from === to && !T.isRecord(from)) {
    return { kind: 'NoOp', operand: o };
  }
  if (T.isPointer(from) && T.isPointer(to)) {
    if (!ignoreConst && this._castsAwayConst(from, to)) {
      return null;
    }
    return { kind: 'BitCast', operand: o };
  }
  if (T.isPointer(from) && T.isIntegral(to) && T.sizeOf(to) >= T.POINTER_SIZE) {
    return { kind: 'PointerToIntegral', operand: o };
  }
  if ((T.isIntegral(from) || T.isEnum(from)) && T.isPointer(to)) {
    return { kind: 'IntegralToPointer', operand: o };
  }
  if (T.isNullPointer(from) && T.isIntegral(to) && T.sizeOf(to) >= T.POINTER_SIZE) {
    return { kind: 'PointerToIntegral', operand: o };
  }
  return null;
};

function arithmeticKind(from, to) {
  if (T.isBool(to)) {
    return T.isFloating(from) ? 'FloatingToBoolean' : 'IntegralToBoolean';
  }
  if (T.isFloating(to)) {
    return T.isFloating(from) ? 'FloatingCast' : 'IntegralToFloating';
  }
  return T.isFloating(from) ? 'FloatingToIntegral' : 'IntegralCast';
}

/** `const_cast` (5.2.11): types that differ only in cv-qualification. */
Sema.prototype._constCast = function (type, operand) {
  var target = T.removeReference(type);
  var from;
  var a;
  var b;
  if (T.isReference(type)) {
    if (type.kind === T.TypeKind.LVALUE_REF && operand.valueCategory !== 'lvalue') {
      return null;
    }
    return operand.type.unqualified === target.unqualified ? { kind: 'NoOp', operand: operand } :
      null;
  }
  if (!T.isPointer(target)) {
    return null;
  }
  from = this.rvalue(operand);
  if (!from || !T.isPointer(from.type)) {
    return null;
  }
  a = from.type;
  b = target;
  while (T.isPointer(a) && T.isPointer(b)) {
    a = a.pointee.unqualified;
    b = b.pointee.unqualified;
  }
  return a === b ? { kind: 'NoOp', operand: from } : null;
};

/**
 * `T()` and `T{}`: a value-initialized prvalue of a scalar type.
 */
Sema.prototype.actOnValueInit = function (type, range) {
  if (T.isRecord(type)) {
    return this.construct(type.unqualified, [], 'direct', range);
  }
  if (T.isVoid(type)) {
    return this._expr('InitListExpr', range, { inits: [] }, type, 'prvalue');
  }
  if (!T.isScalar(type)) {
    this.error('value initialization of type ' + this.quote(type) + ' is not supported yet',
      range);
    return null;
  }
  return this._expr('InitListExpr', range, { inits: [] }, type, 'prvalue');
};

// ---------------------------------------------------------------------------
// new and delete (built-in types; classes come in step 5).

Sema.prototype.actOnNew = function (allocated, arraySize, args, style, range) {
  var size = null;
  var init = null;
  var element = allocated;
  var type;
  if (T.isReference(allocated) || T.isFunction(allocated) || T.isVoid(allocated)) {
    this.error('cannot allocate ' + (T.isVoid(allocated) ? 'incomplete type \'void\'' :
      (T.isReference(allocated) ? 'reference' : 'function') + ' type ' +
      this.quote(allocated)) + ' with new', range);
    return null;
  }
  if (arraySize) {
    size = this.rvalue(arraySize);
    if (!size) {
      return null;
    }
    if (!isIntegralOrUnscoped(size.type)) {
      this.error('array size expression must have integral or unscoped enumeration type, ' +
        'not ' + this.quote(size.type), arraySize.range);
      return null;
    }
    size = this._promoted(size);
    type = this.types.pointer(allocated);
  } else if (T.isArray(allocated)) {
    element = allocated.element;
    size = null;
    type = this.types.pointer(element);
  } else {
    type = this.types.pointer(allocated);
  }
  if (!T.isComplete(element)) {
    this.error('allocation of incomplete type ' + this.quote(element), range);
    return null;
  }
  if (T.isRecord(element)) {
    if ((arraySize || T.isArray(allocated)) && args && args.length) {
      this.error('array \'new\' cannot have initialization arguments', range);
      return null;
    }
    init = this.construct(element.unqualified, args || [], args ? (style === 'list' ?
      'list' : 'direct') : 'default', range);
    if (!init) {
      return null;
    }
    return this._expr('NewExpr', range, { allocatedType: allocated, arraySize: size,
      args: [init], initStyle: style }, type, 'prvalue');
  }
  if (args && args.length) {
    if (arraySize || T.isArray(allocated)) {
      if (style !== 'list') {
        this.error('array \'new\' cannot have initialization arguments', range);
        return null;
      }
    } else if (args.length > 1) {
      this.error('excess elements in scalar initializer', args[1].range);
      return null;
    } else {
      init = this.convertTo(args[0], element.unqualified, 'variable');
      if (!init) {
        return null;
      }
      args = [init];
    }
  }
  return this._expr('NewExpr', range, { allocatedType: allocated, arraySize: size,
    args: args || [], initStyle: style }, type, 'prvalue');
};

Sema.prototype.actOnDelete = function (operand, isArray, range) {
  var o = this.rvalue(operand);
  if (!o) {
    return null;
  }
  if (!T.isPointer(o.type)) {
    this.error('cannot delete expression of type ' + this.quote(o.type), range);
    return null;
  }
  if (T.isVoid(o.type.pointee)) {
    this.warning('cannot delete expression with pointer-to-\'void\' type ' + this.quote(o.type),
      range);
  }
  return this._expr('DeleteExpr', range, { operand: o, isArray: isArray },
    this.types.builtin('void'), 'prvalue');
};

// ---------------------------------------------------------------------------
// Initialization (C++11 8.5) of variables, parameters and return values.

/**
 * Converts the initializer of an object of type `type`.
 *
 * @param {Object} type Type of the object being initialized.
 * @param {Object} init Initializer expression or InitListExpr.
 * @param {string} style 'copy', 'direct' or 'list'.
 * @param {string} context As in `convertTo`.
 * @returns {?{init: Object, type: Object}} `type` may complete an array of
 *   unknown bound.
 */
Sema.prototype.initialize = function (type, init, style, context) {
  var args;
  if (T.isArray(type)) {
    return this._arrayInit(type, init);
  }
  if (T.isRecord(type)) {
    // Class objects are built by constructors (or aggregate rules).
    if (init.kind === 'InitListExpr') {
      return wrap(this.construct(type.unqualified, init.inits, style === 'direct' ? 'direct' :
        style === 'list' ? 'list' : 'copy-list', init.range), type);
    }
    return wrap(this.construct(type.unqualified, [init], 'copy', init.range), type);
  }
  if (init.kind === 'InitListExpr' && style !== 'direct') {
    return wrap(this._scalarListInit(init, type), type);
  }
  if (init.kind === 'InitListExpr') {
    // Direct initialization `T x(a, b)` keeps its argument list.
    args = init.inits;
    if (args.length !== 1) {
      this.error(args.length ? 'excess elements in scalar initializer' :
        'expected expression', args.length ? args[1].range : init.range);
      return null;
    }
    return wrap(this.convertTo(args[0], type, context), type);
  }
  return wrap(this.convertTo(init, type, context), type);
};

function wrap(expr, type) {
  return expr ? { init: expr, type: type } : null;
}

/**
 * `T x{e}` / `T x = {e}` for a scalar or reference: at most one element,
 * and no narrowing conversion (C++11 8.5.4/3, /7).
 */
Sema.prototype._scalarListInit = function (list, type) {
  var element;
  var converted;
  if (list.inits.length > 1) {
    this.error('excess elements in scalar initializer', list.inits[1].range);
    return null;
  }
  if (!list.inits.length) {
    if (T.isReference(type)) {
      this.error('initializer list cannot be used to initialize a reference', list.range);
      return null;
    }
    return this.actOnValueInit(type, list.range);
  }
  element = list.inits[0];
  if (element.kind === 'InitListExpr') {
    this.error('too many braces around scalar initializer', element.range);
    return null;
  }
  converted = this.convertTo(element, type, 'variable', !T.isReference(type));
  if (converted && !T.isReference(type)) {
    this._checkNarrowing(element, type);
  }
  return converted;
};

/**
 * Narrowing conversions are errors in list-initialization (8.5.4/7):
 * floating to integral, double to float (unless constant and fits),
 * integral to floating (unless constant and exact), integral to a type
 * that cannot represent all values (unless constant and fits).
 */
Sema.prototype._checkNarrowing = function (expr, type) {
  var from = expr.type.unqualified;
  var to = T.removeReference(type).unqualified;
  var value = null;
  var narrowing = false;
  var fromSigned;
  var toSigned;
  if (T.isEnum(from) && !T.isScopedEnum(from)) {
    from = from.decl.underlyingType;
  }
  if (T.isFloating(from) && T.isIntegral(to)) {
    narrowing = true;
  } else if (T.isFloating(from) && T.isFloating(to) && T.sizeOf(to) < T.sizeOf(from)) {
    narrowing = expr.kind !== 'FloatLiteral';
  } else if (T.isIntegral(from) && T.isFloating(to)) {
    narrowing = constant.evaluate(this, expr) === null;
  } else if (T.isIntegral(from) && T.isIntegral(to) && !T.isBool(to) && from !== to) {
    fromSigned = !T.isUnsigned(from) && !T.isBool(from);
    toSigned = !T.isUnsigned(to);
    // Whether `to` can represent every value of `from`.
    if (!((fromSigned === toSigned && T.sizeOf(to) >= T.sizeOf(from)) ||
        (!fromSigned && toSigned && T.sizeOf(to) > T.sizeOf(from)))) {
      value = constant.evaluate(this, expr);
      if (value === null) {
        narrowing = true;
      } else if (I.toString(value, fromSigned) !==
          I.toString(constant.truncate(value, to), toSigned)) {
        this.error('constant expression evaluates to ' + I.toString(value, fromSigned) +
          ' which cannot be narrowed to type ' + this.quote(to), expr.range);
        return;
      }
    }
  }
  if (narrowing) {
    this.error(constant.evaluate(this, expr) !== null || expr.kind === 'FloatLiteral' ?
      'type ' + this.quote(expr.type) + ' cannot be narrowed to ' + this.quote(to) +
      ' in initializer list' : 'non-constant-expression cannot be narrowed from type ' +
      this.quote(expr.type) + ' to ' + this.quote(to) + ' in initializer list', expr.range);
  }
};

/** Aggregate initialization of arrays, and char arrays from strings. */
Sema.prototype._arrayInit = function (type, init) {
  var element = type.element;
  var inits;
  var out = [];
  var converted;
  var length;
  var i;
  var list;
  if (init.kind === 'StringLiteral' || (init.kind === 'InitListExpr' &&
      init.inits.length === 1 && init.inits[0].kind === 'StringLiteral' &&
      isCharType(element))) {
    return this._stringArrayInit(type, init.kind === 'StringLiteral' ? init : init.inits[0]);
  }
  if (init.kind !== 'InitListExpr') {
    this.error('array initializer must be an initializer list', init.range);
    return null;
  }
  inits = init.inits;
  if (type.size !== null && inits.length > type.size) {
    this.error('excess elements in array initializer', inits[type.size].range);
    return null;
  }
  for (i = 0; i < inits.length; i++) {
    if (T.isArray(element)) {
      converted = this._arrayInit(element, inits[i]);
      converted = converted ? converted.init : null;
    } else {
      converted = inits[i].kind === 'InitListExpr' ? this._scalarListInit(inits[i], element) :
        this.convertTo(inits[i], element, 'element', true);
      if (converted && inits[i].kind !== 'InitListExpr') {
        this._checkNarrowing(inits[i], element);
      }
    }
    if (!converted) {
      return null;
    }
    out.push(converted);
  }
  length = type.size === null ? inits.length : type.size;
  if (length === 0) {
    this.error('zero size arrays are not allowed', init.range);
    return null;
  }
  type = this.types.array(element, length);
  list = this._expr('InitListExpr', init.range, { inits: out }, type, 'prvalue');
  return { init: list, type: type };
};

function isCharType(type) {
  var name = type.unqualified.name;
  return type.kind === T.TypeKind.BUILTIN && (name === 'char' || name === 'signed char' ||
    name === 'unsigned char' || name === 'char16_t' || name === 'char32_t' ||
    name === 'wchar_t');
}

Sema.prototype._stringArrayInit = function (type, literal) {
  var element = type.element.unqualified;
  var literalElement = literal.type.element.unqualified;
  var narrow = { 'char': true, 'signed char': true, 'unsigned char': true };
  var length = literal.type.size;
  if (!(element === literalElement || (narrow[element.name] && narrow[literalElement.name]))) {
    this.error('initializing ' + this.quote(type) + ' with an expression of incompatible type ' +
      this.quote(literal.type), literal.range);
    return null;
  }
  if (type.size !== null && type.size < length - 1) {
    this.error('initializer-string for char array is too long', literal.range);
    return null;
  }
  type = this.types.array(type.element, type.size === null ? length : type.size);
  return { init: literal, type: type };
};

/**
 * Attaches and checks the initializer of a variable (replaces the
 * step-1 version).
 */
Sema.prototype.actOnVariableInit = function (decl, init, style) {
  var result;
  var deduced;
  var spec;
  if (!decl || decl.kind !== 'VarDecl') {
    return;
  }
  if (decl.autoSpec) {
    spec = decl.autoSpec;
    decl.autoSpec = null;
    if (!init && style) {
      decl.type = this.types.builtin('int');
      return;
    }
    if (!init) {
      this.error('declaration of variable \'' + decl.name + '\' with deduced type \'auto\' ' +
        'requires an initializer', decl.range);
      decl.type = this.types.builtin('int');
      return;
    }
    deduced = this.deduceAuto(decl.type, init, decl.name, decl.range);
    if (!deduced) {
      decl.type = this.types.builtin('int');
      decl.init = null;
      return;
    }
    if (spec._autoBinding && spec._autoBinding.type !== this._lastAutoBinding) {
      this.error('\'auto\' deduced as ' + this.quote(spec._autoBinding.type) +
        ' in declaration of \'' + spec._autoBinding.name + '\' and deduced as ' +
        this.quote(this._lastAutoBinding) + ' in declaration of \'' + decl.name + '\'',
        decl.range);
    }
    spec._autoBinding = spec._autoBinding || { type: this._lastAutoBinding, name: decl.name };
    decl.type = deduced;
    if (init.kind === 'InitListExpr' && init.inits.length === 1 && style === 'list') {
      init = init.inits[0];
      style = 'copy';
    }
  }
  decl.initStyle = init ? style : null;
  if (!init) {
    decl.init = null;
    // `style` set without `init`: an initializer was written but failed
    // and was already reported.
    if (decl.storage === 'extern' || style) {
      return;
    }
    if (T.isReference(decl.type)) {
      this.error('declaration of reference variable \'' + decl.name +
        '\' requires an initializer', decl.range);
    } else if (T.isArray(decl.type) && decl.type.size === null) {
      this.error('definition of variable with array type needs an explicit size or an ' +
        'initializer', decl.range);
    } else if (T.isRecord(decl.type) || (T.isArray(decl.type) &&
        T.isRecord(innermost(decl.type)))) {
      this._constructionContext = 'variable';
      try {
        decl.init = this.defaultConstruct(innermost(decl.type), decl.range);
      } finally {
        this._constructionContext = null;
      }
      if (decl.init && T.isArray(decl.type)) {
        // Every element is default-constructed the same way.
        decl.init.isArrayElement = true;
      }
    } else if (decl.type.isConst) {
      this.error('default initialization of an object of const type ' +
        this.quote(decl.type), decl.range);
    } else if (decl.isConstexpr) {
      this.error('constexpr variable \'' + decl.name + '\' must be initialized by a constant ' +
        'expression', decl.range);
    }
    return;
  }
  if (decl.storage === 'extern' && this.scope.kind !== 'namespace') {
    this.error('\'extern\' variable cannot have an initializer', decl.range);
    return;
  }
  this._constructionContext = 'variable';
  try {
    result = this.initialize(decl.type, init, style, 'variable');
  } finally {
    this._constructionContext = null;
  }
  decl.init = result ? result.init : init;
  if (result && result.type !== decl.type) {
    // An array of unknown bound gets its size from the initializer.
    decl.type = result.type;
  }
  if (result && decl.isConstexpr && (T.isIntegral(decl.type) || T.isEnum(decl.type)) &&
      constant.evaluate(this, result.init) === null) {
    this.error('constexpr variable \'' + decl.name + '\' must be initialized by a constant ' +
      'expression', init.range);
  }
};

/**
 * `return expr;` with conversion to the return type (replaces step 1).
 */
Sema.prototype.actOnReturnStatement = function (value, range, hadValue) {
  var fn = this.currentFunction();
  var returnType;
  var converted = value;
  var result;
  if (!fn) {
    return ast.createNode('ReturnStmt', range, { value: value });
  }
  if (fn.lambda && fn.lambda.deduceReturn) {
    if (hadValue && !value) {
      // The value was wrong: do not deduce `void` from it.
      fn.lambda.returnFailed = true;
      return ast.createNode('ReturnStmt', range, { value: null });
    }
    return this.lambdaReturn(fn.lambda, value, range);
  }
  returnType = fn.type.returnType;
  if (T.isVoid(returnType)) {
    if (value && !T.isVoid(value.type)) {
      this.error('void function \'' + fn.name + '\' should not return a value', range);
    }
  } else if (!value) {
    // A value that failed to parse or type-check was already reported.
    if (!hadValue) {
      this.error('non-void function \'' + fn.name + '\' should return a value', range);
    }
  } else {
    if (T.isRecord(returnType) && value.kind === 'DeclRefExpr' &&
        (value.decl.kind === 'ParamDecl' || (value.decl.kind === 'VarDecl' &&
          !value.decl.storage)) && !T.isReference(value.decl.type) &&
        value.type.unqualified === returnType.unqualified) {
      // A local object being returned is treated as an rvalue first
      // (C++11 12.8/32), so a move constructor is preferred.
      value = this.implicitCast(value, 'NoOp', value.type, 'xvalue');
    }
    result = this.initialize(returnType, value, value.kind === 'InitListExpr' ? 'list' :
      'copy', 'return');
    converted = result ? result.init : null;
  }
  return ast.createNode('ReturnStmt', range, { value: converted });
};

/** Converts a default argument to its parameter type. */
Sema.prototype.convertDefaultArgument = function (expr, type) {
  return expr ? this.convertTo(expr, type, 'parameter') : null;
};

/**
 * `expr;` — warns when the value of an expression without side effects is
 * discarded (-Wunused-value).
 */
Sema.prototype.actOnExpressionStatement = function (expr, range) {
  var core = expr;
  var unused;
  while (core && (core.kind === 'ParenExpr' || (core.kind === 'CastExpr' && !core.written))) {
    core = core.kind === 'ParenExpr' ? core.expr : core.operand;
  }
  if (core) {
    unused = /Literal$/.test(core.kind) || core.kind === 'DeclRefExpr' ||
      core.kind === 'SubscriptExpr' || core.kind === 'SizeofExpr' ||
      core.kind === 'ConditionalExpr' ||
      (core.kind === 'BinaryExpr' && core.operator !== ',' &&
        !(/=$/.test(core.operator) && !/^[<>!=]=$/.test(core.operator))) ||
      (core.kind === 'UnaryExpr' && core.operator !== '++' && core.operator !== '--');
    if (unused) {
      this.warning('expression result unused', expr.range);
    }
  }
  return ast.createNode('ExprStmt', range, { expr: expr });
};

module.exports = {
  uniqueFunctions: uniqueFunctions
};
