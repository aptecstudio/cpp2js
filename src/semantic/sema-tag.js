'use strict';

/**
 * Semantic analysis of tag declarations: enumerations (C++11 7.2) now,
 * classes in the next sub-steps (extends Sema.prototype), D-049.
 */

var T = require('./types');
var I = require('../util/int64');
var scopes = require('./scope');
var constant = require('./constant');
var Sema = require('./sema').Sema;

var Scope = scopes.Scope;
var ScopeKind = scopes.ScopeKind;

/** Candidate underlying types of an enumeration without a fixed one. */
var UNDERLYING_CANDIDATES = ['int', 'unsigned int', 'long long', 'unsigned long long'];

/**
 * Looks up a tag name for an elaborated type specifier or a tag
 * declaration in the current scope only (`local`) or outwards.
 */
Sema.prototype._lookupTag = function (name, local) {
  var decls = local ? scopes.applyTagHiding(this.scope.lookupLocal(name), true) :
    scopes.lookupUnqualified(this.scope, name, { tagsOnly: true }).decls;
  return decls.length ? decls[0] : null;
};

/** Sets the printable qualified name used in type spellings (D-039). */
Sema.prototype._nameTag = function (decl) {
  decl.qualifiedName = decl.name ? this.qualifiedName(decl) : '(anonymous ' +
    (decl.kind === 'EnumDecl' ? 'enum' : decl.tag) + ')';
};

/**
 * `enum [class] name [: type]` followed by `{` (definition), `;` (opaque
 * declaration) or a declarator (elaborated reference).
 *
 * @param {?string} name
 * @param {boolean} scoped `enum class` / `enum struct`.
 * @param {?Object} underlying Fixed underlying type, if written.
 * @param {string} form 'definition', 'declaration' or 'reference'.
 * @param {Object} range Range of the name (or of `enum`).
 * @returns {?Object} The EnumDecl.
 */
Sema.prototype.actOnEnumHead = function (name, scoped, underlying, form, range) {
  var previous = name ? this._lookupTag(name, form !== 'reference') : null;
  var decl;
  var diag;
  if (underlying && !T.isIntegral(underlying)) {
    this.error('non-integral type ' + this.quote(underlying) + ' is an invalid underlying ' +
      'type', range);
    underlying = this.types.builtin('int');
  }
  if (underlying) {
    underlying = underlying.unqualified;
  }
  if (form === 'reference') {
    if (previous && previous.kind === 'EnumDecl') {
      return previous;
    }
    if (previous) {
      this._tagMismatch(name, previous, range);
      return null;
    }
    this.error('ISO C++ forbids forward references to \'enum\' types', range);
    return null;
  }
  if (previous && previous.kind !== 'EnumDecl') {
    this._tagMismatch(name, previous, range);
    previous = null;
  }
  if (previous) {
    if (previous.scoped !== scoped) {
      diag = this.error('enumeration previously declared as ' + (previous.scoped ? 'scoped' :
        'unscoped'), range);
      this.note(diag, 'previous declaration is here', previous.range);
    } else if ((underlying || scoped ? (underlying || this.types.builtin('int')) : null) !==
        (previous.fixedUnderlying ? previous.underlyingType : null)) {
      diag = previous.fixedUnderlying ?
        this.error('enumeration redeclared with different underlying type ' +
          this.quote(underlying || this.types.builtin('int')) + ' (was ' +
          this.quote(previous.underlyingType) + ')', range) :
        this.error('enumeration previously declared with nonfixed underlying type', range);
      this.note(diag, 'previous declaration is here', previous.range);
    } else if (form === 'definition' && previous.isDefined) {
      diag = this.error('redefinition of \'' + name + '\'', range);
      this.note(diag, 'previous definition is here', previous.range);
      return this._newEnum(name, scoped, underlying, range, false);
    }
    if (form === 'definition') {
      previous.range = range;
    }
    return previous;
  }
  if (!scoped && !underlying && form === 'declaration') {
    this.error('ISO C++ forbids forward references to \'enum\' types', range);
  }
  return this._newEnum(name, scoped, underlying, range, true);
};

Sema.prototype._newEnum = function (name, scoped, underlying, range, declare) {
  var fixed = !!underlying || scoped;
  var decl = this.createDecl('EnumDecl', range, {
    name: name || '',
    scoped: scoped,
    underlyingType: underlying || (scoped ? this.types.builtin('int') : null),
    fixedUnderlying: fixed,
    // An enumeration with a fixed underlying type is complete at once
    // (C++11 7.2/3).
    complete: fixed,
    parent: this.currentContext(),
    enumerators: []
  });
  decl.size = fixed ? T.sizeOf(decl.underlyingType) : null;
  decl.isDefined = false;
  decl.scope = new Scope(ScopeKind.ENUM, this.scope, decl);
  this._nameTag(decl);
  if (declare && name) {
    this.scope.declare(name, decl);
  }
  return decl;
};

Sema.prototype._tagMismatch = function (name, previous, range) {
  var diag = scopes.isTag(previous) ?
    this.error('use of \'' + name + '\' with tag type that does not match previous ' +
      'declaration', range) :
    this.error('redefinition of \'' + name + '\' as different kind of symbol', range);
  this.note(diag, 'previous ' + (scopes.isTag(previous) ? 'use' : 'definition') + ' is here',
    previous.range);
};

/** Opens the body of an enumeration definition. */
Sema.prototype.actOnStartEnumBody = function (decl) {
  decl.isDefined = true;
  decl.enumerators = [];
  decl._next = I.ZERO;
  decl._nextType = decl.fixedUnderlying ? decl.underlyingType : this.types.builtin('int');
  this.scope = decl.scope;
};

/**
 * `name [= constant-expression]` inside an enumeration body.
 *
 * @returns {?Object} The EnumeratorDecl.
 */
Sema.prototype.actOnEnumerator = function (decl, name, init, range) {
  var value;
  var type;
  var converted = null;
  var enumerator;
  var previous;
  var diag;
  var raw;
  var rawValue;
  var parentScope = decl.scope.parent;
  if (init) {
    converted = decl.fixedUnderlying ? this.convertTo(init, decl.underlyingType, 'variable',
      true) : this.rvalue(init);
    if (converted && !(T.isIntegral(converted.type) || T.isEnum(converted.type))) {
      this.error('expression is not an integral constant expression', init.range);
      converted = null;
    }
    value = converted ? constant.evaluate(this, converted) : null;
    if (converted && value === null) {
      this.error('expression is not an integral constant expression', init.range);
    }
    if (value !== null && decl.fixedUnderlying) {
      // The range is checked on the value before conversion.
      raw = this.rvalue(init);
      rawValue = raw ? constant.evaluate(this, raw) : null;
      if (rawValue !== null) {
        this._checkEnumeratorRange(init, rawValue, raw.type, decl.underlyingType);
      }
      value = constant.truncate(value, decl.underlyingType);
    }
    type = decl.fixedUnderlying ? decl.underlyingType : converted ?
      T.promote(this.types, converted.type.unqualified) : this.types.builtin('int');
    if (T.isEnum(type)) {
      type = T.promote(this.types, type);
    }
  }
  if (value === undefined || value === null) {
    value = decl._next;
    type = decl._nextType;
    if (!init && decl.enumerators.length && this._overflowsAfterPrevious(decl, value, type)) {
      if (decl.fixedUnderlying) {
        this.error('enumerator value is not representable in the underlying type ' +
          this.quote(decl.underlyingType), range);
      } else {
        type = this._widerEnumeratorType(value);
      }
    }
  }
  enumerator = this.createDecl('EnumeratorDecl', range, { name: name, init: converted,
    value: value, type: type, parent: decl });
  decl.enumerators.push(enumerator);
  decl._next = I.add(value, I.ONE);
  decl._nextType = type;

  previous = decl.scope.lookupLocal(name);
  if (!previous.length && !decl.scoped) {
    previous = parentScope.lookupLocal(name).filter(function (d) {
      return !scopes.isTag(d);
    });
  }
  if (previous.length) {
    diag = this.error(previous[0].kind === 'EnumeratorDecl' ?
      'redefinition of enumerator \'' + name + '\'' :
      'redefinition of \'' + name + '\' as different kind of symbol', range);
    this.note(diag, 'previous definition is here', previous[0].range);
    return enumerator;
  }
  decl.scope.declare(name, enumerator);
  if (!decl.scoped) {
    // Unscoped enumerators are also members of the enclosing scope.
    parentScope.declare(name, enumerator);
  }
  return enumerator;
};

/**
 * The implicit value `previous + 1` must still fit the type used so far.
 */
Sema.prototype._overflowsAfterPrevious = function (decl, value, type) {
  var size = T.sizeOf(type);
  if (size === 8) {
    return T.isUnsigned(type) ? I.isZero(value) : I.eq(value, I.MIN_SIGNED);
  }
  return !I.eq(constant.truncate(value, type), value) ||
    (T.isUnsigned(type) && I.isNegative(value));
};

/** Smallest of long long / unsigned long long holding `value`. */
Sema.prototype._widerEnumeratorType = function (value) {
  return this.types.builtin(I.isNegative(value) ? 'unsigned long long' : 'long long');
};

Sema.prototype._checkEnumeratorRange = function (init, value, fromType, underlying) {
  var fromSigned = !T.isUnsigned(fromType) && !T.isBool(fromType);
  if (I.toString(value, fromSigned) !==
      I.toString(constant.truncate(value, underlying), !T.isUnsigned(underlying) &&
        !T.isBool(underlying))) {
    this.error('enumerator value ' + I.toString(value, fromSigned) + ' is not representable in ' +
      'the underlying type ' + this.quote(underlying), init.range);
  }
};

/**
 * Closes an enumeration definition: chooses the underlying type when not
 * fixed (the first of int, unsigned int, long long, unsigned long long
 * holding every value, as GCC does), then gives every enumerator the
 * enumeration type (C++11 7.2/5).
 */
Sema.prototype.actOnFinishEnumBody = function (decl, range) {
  var enumType = this.types.enumeration(decl);
  var i;
  this.scope = decl.scope.parent;
  if (!decl.fixedUnderlying) {
    decl.underlyingType = this._chooseUnderlying(decl, range);
    decl.size = T.sizeOf(decl.underlyingType);
  }
  for (i = 0; i < decl.enumerators.length; i++) {
    decl.enumerators[i].value = constant.truncate(decl.enumerators[i].value,
      decl.underlyingType);
    decl.enumerators[i].type = enumType;
  }
  decl.complete = true;
  delete decl._next;
  delete decl._nextType;
};

Sema.prototype._chooseUnderlying = function (decl, range) {
  var i;
  var j;
  var candidate;
  var fits;
  var e;
  var signed;
  for (i = 0; i < UNDERLYING_CANDIDATES.length; i++) {
    candidate = this.types.builtin(UNDERLYING_CANDIDATES[i]);
    fits = true;
    for (j = 0; j < decl.enumerators.length && fits; j++) {
      e = decl.enumerators[j];
      signed = !T.isUnsigned(e.type) && !T.isBool(e.type);
      fits = I.toString(e.value, signed) === I.toString(constant.truncate(e.value, candidate),
        !T.isUnsigned(candidate));
    }
    if (fits) {
      return candidate;
    }
  }
  this.error('enumeration values exceed range of largest integer', range);
  return this.types.builtin('long long');
};

module.exports = {};
