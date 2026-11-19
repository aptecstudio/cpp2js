'use strict';

/**
 * C++ type representation (D-036, D-039).
 *
 * Types are created by a `TypeContext` and **interned**: two types are the
 * same C++ type if and only if they are the same object, so `===` is type
 * identity. Every type carries its cv-qualifiers (`isConst`,
 * `isVolatile`) and a link to its cv-unqualified variant (`unqualified`).
 *
 * Kinds:
 *   - `builtin`: fundamental types and `std::nullptr_t` (`name`);
 *   - `pointer` (`pointee`), `lvalue-ref` / `rvalue-ref` (`referee`);
 *   - `array` (`element`, `size`: number or null for unknown bound);
 *   - `function` (`returnType`, `params`, `variadic`, `methodConst`,
 *     `methodVolatile`, `refQualifier`: '', '&' or '&&');
 *   - `record` (class, struct, union) and `enum`: `decl` is the declaration.
 *
 * Sizes follow the ILP32 data model of D-036.
 */

var TypeKind = {
  BUILTIN: 'builtin',
  POINTER: 'pointer',
  LVALUE_REF: 'lvalue-ref',
  RVALUE_REF: 'rvalue-ref',
  ARRAY: 'array',
  FUNCTION: 'function',
  RECORD: 'record',
  ENUM: 'enum'
};

/**
 * Fundamental types: size in bytes, signedness, integer conversion rank
 * (C++11 4.13), category. `char16_t`, `char32_t` and `wchar_t` have the
 * rank of their underlying types (unsigned short, unsigned int, int).
 */
var BUILTINS = {
  'void': { size: null, category: 'void' },
  'std::nullptr_t': { size: 4, category: 'nullptr' },
  'bool': { size: 1, category: 'integral', signed: false, rank: 0 },
  'char': { size: 1, category: 'integral', signed: true, rank: 1 },
  'signed char': { size: 1, category: 'integral', signed: true, rank: 1 },
  'unsigned char': { size: 1, category: 'integral', signed: false, rank: 1 },
  'short': { size: 2, category: 'integral', signed: true, rank: 2 },
  'unsigned short': { size: 2, category: 'integral', signed: false, rank: 2 },
  'char16_t': { size: 2, category: 'integral', signed: false, rank: 2 },
  'int': { size: 4, category: 'integral', signed: true, rank: 3 },
  'unsigned int': { size: 4, category: 'integral', signed: false, rank: 3 },
  'wchar_t': { size: 4, category: 'integral', signed: true, rank: 3 },
  'char32_t': { size: 4, category: 'integral', signed: false, rank: 3 },
  'long': { size: 4, category: 'integral', signed: true, rank: 4 },
  'unsigned long': { size: 4, category: 'integral', signed: false, rank: 4 },
  'long long': { size: 8, category: 'integral', signed: true, rank: 5 },
  'unsigned long long': { size: 8, category: 'integral', signed: false, rank: 5 },
  'float': { size: 4, category: 'floating', rank: 0 },
  'double': { size: 8, category: 'floating', rank: 1 },
  'long double': { size: 8, category: 'floating', rank: 2 }
};

// Signed type of each rank, and its unsigned counterpart.
var SIGNED_BY_RANK = ['bool', 'signed char', 'short', 'int', 'long', 'long long'];
var UNSIGNED_OF = {
  'char': 'unsigned char', 'signed char': 'unsigned char', 'short': 'unsigned short',
  'int': 'unsigned int', 'long': 'unsigned long', 'long long': 'unsigned long long'
};

/** Pointer size and alignment in bytes (ILP32). */
var POINTER_SIZE = 4;

/**
 * Creates and interns types.
 *
 * @constructor
 */
function TypeContext() {
  var name;
  this._interned = Object.create(null);
  this._nextId = 0;
  this._builtins = Object.create(null);
  for (name in BUILTINS) {
    if (BUILTINS.hasOwnProperty(name)) {
      this._builtins[name] = this._intern('b:' + name, function () {
        return { kind: TypeKind.BUILTIN, name: name };
      });
    }
  }
}

/**
 * Returns the interned type for `key`, creating it with `make` (which
 * returns the kind-specific fields) on first use.
 */
TypeContext.prototype._intern = function (key, make) {
  var type = this._interned[key];
  if (!type) {
    type = make();
    type.id = this._nextId++;
    type.isConst = false;
    type.isVolatile = false;
    type.unqualified = type;
    this._interned[key] = type;
  }
  return type;
};

/**
 * Returns a fundamental type by its canonical name (`'int'`,
 * `'unsigned long long'`, `'std::nullptr_t'`, ...).
 *
 * @param {string} name
 * @returns {Object}
 * @throws {Error} If the name is unknown.
 */
TypeContext.prototype.builtin = function (name) {
  var type = this._builtins[name];
  if (!type) {
    throw new Error('Unknown builtin type: ' + name);
  }
  return type;
};

/**
 * Returns `type` with exactly the given cv-qualifiers. Qualifying an array
 * qualifies its elements (C++11 3.9.3/5); references and functions cannot
 * be cv-qualified, so they are returned unchanged.
 *
 * @param {Object} type
 * @param {boolean} isConst
 * @param {boolean} isVolatile
 * @returns {Object}
 */
TypeContext.prototype.qualified = function (type, isConst, isVolatile) {
  var base = type.unqualified;
  var created = false;
  var qualifiedType;
  if (type.kind === TypeKind.ARRAY) {
    return this.array(this.qualified(type.element, isConst, isVolatile), type.size);
  }
  if (type.kind === TypeKind.LVALUE_REF || type.kind === TypeKind.RVALUE_REF ||
      type.kind === TypeKind.FUNCTION) {
    return type;
  }
  if (!isConst && !isVolatile) {
    return base;
  }
  qualifiedType = this._intern((isConst ? 'c' : '') + (isVolatile ? 'v' : '') + ':' + base.id,
    function () {
      var copy = {};
      var key;
      created = true;
      for (key in base) {
        if (base.hasOwnProperty(key)) {
          copy[key] = base[key];
        }
      }
      return copy;
    });
  if (created) {
    qualifiedType.isConst = isConst;
    qualifiedType.isVolatile = isVolatile;
    qualifiedType.unqualified = base;
  }
  return qualifiedType;
};

/**
 * Adds cv-qualifiers to those already present.
 */
TypeContext.prototype.addQualifiers = function (type, isConst, isVolatile) {
  return this.qualified(type, type.isConst || isConst, type.isVolatile || isVolatile);
};

/** Removes top-level cv-qualifiers (of the element type for arrays). */
TypeContext.prototype.removeQualifiers = function (type) {
  if (type.kind === TypeKind.ARRAY) {
    return this.array(this.removeQualifiers(type.element), type.size);
  }
  return type.unqualified;
};

TypeContext.prototype.pointer = function (pointee) {
  return this._intern('p:' + pointee.id, function () {
    return { kind: TypeKind.POINTER, pointee: pointee };
  });
};

/**
 * Lvalue reference, with reference collapsing (C++11 8.3.2/6): a reference
 * to a reference is an lvalue reference to the innermost referee.
 */
TypeContext.prototype.lvalueReference = function (referee) {
  if (referee.kind === TypeKind.LVALUE_REF || referee.kind === TypeKind.RVALUE_REF) {
    referee = referee.referee;
  }
  return this._intern('l:' + referee.id, function () {
    return { kind: TypeKind.LVALUE_REF, referee: referee };
  });
};

/**
 * Rvalue reference, with reference collapsing: `T& &&` is `T&`,
 * `T&& &&` is `T&&`.
 */
TypeContext.prototype.rvalueReference = function (referee) {
  if (referee.kind === TypeKind.LVALUE_REF) {
    return referee;
  }
  if (referee.kind === TypeKind.RVALUE_REF) {
    referee = referee.referee;
  }
  return this._intern('r:' + referee.id, function () {
    return { kind: TypeKind.RVALUE_REF, referee: referee };
  });
};

/**
 * @param {Object} element
 * @param {?number} size Number of elements, or null for an unknown bound.
 */
TypeContext.prototype.array = function (element, size) {
  return this._intern('a:' + element.id + ':' + (size === null ? '' : size), function () {
    return { kind: TypeKind.ARRAY, element: element, size: size };
  });
};

/**
 * Function type. Parameter types are given after adjustment (arrays and
 * functions decayed, top-level cv removed), as C++11 8.3.5/5 requires for
 * the type of a function.
 *
 * @param {Object} returnType
 * @param {Array.<Object>} params
 * @param {Object} [options] `variadic`, `methodConst`, `methodVolatile`,
 *   `refQualifier` ('', '&', '&&').
 */
TypeContext.prototype.func = function (returnType, params, options) {
  var opts = options || {};
  var variadic = !!opts.variadic;
  var methodConst = !!opts.methodConst;
  var methodVolatile = !!opts.methodVolatile;
  var refQualifier = opts.refQualifier || '';
  var key = 'f:' + returnType.id + '(' + params.map(function (p) { return p.id; }).join(',') +
    (variadic ? ',...' : '') + ')' + (methodConst ? 'c' : '') + (methodVolatile ? 'v' : '') +
    refQualifier;
  return this._intern(key, function () {
    return {
      kind: TypeKind.FUNCTION,
      returnType: returnType,
      params: params.slice(),
      variadic: variadic,
      methodConst: methodConst,
      methodVolatile: methodVolatile,
      refQualifier: refQualifier
    };
  });
};

/**
 * Type of a class, struct or union declaration. The declaration must have
 * a unique numeric `id`.
 */
TypeContext.prototype.record = function (decl) {
  return this._intern('R:' + decl.id, function () {
    return { kind: TypeKind.RECORD, decl: decl };
  });
};

/** Type of an enumeration declaration (unique numeric `id`). */
TypeContext.prototype.enumeration = function (decl) {
  return this._intern('E:' + decl.id, function () {
    return { kind: TypeKind.ENUM, decl: decl };
  });
};

/**
 * Parameter type adjustment (C++11 8.3.5/5): arrays and functions decay to
 * pointers, top-level cv-qualifiers are dropped.
 */
TypeContext.prototype.adjustParameter = function (type) {
  if (type.kind === TypeKind.ARRAY) {
    return this.pointer(type.element);
  }
  if (type.kind === TypeKind.FUNCTION) {
    return this.pointer(type);
  }
  return type.unqualified;
};

/**
 * Array-to-pointer and function-to-pointer conversions (C++11 4.2, 4.3);
 * other types are returned unchanged.
 */
TypeContext.prototype.decay = function (type) {
  if (type.kind === TypeKind.ARRAY) {
    return this.pointer(type.element);
  }
  if (type.kind === TypeKind.FUNCTION) {
    return this.pointer(type);
  }
  return type;
};

/** Removes a reference, if any. */
function removeReference(type) {
  return isReference(type) ? type.referee : type;
}

// ---------------------------------------------------------------------------
// Classification.

function info(type) {
  return type.kind === TypeKind.BUILTIN ? BUILTINS[type.name] : null;
}

function isVoid(type) {
  return type.kind === TypeKind.BUILTIN && type.name === 'void';
}

function isNullPointer(type) {
  return type.kind === TypeKind.BUILTIN && type.name === 'std::nullptr_t';
}

function isBool(type) {
  return type.kind === TypeKind.BUILTIN && type.name === 'bool';
}

/** Integral types (C++11 3.9.1/7); enumerations are not integral. */
function isIntegral(type) {
  var i = info(type);
  return !!i && i.category === 'integral';
}

function isFloating(type) {
  var i = info(type);
  return !!i && i.category === 'floating';
}

function isArithmetic(type) {
  return isIntegral(type) || isFloating(type);
}

function isEnum(type) {
  return type.kind === TypeKind.ENUM;
}

function isScopedEnum(type) {
  return type.kind === TypeKind.ENUM && !!type.decl.scoped;
}

function isPointer(type) {
  return type.kind === TypeKind.POINTER;
}

function isReference(type) {
  return type.kind === TypeKind.LVALUE_REF || type.kind === TypeKind.RVALUE_REF;
}

function isArray(type) {
  return type.kind === TypeKind.ARRAY;
}

function isFunction(type) {
  return type.kind === TypeKind.FUNCTION;
}

function isRecord(type) {
  return type.kind === TypeKind.RECORD;
}

/** Scalar types (C++11 3.9/9). */
function isScalar(type) {
  return isArithmetic(type) || isEnum(type) || isPointer(type) || isNullPointer(type);
}

/** Object types: not function, reference or void (C++11 3.9/8). */
function isObject(type) {
  return !isFunction(type) && !isReference(type) && !isVoid(type);
}

function isSigned(type) {
  var i = info(type);
  return !!i && (i.category === 'floating' || i.signed === true);
}

function isUnsigned(type) {
  var i = info(type);
  return !!i && i.category === 'integral' && i.signed === false;
}

/**
 * Whether the type is complete: void, unknown-bound arrays and classes or
 * enums only declared are not.
 */
function isComplete(type) {
  if (isVoid(type)) {
    return false;
  }
  if (type.kind === TypeKind.ARRAY) {
    return type.size !== null && isComplete(type.element);
  }
  if (type.kind === TypeKind.RECORD || type.kind === TypeKind.ENUM) {
    return !!type.decl.complete;
  }
  return true;
}

/**
 * `sizeof` in bytes (ILP32, D-036), or null for incomplete and function
 * types. Records and enums use the `size` computed on their declaration.
 */
function sizeOf(type) {
  var element;
  switch (type.kind) {
    case TypeKind.BUILTIN:
      return BUILTINS[type.name].size;
    case TypeKind.POINTER:
      return POINTER_SIZE;
    case TypeKind.LVALUE_REF:
    case TypeKind.RVALUE_REF:
      return sizeOf(type.referee);
    case TypeKind.ARRAY:
      element = sizeOf(type.element);
      return type.size === null || element === null ? null : element * type.size;
    case TypeKind.RECORD:
    case TypeKind.ENUM:
      return type.decl.complete ? type.decl.size : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Arithmetic conversions.

/**
 * Integral promotion (C++11 4.5): types of rank lower than `int` become
 * `int` (all their values fit); `char32_t` becomes `unsigned int`; unscoped
 * enumerations promote their underlying type. Other types are unchanged.
 *
 * @param {TypeContext} ctx
 * @param {Object} type cv-unqualified type.
 * @returns {Object}
 */
function promote(ctx, type) {
  var i;
  if (type.kind === TypeKind.ENUM && !type.decl.scoped) {
    return promote(ctx, type.decl.underlyingType);
  }
  i = info(type);
  if (!i || i.category !== 'integral') {
    return type;
  }
  if (i.rank < 3) {
    return ctx.builtin('int');
  }
  if (type.name === 'char32_t') {
    return ctx.builtin('unsigned int');
  }
  if (type.name === 'wchar_t') {
    return ctx.builtin('int');
  }
  return type;
}

/**
 * Usual arithmetic conversions (C++11 clause 5/10): the common type of two
 * arithmetic (or unscoped enumeration) operands.
 *
 * @param {TypeContext} ctx
 * @param {Object} a
 * @param {Object} b
 * @returns {Object}
 */
function usualArithmeticConversions(ctx, a, b) {
  var ia;
  var ib;
  var signedType;
  var unsignedType;
  a = promote(ctx, a.unqualified);
  b = promote(ctx, b.unqualified);
  if (isFloating(a) || isFloating(b)) {
    if (!isFloating(b)) {
      return a;
    }
    if (!isFloating(a)) {
      return b;
    }
    return BUILTINS[a.name].rank >= BUILTINS[b.name].rank ? a : b;
  }
  if (a === b) {
    return a;
  }
  ia = BUILTINS[a.name];
  ib = BUILTINS[b.name];
  if (ia.signed === ib.signed) {
    return ia.rank >= ib.rank ? a : b;
  }
  signedType = ia.signed ? a : b;
  unsignedType = ia.signed ? b : a;
  if (BUILTINS[unsignedType.name].rank >= BUILTINS[signedType.name].rank) {
    return unsignedType;
  }
  // The signed type wins if it can represent every value of the unsigned
  // one, i.e. if it is wider (long long vs unsigned int/long in ILP32).
  if (BUILTINS[signedType.name].size > BUILTINS[unsignedType.name].size) {
    return signedType;
  }
  return ctx.builtin(UNSIGNED_OF[signedType.name]);
}

/**
 * The signed integer type of a given rank (used for literal typing).
 */
function signedOfRank(ctx, rank) {
  return ctx.builtin(SIGNED_BY_RANK[rank]);
}

/** The unsigned counterpart of a signed integer type. */
function makeUnsigned(ctx, type) {
  return UNSIGNED_OF[type.name] ? ctx.builtin(UNSIGNED_OF[type.name]) : type;
}

// ---------------------------------------------------------------------------
// Printing.

function cvText(type) {
  return (type.isConst ? 'const' : '') + (type.isConst && type.isVolatile ? ' ' : '') +
    (type.isVolatile ? 'volatile' : '');
}

function needsParens(inner) {
  return inner.charAt(0) === '*' || inner.charAt(0) === '&';
}

function print(type, inner) {
  var cv = cvText(type);
  var wrapped;
  var params;
  switch (type.kind) {
    case TypeKind.BUILTIN:
    case TypeKind.RECORD:
    case TypeKind.ENUM:
      return (cv ? cv + ' ' : '') +
        (type.kind === TypeKind.BUILTIN ? type.name : type.decl.qualifiedName || type.decl.name) +
        (inner ? ' ' + inner : '');
    case TypeKind.POINTER:
      return print(type.pointee, '*' + cv + (cv && inner ? ' ' : '') + inner);
    case TypeKind.LVALUE_REF:
      return print(type.referee, '&' + inner);
    case TypeKind.RVALUE_REF:
      return print(type.referee, '&&' + inner);
    case TypeKind.ARRAY:
      wrapped = needsParens(inner) ? '(' + inner + ')' : inner;
      return print(type.element, wrapped + '[' + (type.size === null ? '' : type.size) + ']');
    case TypeKind.FUNCTION:
      wrapped = needsParens(inner) ? '(' + inner + ')' : inner;
      params = type.params.map(function (p) { return print(p, ''); });
      if (type.variadic) {
        params.push('...');
      }
      return print(type.returnType, wrapped + '(' + params.join(', ') + ')' +
        (type.methodConst ? ' const' : '') + (type.methodVolatile ? ' volatile' : '') +
        (type.refQualifier ? ' ' + type.refQualifier : ''));
  }
  return '<unknown type>';
}

/**
 * Spells a type as Clang does in diagnostics: `const int *`, `int &`,
 * `int (*)[3]`, `void (int, ...)`.
 *
 * @param {Object} type
 * @returns {string}
 */
function typeToString(type) {
  return print(type, '');
}

module.exports = {
  TypeKind: TypeKind,
  TypeContext: TypeContext,
  POINTER_SIZE: POINTER_SIZE,
  removeReference: removeReference,
  isVoid: isVoid,
  isNullPointer: isNullPointer,
  isBool: isBool,
  isIntegral: isIntegral,
  isFloating: isFloating,
  isArithmetic: isArithmetic,
  isEnum: isEnum,
  isScopedEnum: isScopedEnum,
  isPointer: isPointer,
  isReference: isReference,
  isArray: isArray,
  isFunction: isFunction,
  isRecord: isRecord,
  isScalar: isScalar,
  isObject: isObject,
  isSigned: isSigned,
  isUnsigned: isUnsigned,
  isComplete: isComplete,
  sizeOf: sizeOf,
  promote: promote,
  usualArithmeticConversions: usualArithmeticConversions,
  signedOfRank: signedOfRank,
  makeUnsigned: makeUnsigned,
  typeToString: typeToString
};
