'use strict';

/**
 * Warnings that Clang enables by default (extends Sema.prototype), D-071:
 * shift counts, integer overflow in constant expressions, constant array
 * indexes out of bounds, addresses of locals returned, unused
 * comparisons, enumeration values not handled in a switch, string plus
 * integer, and uses of uninitialized local variables.
 */

var ast = require('../ast/nodes');
var T = require('./types');
var I = require('../util/int64');
var constant = require('./constant');
var Sema = require('./sema').Sema;

/** The expression under implicit casts and parentheses. */
function stripImplicit(expr) {
  while (expr && ((expr.kind === 'CastExpr' && !expr.written) || expr.kind === 'ParenExpr')) {
    expr = expr.kind === 'ParenExpr' ? expr.expr : expr.operand;
  }
  return expr;
}

/** Constant value of an integer expression, or null (no diagnostics). */
Sema.prototype._quietConstant = function (expr) {
  return expr && T.isIntegral(expr.type) || (expr && T.isEnum(expr.type)) ?
    constant.evaluate(this, expr) : null;
};

/** Range of a signed type of `bits` bits, as Int64 bounds. */
function signedBounds(bits) {
  return {
    min: I.neg(I.shl(I.ONE, bits - 1)),
    max: I.sub(I.shl(I.ONE, bits - 1), I.ONE)
  };
}

// ---------------------------------------------------------------------------
// Binary operators.

/** Called for every built-in binary operator node. */
Sema.prototype._warnBinary = function (node) {
  var op = node.operator;
  if (op === '<<' || op === '>>') {
    this._warnShiftCount(node);
  }
  if (op === '+' || op === '-' || op === '*') {
    this._warnIntegerOverflow(node);
  }
  if (op === '+') {
    this._warnStringPlusInt(node);
  }
};

/** `x << 33`, `x >> -1` (-Wshift-count-overflow, -Wshift-count-negative). */
Sema.prototype._warnShiftCount = function (node) {
  var count = this._quietConstant(node.right);
  var bits = T.sizeOf(node.left.type) * 8;
  if (count === null) {
    return;
  }
  if (!T.isUnsigned(node.right.type) && I.isNegative(count)) {
    this.warning('shift count is negative', node.right.range);
  } else if (!I.ltU(count, I.fromNumber(bits))) {
    this.warning('shift count >= width of type', node.right.range);
  }
};

/**
 * Signed arithmetic on constants whose exact result does not fit the type
 * (-Winteger-overflow): `overflow in expression; result is X with type 'int'`.
 */
Sema.prototype._warnIntegerOverflow = function (node) {
  var type = node.type;
  var bits;
  var l;
  var r;
  var exact;
  var bounds;
  var overflow;
  var wrapped;
  if (!T.isIntegral(type) || T.isUnsigned(type) || T.isBool(type)) {
    return;
  }
  l = this._quietConstant(node.left);
  r = this._quietConstant(node.right);
  if (l === null || r === null) {
    return;
  }
  bits = T.sizeOf(type) * 8;
  exact = node.operator === '+' ? I.add(l, r) : node.operator === '-' ? I.sub(l, r) :
    I.mul(l, r);
  if (bits < 64) {
    bounds = signedBounds(bits);
    overflow = I.ltS(exact, bounds.min) || I.ltS(bounds.max, exact);
  } else if (node.operator === '*') {
    overflow = !I.isZero(l) && (!I.eq(I.divS(exact, l), r) ||
      (I.eq(l, I.neg(I.ONE)) && I.eq(r, I.MIN_SIGNED)));
  } else {
    // 64-bit addition or subtraction: the sign of the result is wrong.
    if (node.operator === '-') {
      r = I.neg(r);
    }
    overflow = I.isNegative(l) === I.isNegative(r) && I.isNegative(exact) !== I.isNegative(l);
  }
  if (!overflow) {
    return;
  }
  wrapped = this.evaluateConstantInt64(node);
  this.warning('overflow in expression; result is ' + (wrapped === null ? '?' :
    I.toString(wrapped, true)) + ' with type ' + this.quote(type), node.range);
};

/** `"abc" + n` (-Wstring-plus-int): only when `n` is not a constant in range. */
Sema.prototype._warnStringPlusInt = function (node) {
  var left = stripImplicit(node.left);
  var right = stripImplicit(node.right);
  var string = left && left.kind === 'StringLiteral' ? left :
    right && right.kind === 'StringLiteral' ? right : null;
  var index = string === left ? node.right : node.left;
  var indexCore = stripImplicit(index);
  var value;
  var length;
  if (!string || !indexCore || !(T.isIntegral(indexCore.type) || T.isEnum(indexCore.type))) {
    return;
  }
  value = this._quietConstant(index);
  length = T.isArray(string.type) && string.type.size !== null ? string.type.size - 1 : 0;
  if (value !== null && !I.isNegative(value) && !I.ltS(I.fromNumber(length), value)) {
    return;
  }
  this.warning('adding ' + this.quote(indexCore.type.unqualified) + ' to a string does not ' +
    'append to the string', node.range)
    .addNote('use array indexing to silence this warning', node.range);
};

// ---------------------------------------------------------------------------
// Statements.

/**
 * `x == 1;` (-Wunused-comparison).
 *
 * @returns {boolean} Whether the warning was given.
 */
Sema.prototype._warnUnusedComparison = function (core) {
  var diag;
  if (!core || core.kind !== 'BinaryExpr') {
    return false;
  }
  if (core.operator === '==' || core.operator === '!=') {
    diag = this.warning('equality comparison result unused', core.range);
    diag.addNote(core.operator === '==' ? 'use \'=\' to turn this equality comparison into ' +
      'an assignment' : 'use \'|=\' to turn this inequality comparison into an or-assignment',
      core.range);
    return true;
  }
  if (core.operator === '<' || core.operator === '>' || core.operator === '<=' ||
      core.operator === '>=') {
    this.warning('relational comparison result unused', core.range);
    return true;
  }
  return false;
};

/**
 * `a[5]` on `int a[3]` (-Warray-bounds). The index one past the end is
 * allowed under `&` (the warning is then withdrawn by `_addressOf`).
 */
Sema.prototype._warnArrayBounds = function (base, index, node) {
  var core = stripImplicit(base);
  var value;
  var size;
  var diag;
  if (!core || !T.isArray(core.type) || core.type.size === null || !node) {
    return;
  }
  value = this._quietConstant(index);
  if (value === null) {
    return;
  }
  size = I.fromNumber(core.type.size);
  if (I.isNegative(value) && !T.isUnsigned(stripImplicit(index).type)) {
    diag = this.warning('array index ' + I.toString(value, true) + ' is before the beginning ' +
      'of the array', index.range);
  } else if (!I.ltU(value, size)) {
    diag = this.warning('array index ' + I.toString(value, false) + ' is past the end of the ' +
      'array (that has type ' + this.quote(core.type) + ')', index.range);
    if (I.eq(value, size)) {
      node.onePastEnd = diag;
    }
  }
  if (diag && core.kind === 'DeclRefExpr') {
    diag.addNote('array \'' + core.decl.name + '\' declared here', core.decl.range);
  } else if (diag && core.kind === 'MemberExpr') {
    diag.addNote('array \'' + core.member.name + '\' declared here', core.member.range);
  }
};

/** Whether a declaration is a local variable of `fn` with automatic storage. */
function isAutomaticLocal(decl, fn) {
  return !!decl && decl.ownerFunction === fn && ((decl.kind === 'VarDecl' &&
    decl.storage !== 'static' && decl.storage !== 'extern' && !decl.isThreadLocal) ||
    decl.kind === 'ParamDecl') && !T.isReference(decl.type);
}

/**
 * `return &x;` / `return x;` (for a reference) with a local `x`
 * (-Wreturn-stack-address).
 */
Sema.prototype._warnReturnStackAddress = function (fn, value) {
  var returnType = fn.type.returnType;
  var core = stripImplicit(value);
  var target = null;
  var what;
  if (!core || fn.lambda) {
    return;
  }
  if (T.isPointer(returnType)) {
    if (core.kind === 'UnaryExpr' && core.operator === '&') {
      target = stripImplicit(core.operand);
    } else if (core.kind === 'DeclRefExpr' && T.isArray(core.type)) {
      // A local array decays to the address of its first element.
      target = core;
    }
    what = 'address of';
  } else if (T.isReference(returnType)) {
    target = core;
    what = 'reference to';
  }
  if (!target || target.kind !== 'DeclRefExpr' || !isAutomaticLocal(target.decl, fn)) {
    return;
  }
  this.warning(what + ' stack memory associated with ' + (target.decl.kind === 'ParamDecl' ?
    'parameter' : 'local variable') + ' \'' + target.decl.name + '\' returned', value.range);
};

/** Enumeration values without a case in a switch without default (-Wswitch). */
Sema.prototype._warnSwitchEnum = function (sw, node) {
  var enumDecl = sw.enumType && sw.enumType.decl;
  var missing;
  var names;
  var message;
  if (!enumDecl || sw.hasDefault || !enumDecl.enumerators) {
    return;
  }
  missing = enumDecl.enumerators.filter(function (e) {
    return e.value !== null && e.value !== undefined && !sw.cases.some(function (c) {
      return c.constant && I.eq(c.constant, e.value);
    });
  });
  // Several enumerators may share a value: report each value once.
  missing = missing.filter(function (e, i) {
    return !missing.slice(0, i).some(function (other) { return I.eq(other.value, e.value); });
  });
  if (!missing.length) {
    return;
  }
  names = missing.map(function (e) { return '\'' + e.name + '\''; });
  if (names.length === 1) {
    message = 'enumeration value ' + names[0] + ' not handled in switch';
  } else if (names.length === 2) {
    message = 'enumeration values ' + names[0] + ' and ' + names[1] + ' not handled in switch';
  } else if (names.length === 3) {
    message = 'enumeration values ' + names[0] + ', ' + names[1] + ', and ' + names[2] +
      ' not handled in switch';
  } else {
    message = names.length + ' enumeration values not handled in switch: ' +
      names.slice(0, 3).join(', ') + '...';
  }
  this.warning(message, node.condition ? node.condition.range : node.range);
};

// ---------------------------------------------------------------------------
// Uninitialized variables (-Wuninitialized, simple cases).

var LOOP_KINDS = { WhileStmt: true, DoStmt: true, ForStmt: true, RangeForStmt: true };

/**
 * Warns about a scalar local declared without initializer and read
 * before anything in the function could have written it: no assignment,
 * address, reference binding or other use of it comes earlier in the
 * body, and the read is not in a loop that the variable outlives (a
 * later write could run first), nor after a label (`goto`).
 */
Sema.prototype._warnUninitialized = function (body) {
  var candidates = [];
  var states = [];
  var self = this;
  var labels = false;

  function stateOf(decl) {
    var i = candidates.indexOf(decl);
    return i === -1 ? null : states[i];
  }

  function visit(node, parent, loops) {
    var def;
    var state;
    if (!node || typeof node !== 'object') {
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(function (n) { visit(n, parent, loops); });
      return;
    }
    if (node.kind === 'LabelStmt') {
      labels = true;
    }
    if (node.kind === 'VarDecl' && !node.init && !node.storage && isScalarType(node.type)) {
      candidates.push(node);
      states.push({ written: false, reported: false, loops: loops });
    }
    if (node.kind === 'DeclRefExpr' && (state = stateOf(node.decl))) {
      if (parent && parent.kind === 'CastExpr' && parent.conversion === 'LValueToRValue' &&
          !state.written && !state.reported && !labels && loops === state.loops) {
        state.reported = true;
        self.warning('variable \'' + node.decl.name + '\' is uninitialized when used here',
          node.range).addNote('initialize the variable \'' + node.decl.name + '\' to silence ' +
          'this warning', node.decl.range);
      } else if (!(parent && parent.kind === 'CastExpr' &&
          parent.conversion === 'LValueToRValue')) {
        state.written = true;
      }
    }
    def = ast.NODE_KINDS[node.kind];
    if (!def) {
      return;
    }
    def.children.forEach(function (child) {
      visit(node[child], node, LOOP_KINDS[node.kind] ? loops + 1 : loops);
    });
  }

  visit(body, null, 0);
};

function isScalarType(type) {
  var t = type && type.unqualified;
  return !!t && !T.isReference(type) && (T.isIntegral(t) || T.isFloating(t) || T.isEnum(t) ||
    T.isPointer(t));
}

module.exports = {};
