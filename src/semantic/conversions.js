'use strict';

/**
 * Implicit conversions (C++11 clause 4, 8.5.3, 13.3.3.1), D-047.
 *
 * `computeConversion` finds the implicit conversion sequence from an
 * expression to a type without changing anything; `applyConversion` then
 * wraps the expression in implicit `CastExpr` nodes, one per step.
 *
 * A conversion sequence is:
 *   {
 *     kind: 'standard' | 'ellipsis',
 *     rank: 0 (exact match), 1 (promotion), 2 (conversion),
 *     steps: [{castKind, type, valueCategory}],
 *     isBoolean: true for a conversion to bool (ranked below others),
 *     target: final type,
 *     reference: null or {lvalueRef, rvalueBinding, temporary, referee}
 *   }
 * or null when no implicit conversion exists; `failure` explains why.
 */

var T = require('./types');

var RANK_EXACT = 0;
var RANK_PROMOTION = 1;
var RANK_CONVERSION = 2;

/** Whether an expression is a null pointer constant (C++11 4.10/1). */
function isNullPointerConstant(sema, expr) {
  if (T.isNullPointer(expr.type)) {
    return true;
  }
  if (!T.isIntegral(expr.type) || expr.valueCategory !== 'prvalue') {
    return false;
  }
  var value = sema.evaluateConstant(expr);
  return value !== null && value === 0;
}

/**
 * Lvalue-to-rvalue, array-to-pointer and function-to-pointer
 * transformations (C++11 4.1-4.3).
 *
 * @returns {{type: Object, steps: Array.<Object>}}
 */
function lvalueTransformation(sema, expr) {
  var type = expr.type;
  if (T.isArray(type)) {
    type = sema.types.pointer(type.element);
    return { type: type, steps: [{ castKind: 'ArrayToPointerDecay', type: type,
      valueCategory: 'prvalue' }] };
  }
  if (T.isFunction(type)) {
    type = sema.types.pointer(type);
    return { type: type, steps: [{ castKind: 'FunctionToPointerDecay', type: type,
      valueCategory: 'prvalue' }] };
  }
  if (expr.valueCategory !== 'prvalue' && !T.isRecord(type)) {
    // Class objects are copied by a constructor instead (D-051).
    type = type.unqualified;
    return { type: type, steps: [{ castKind: 'LValueToRValue', type: type,
      valueCategory: 'prvalue' }] };
  }
  return { type: type, steps: [] };
}

/** Whether cv-qualifiers of `a` include those of `b`. */
function cvIncludes(a, b) {
  return (a.isConst || !b.isConst) && (a.isVolatile || !b.isVolatile);
}

/**
 * Qualification conversion between pointer types (C++11 4.4): every level
 * may only gain cv-qualifiers, and once a level gains some, every level
 * above it (except the outermost pointer) must be const.
 *
 * @returns {boolean}
 */
function isQualificationConvertible(from, to) {
  var a = from;
  var b = to;
  var constAbove = true;
  for (;;) {
    if (!T.isPointer(a) || !T.isPointer(b)) {
      return false;
    }
    a = a.pointee;
    b = b.pointee;
    if (!cvIncludes(b, a)) {
      return false;
    }
    if ((a.isConst !== b.isConst || a.isVolatile !== b.isVolatile) && !constAbove) {
      return false;
    }
    constAbove = constAbove && b.isConst;
    if (T.isPointer(a.unqualified) && T.isPointer(b.unqualified)) {
      a = a.unqualified;
      b = b.unqualified;
      continue;
    }
    return a.unqualified === b.unqualified;
  }
}

/** Integral or floating-point promotion (C++11 4.5, 4.6). */
function isPromotion(sema, from, to) {
  if (T.isFloating(from)) {
    return from.name === 'float' && to.name === 'double';
  }
  if (T.isIntegral(from) || (T.isEnum(from) && !T.isScopedEnum(from))) {
    return from !== to && T.promote(sema.types, from) === to;
  }
  return false;
}

/**
 * Standard conversion from a prvalue of type `from` to `to` (both
 * cv-unqualified, except pointer targets).
 *
 * @returns {?{rank: number, castKind: ?string, isBoolean: boolean}}
 *   `castKind` null means identity.
 */
function standardStep(sema, from, to, isNull) {
  var unscopedEnum = T.isEnum(from) && !T.isScopedEnum(from);
  if (from === to) {
    return { rank: RANK_EXACT, castKind: null, isBoolean: false };
  }
  if (isPromotion(sema, from, to)) {
    return { rank: RANK_PROMOTION, castKind: T.isFloating(from) ? 'FloatingCast' :
      'IntegralCast', isBoolean: false };
  }
  if (T.isBool(to)) {
    if (T.isArithmetic(from) || unscopedEnum) {
      return { rank: RANK_CONVERSION, castKind: T.isFloating(from) ? 'FloatingToBoolean' :
        'IntegralToBoolean', isBoolean: true };
    }
    if (T.isPointer(from)) {
      return { rank: RANK_CONVERSION, castKind: 'PointerToBoolean', isBoolean: true };
    }
    return null;
  }
  if (T.isIntegral(to) && (T.isIntegral(from) || unscopedEnum)) {
    return { rank: RANK_CONVERSION, castKind: 'IntegralCast', isBoolean: false };
  }
  if (T.isFloating(to) && T.isFloating(from)) {
    return { rank: RANK_CONVERSION, castKind: 'FloatingCast', isBoolean: false };
  }
  if (T.isFloating(to) && (T.isIntegral(from) || unscopedEnum)) {
    return { rank: RANK_CONVERSION, castKind: 'IntegralToFloating', isBoolean: false };
  }
  if (T.isIntegral(to) && T.isFloating(from)) {
    return { rank: RANK_CONVERSION, castKind: 'FloatingToIntegral', isBoolean: false };
  }
  if (T.isPointer(to)) {
    if (isNull) {
      return { rank: RANK_CONVERSION, castKind: 'NullToPointer', isBoolean: false };
    }
    if (T.isPointer(from)) {
      if (isQualificationConvertible(from, to)) {
        return { rank: RANK_EXACT, castKind: 'NoOp', isBoolean: false };
      }
      if (T.isVoid(to.pointee) && T.isObject(from.pointee) && cvIncludes(to.pointee,
          from.pointee)) {
        return { rank: RANK_CONVERSION, castKind: 'BitCast', isBoolean: false };
      }
    }
    return null;
  }
  if (T.isNullPointer(to) && T.isNullPointer(from)) {
    return { rank: RANK_EXACT, castKind: null, isBoolean: false };
  }
  return null;
}

/**
 * Conversion sequence to a non-reference type.
 */
function nonReferenceConversion(sema, expr, toType) {
  var target = T.isPointer(toType) ? toType.unqualified : toType.unqualified;
  var transformed;
  var step;
  var steps;
  if (T.isVoid(expr.type)) {
    return null;
  }
  // An overload set converts to a function pointer by picking the match.
  if ((expr.kind === 'DeclRefExpr' || expr.kind === 'UnaryExpr') && expr.candidates &&
      expr.candidates.length > 1) {
    return overloadedFunctionConversion(sema, expr, target);
  }
  if (T.isRecord(target) || T.isRecord(expr.type)) {
    return classConversion(sema, expr, target);
  }
  transformed = lvalueTransformation(sema, expr);
  step = standardStep(sema, transformed.type, target, isNullPointerConstant(sema, expr));
  if (!step) {
    return null;
  }
  steps = transformed.steps.slice();
  if (step.castKind) {
    steps.push({ castKind: step.castKind, type: target, valueCategory: 'prvalue' });
  }
  return { kind: 'standard', rank: step.rank, steps: steps, isBoolean: step.isBoolean,
    target: target, reference: null };
}

/**
 * Conversions involving class types. A prvalue of the target class is an
 * identity; a glvalue of it is copied (or moved) by a constructor, still
 * an exact match (13.3.3.1/6). User-defined conversions come with step 5e.
 */
function classConversion(sema, expr, target) {
  if (T.isRecord(target) && T.isRecord(expr.type) &&
      expr.type.unqualified === target.unqualified) {
    if (expr.valueCategory === 'prvalue') {
      return { kind: 'standard', rank: RANK_EXACT, steps: [], isBoolean: false, target: target,
        reference: null };
    }
    return { kind: 'standard', rank: RANK_EXACT, steps: [{ castKind: 'ConstructorConversion',
      type: target, valueCategory: 'prvalue' }], isBoolean: false, target: target,
      reference: null };
  }
  return null;
}

/**
 * Address of an overloaded function, resolved by the target type (C++11
 * 13.4): the candidate whose type matches the pointee.
 */
function overloadedFunctionConversion(sema, expr, target) {
  var i;
  var wanted = T.isPointer(target) ? target.pointee : target;
  for (i = 0; i < expr.candidates.length; i++) {
    if (expr.candidates[i].type === wanted && expr.kind === 'UnaryExpr') {
      // `&f`: the address operator already produces the pointer.
      return { kind: 'standard', rank: RANK_EXACT, steps: [
        { castKind: 'SelectOverload', type: target, valueCategory: 'prvalue',
          decl: expr.candidates[i] }
      ], isBoolean: false, target: target, reference: null };
    }
    if (expr.candidates[i].type === wanted) {
      return { kind: 'standard', rank: RANK_EXACT, steps: [
        { castKind: 'SelectOverload', type: wanted, valueCategory: 'lvalue',
          decl: expr.candidates[i] },
        { castKind: 'FunctionToPointerDecay', type: sema.types.pointer(wanted),
          valueCategory: 'prvalue' }
      ], isBoolean: false, target: target, reference: null };
    }
  }
  return null;
}

/** `'const'`, `'volatile'` or `'const volatile'`: what a binding drops. */
function droppedQualifiers(to, from) {
  var dropped = [];
  if (from.isConst && !to.isConst) {
    dropped.push('const');
  }
  if (from.isVolatile && !to.isVolatile) {
    dropped.push('volatile');
  }
  return '\'' + dropped.join(' ') + '\'';
}

/**
 * Reference binding (C++11 8.5.3).
 *
 * @returns {?Object} The conversion sequence, or null; on failure
 *   `failure.message` (set on the `failure` argument) explains why.
 */
function referenceConversion(sema, expr, refType, failure) {
  var isLvalueRef = refType.kind === T.TypeKind.LVALUE_REF;
  var referee = refType.referee;
  var source = expr.type;
  var related = source.unqualified === referee.unqualified;
  var compatible = related && cvIncludes(referee, source);
  var inner;
  var steps = [];
  if (isLvalueRef && expr.valueCategory === 'lvalue' && compatible) {
    if (source !== referee) {
      steps.push({ castKind: 'NoOp', type: referee, valueCategory: 'lvalue' });
    }
    return { kind: 'standard', rank: RANK_EXACT, steps: steps, isBoolean: false,
      target: refType, reference: { lvalueRef: true, rvalueBinding: false, temporary: false,
        referee: referee } };
  }
  if (related && !cvIncludes(referee, source)) {
    failure.message = 'binding reference of type ' + sema.quote(referee) + ' to value of type ' +
      sema.quote(source) + ' drops ' + droppedQualifiers(referee, source) + ' qualifier' +
      (source.isConst && source.isVolatile && !referee.isConst && !referee.isVolatile ? 's' : '');
    return null;
  }
  if (isLvalueRef && !(referee.isConst && !referee.isVolatile)) {
    failure.message = 'non-const lvalue reference to type ' + sema.quote(referee) +
      (expr.valueCategory === 'lvalue' ? ' cannot bind to a value of unrelated type ' +
        sema.quote(source) : ' cannot bind to a temporary of type ' + sema.quote(source));
    return null;
  }
  if (!isLvalueRef && expr.valueCategory === 'lvalue' && related) {
    failure.message = 'rvalue reference to type ' + sema.quote(referee) +
      ' cannot bind to lvalue of type ' + sema.quote(source);
    return null;
  }
  if (expr.valueCategory === 'xvalue' && compatible) {
    return { kind: 'standard', rank: RANK_EXACT, steps: steps, isBoolean: false,
      target: refType, reference: { lvalueRef: isLvalueRef, rvalueBinding: true,
        temporary: false, referee: referee } };
  }
  // Bind to a temporary initialized by copy-initialization.
  inner = nonReferenceConversion(sema, expr, referee.unqualified);
  if (!inner) {
    return null;
  }
  steps = inner.steps.slice();
  steps.push({ castKind: 'MaterializeTemporary', type: referee,
    valueCategory: isLvalueRef ? 'lvalue' : 'xvalue' });
  return { kind: 'standard', rank: inner.rank, steps: steps, isBoolean: inner.isBoolean,
    target: refType, reference: { lvalueRef: isLvalueRef, rvalueBinding: true,
      temporary: true, referee: referee } };
}

/**
 * Finds the implicit conversion sequence from `expr` to `toType`.
 *
 * @param {Sema} sema
 * @param {Object} expr Typed expression.
 * @param {Object} toType
 * @param {Object} [failure] Receives `message` when binding a reference
 *   fails for a specific reason.
 * @returns {?Object}
 */
function computeConversion(sema, expr, toType, failure) {
  if (!expr || !expr.type) {
    return null;
  }
  if (T.isReference(toType)) {
    return referenceConversion(sema, expr, toType, failure || {});
  }
  return nonReferenceConversion(sema, expr, toType);
}

/**
 * Wraps an expression in the implicit casts of a conversion sequence.
 *
 * @returns {Object} The converted expression.
 */
function applyConversion(sema, expr, conversion) {
  var i;
  var step;
  var result = expr;
  for (i = 0; i < conversion.steps.length; i++) {
    step = conversion.steps[i];
    if (step.castKind === 'SelectOverload') {
      result = sema.selectOverload(result, step.decl);
      continue;
    }
    if (step.castKind === 'ConstructorConversion') {
      result = sema.copyObject(result, step.type);
      if (!result) {
        return null;
      }
      continue;
    }
    result = sema.implicitCast(result, step.castKind, step.type, step.valueCategory);
  }
  return result;
}

/**
 * Compares two conversion sequences for the same argument (C++11
 * 13.3.3.2).
 *
 * @returns {number} -1 if `a` is better, 1 if `b` is better, 0 otherwise.
 */
function compareConversions(a, b) {
  var aKind = a.kind === 'ellipsis' ? 1 : 0;
  var bKind = b.kind === 'ellipsis' ? 1 : 0;
  if (aKind !== bKind) {
    return aKind < bKind ? -1 : 1;
  }
  if (aKind === 1) {
    return 0;
  }
  if (a.rank !== b.rank) {
    return a.rank < b.rank ? -1 : 1;
  }
  // A conversion that is not to bool beats one to bool (13.3.3.2/4).
  if (a.isBoolean !== b.isBoolean) {
    return a.isBoolean ? 1 : -1;
  }
  if (a.reference && b.reference) {
    // Binding an rvalue to an rvalue reference beats an lvalue reference.
    if (a.reference.rvalueBinding && b.reference.rvalueBinding &&
        a.reference.lvalueRef !== b.reference.lvalueRef) {
      return a.reference.lvalueRef ? 1 : -1;
    }
    // A reference to a less cv-qualified type is better.
    if (a.reference.referee.unqualified === b.reference.referee.unqualified &&
        a.reference.referee !== b.reference.referee) {
      if (cvIncludes(b.reference.referee, a.reference.referee)) {
        return -1;
      }
      if (cvIncludes(a.reference.referee, b.reference.referee)) {
        return 1;
      }
    }
  }
  // Between pointer qualification conversions, fewer qualifiers win.
  if (!a.reference && !b.reference && T.isPointer(a.target) && T.isPointer(b.target) &&
      a.target !== b.target) {
    if (isQualificationConvertible(a.target, b.target)) {
      return -1;
    }
    if (isQualificationConvertible(b.target, a.target)) {
      return 1;
    }
  }
  return 0;
}

module.exports = {
  RANK_EXACT: RANK_EXACT,
  RANK_PROMOTION: RANK_PROMOTION,
  RANK_CONVERSION: RANK_CONVERSION,
  isNullPointerConstant: isNullPointerConstant,
  isQualificationConvertible: isQualificationConvertible,
  lvalueTransformation: lvalueTransformation,
  computeConversion: computeConversion,
  applyConversion: applyConversion,
  compareConversions: compareConversions
};
