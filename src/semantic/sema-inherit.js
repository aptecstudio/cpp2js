'use strict';

/**
 * Inheritance and virtual functions (C++11 clause 10, 11.2, 12.6.2),
 * extends Sema.prototype, D-052.
 *
 * Single inheritance only for now (D-010): multiple and virtual bases are
 * recognized and rejected with a clear error.
 */

var ast = require('../ast/nodes');
var T = require('./types');
var scopes = require('./scope');
var Sema = require('./sema').Sema;

var ACCESS_RANK = { 'private': 0, 'protected': 1, 'public': 2 };

// ---------------------------------------------------------------------------
// Base clauses.

/**
 * Adds a base-specifier to a class being defined.
 *
 * @param {Object} record
 * @param {Object} baseType Type named by the base-specifier.
 * @param {?string} access Written access, or null for the default.
 * @param {boolean} isVirtual
 * @param {Object} range
 * @returns {?Object} BaseSpecifier.
 */
Sema.prototype.actOnBaseSpecifier = function (record, baseType, access, isVirtual, range) {
  var diag;
  var base;
  if (!T.isRecord(baseType) || baseType.decl.tag === 'union') {
    this.error(T.isRecord(baseType) ? 'unions cannot be base classes' :
      'expected class name', range);
    return null;
  }
  if (record.tag === 'union') {
    this.error('unions cannot have base classes', range);
    return null;
  }
  if (!baseType.decl.complete) {
    diag = this.error('base class has incomplete type', range);
    this.note(diag, 'forward declaration of ' + this.quote(baseType), baseType.decl.range);
    return null;
  }
  if (baseType.decl === record) {
    this.error('base class has incomplete type', range);
    return null;
  }
  if (baseType.decl.isFinal) {
    diag = this.error('base ' + this.quote(baseType) + ' is marked \'final\'', range);
    this.note(diag, this.quote(baseType) + ' declared here', baseType.decl.range);
    return null;
  }
  if (isVirtual) {
    this.error('virtual base classes are not supported yet', range);
    return null;
  }
  if (record.bases.length) {
    this.error('multiple inheritance is not supported yet', range);
    return null;
  }
  base = ast.createNode('BaseSpecifier', range, {
    type: baseType.unqualified,
    access: access || (record.tag === 'class' ? 'private' : 'public'),
    isVirtual: false
  });
  record.bases.push(base);
  record.isPolymorphic = !!baseType.decl.isPolymorphic;
  return base;
};

/** Chain of base specifiers from `derived` down to `base`, or null. */
Sema.prototype.basePath = function (derived, base) {
  var i;
  var rest;
  var bases = derived.bases || [];
  for (i = 0; i < bases.length; i++) {
    if (bases[i].type.decl === base) {
      return [bases[i]];
    }
    rest = this.basePath(bases[i].type.decl, base);
    if (rest) {
      return [bases[i]].concat(rest);
    }
  }
  return null;
};

// ---------------------------------------------------------------------------
// Access through inheritance (C++11 11.2).

/**
 * Access of `member` as a member of `namingClass`, following the base
 * chain: private members of a base are inaccessible ('none'), others take
 * the more restrictive of their access and the inheritance access.
 *
 * @returns {{access: string, constrainedBy: ?Object}}
 */
Sema.prototype.effectiveAccess = function (member, namingClass) {
  var path = namingClass === member.parent ? [] : this.basePath(namingClass, member.parent);
  var access = member.access || 'public';
  var constrainedBy = null;
  var i;
  if (!path) {
    return { access: access, constrainedBy: null };
  }
  for (i = path.length - 1; i >= 0; i--) {
    if (access === 'private' || access === 'none') {
      access = 'none';
      continue;
    }
    if (ACCESS_RANK[path[i].access] < ACCESS_RANK[access]) {
      access = path[i].access;
      constrainedBy = path[i];
    }
  }
  return { access: access, constrainedBy: constrainedBy };
};

/**
 * Replaces the step-5b placeholder: checks access through the bases of
 * the naming class.
 */
Sema.prototype._baseAccessible = function (namingClass, member, range) {
  var eff = this.effectiveAccess(member, namingClass);
  var contexts = this._accessContexts();
  var i;
  var diag;
  if (eff.access === 'public') {
    return true;
  }
  if (this._isFriendOf(eff.access === 'none' ? member.parent : namingClass, contexts)) {
    return true;
  }
  for (i = 0; i < contexts.length; i++) {
    if (eff.access === 'none' && (contexts[i] === member.parent ||
        this._isNestedIn(contexts[i], member.parent))) {
      return true;
    }
    if (eff.access !== 'none' && (contexts[i] === namingClass ||
        this._isNestedIn(contexts[i], namingClass) ||
        (eff.access === 'protected' && this.isDerivedFrom(contexts[i], namingClass)))) {
      return true;
    }
  }
  if (eff.access === 'none') {
    diag = this.error('\'' + member.name + '\' is a private member of ' +
      this.quote(this.types.record(member.parent)), range);
    this.note(diag, 'declared private here', member.range);
    return false;
  }
  diag = this.error('\'' + member.name + '\' is a ' + eff.access + ' member of ' +
    this.quote(this.types.record(eff.constrainedBy ? member.parent : namingClass)), range);
  this.note(diag, eff.constrainedBy ? 'constrained by ' + eff.constrainedBy.access +
    ' inheritance here' : 'declared ' + eff.access + ' here', eff.constrainedBy ?
    eff.constrainedBy.range : member.range);
  return false;
};

/** Whether the current context is a friend of `record`. */
Sema.prototype._isFriendOf = function (record, contexts) {
  var fn = this.currentFunction();
  if (!record.friends) {
    return false;
  }
  if (contexts.some(function (c) { return record.friends.indexOf(c) !== -1; })) {
    return true;
  }
  return !!fn && this._isFriendFunction(record, fn);
};

/**
 * Whether `base` is an accessible base of `derived` from the current
 * context (needed for derived-to-base conversions, 4.10/3, 11.2/4).
 */
Sema.prototype.isAccessibleBase = function (derived, base) {
  var path = this.basePath(derived, base);
  var contexts = this._accessContexts();
  var i;
  var j;
  var ok;
  if (!path) {
    return false;
  }
  for (i = 0; i < path.length; i++) {
    if (path[i].access === 'public') {
      continue;
    }
    ok = false;
    for (j = 0; j < contexts.length && !ok; j++) {
      // The base is accessible to members of the class that inherits it
      // (and, for protected, of classes derived from it).
      ok = contexts[j] === (i === 0 ? derived : path[i - 1].type.decl) ||
        (path[i].access === 'protected' && this.isDerivedFrom(contexts[j],
          i === 0 ? derived : path[i - 1].type.decl));
    }
    if (!ok) {
      return false;
    }
  }
  return true;
};

/**
 * Checks a derived-to-base conversion between types (pointers or
 * objects): the base must be accessible (C++11 4.10/3).
 */
Sema.prototype.checkBaseConversion = function (fromType, toType, range) {
  var from = T.isPointer(fromType) ? fromType.pointee : fromType;
  var to = T.isPointer(toType) ? toType.pointee : T.removeReference(toType);
  if (!T.isRecord(from) || !T.isRecord(to) || from.decl === to.decl) {
    return true;
  }
  if (!this.isAccessibleBase(from.decl, to.decl)) {
    this.error('cannot cast ' + this.quote(from.unqualified) + ' to its ' +
      this.basePath(from.decl, to.decl)[0].access + ' base class ' +
      this.quote(to.unqualified), range);
    return false;
  }
  return true;
};

// ---------------------------------------------------------------------------
// Virtual functions.

/**
 * Called when a member function is declared in a class: finds the base
 * functions it overrides, makes it virtual if any is, checks `override`,
 * `final` and the return type.
 */
Sema.prototype.checkOverrides = function (method, record, specifiers) {
  var overridden = [];
  var bases = record.bases || [];
  var i;
  var found;
  var self = this;
  var diag;
  method.isOverride = !!specifiers.override;
  method.isFinal = !!specifiers.final;
  method.isPure = !!specifiers.pure;
  if (method.methodKind === 'constructor') {
    return;
  }
  for (i = 0; i < bases.length; i++) {
    found = method.methodKind === 'destructor' ? this._baseDestructor(bases[i].type.decl) :
      this._findOverridden(bases[i].type.decl, method);
    if (found) {
      overridden.push(found);
    }
  }
  overridden.forEach(function (base) {
    if (!base.isVirtual) {
      return;
    }
    method.isVirtual = true;
    if (base.isFinal) {
      diag = self.error('declaration of \'' + method.name + '\' overrides a \'final\' function',
        method.range);
      self.note(diag, 'overridden virtual function is here', base.range);
    }
    self._checkCovariance(method, base);
  });
  method.overrides = overridden.filter(function (b) { return b.isVirtual; });
  if (method.isOverride && !method.overrides.length) {
    this.error('\'' + method.name + '\' marked \'override\' but does not override any member ' +
      'functions', method.range);
  } else if (method.isFinal && !method.isVirtual) {
    // `final` may end any virtual function, even one that overrides nothing.
    this.error('only virtual member functions can be marked \'final\'', method.range);
  }
  if (method.isPure && !method.isVirtual) {
    this.error('\'' + method.name + '\' is not virtual and cannot be declared pure',
      method.range);
    method.isPure = false;
  }
  if (method.isVirtual) {
    record.isPolymorphic = true;
  }
};

/** The virtual-or-not function of `base` (or its bases) with the same signature. */
Sema.prototype._findOverridden = function (base, method) {
  var candidates = scopes.lookupMember(base, method.name).decls;
  var i;
  for (i = 0; i < candidates.length; i++) {
    if (candidates[i].kind === 'FunctionDecl' && !candidates[i].isStatic &&
        sameParameters(candidates[i].type, method.type)) {
      return candidates[i];
    }
  }
  return null;
};

Sema.prototype._baseDestructor = function (base) {
  while (base) {
    if (base.destructor) {
      return base.destructor;
    }
    base = base.bases && base.bases.length ? base.bases[0].type.decl : null;
  }
  return null;
};

function sameParameters(a, b) {
  var i;
  if (a.params.length !== b.params.length || a.variadic !== b.variadic ||
      a.methodConst !== b.methodConst || a.methodVolatile !== b.methodVolatile ||
      a.refQualifier !== b.refQualifier) {
    return false;
  }
  for (i = 0; i < a.params.length; i++) {
    if (a.params[i] !== b.params[i]) {
      return false;
    }
  }
  return true;
}

/**
 * Return types of an overrider must match, or be covariant (C++11
 * 10.3/7): pointers or references to classes, the derived one derived
 * from the base one, no more cv-qualified.
 */
Sema.prototype._checkCovariance = function (method, base) {
  var a = method.type.returnType;
  var b = base.type.returnType;
  var diag;
  var ok = a === b;
  if (!ok && ((T.isPointer(a) && T.isPointer(b)) || (a.kind === b.kind && T.isReference(a)))) {
    a = T.isPointer(a) ? a.pointee : a.referee;
    b = T.isPointer(b) ? b.pointee : b.referee;
    ok = T.isRecord(a) && T.isRecord(b) && (a.decl === b.decl ||
      this.isDerivedFrom(a.decl, b.decl)) && (b.isConst || !a.isConst) &&
      (b.isVolatile || !a.isVolatile);
  }
  if (!ok) {
    diag = this.error('virtual function \'' + method.name + '\' has a different return type (' +
      this.quote(method.type.returnType) + ') than the function it overrides (which has ' +
      'return type ' + this.quote(base.type.returnType) + ')', method.range);
    this.note(diag, 'overridden virtual function is here', base.range);
  }
};

/**
 * Pure virtual functions without a final overrider make a class abstract
 * (C++11 10.4).
 *
 * @returns {Array.<Object>} The unimplemented pure functions.
 */
Sema.prototype.pureFunctions = function (record) {
  var own = record.members.filter(function (m) {
    return m.kind === 'FunctionDecl' && m.isPure;
  });
  var inherited = [];
  var bases = record.bases || [];
  var self = this;
  bases.forEach(function (b) {
    self.pureFunctions(b.type.decl).forEach(function (p) {
      var overriders = record.members.filter(function (m) {
        return m.kind === 'FunctionDecl' && m.overrides && m.overrides.some(function (o) {
          return o === p || self._overridesTransitively(o, p);
        });
      });
      if (!overriders.length) {
        inherited.push(p);
      }
    });
  });
  return own.concat(inherited);
};

Sema.prototype._overridesTransitively = function (fn, target) {
  var self = this;
  return (fn.overrides || []).some(function (o) {
    return o === target || self._overridesTransitively(o, target);
  });
};

/** Reports an attempt to create an object of an abstract class. */
Sema.prototype.checkNotAbstract = function (type, range, what) {
  var pure;
  var diag;
  var self = this;
  if (!T.isRecord(type) || !type.decl.complete) {
    return true;
  }
  pure = this.pureFunctions(type.decl);
  if (!pure.length) {
    return true;
  }
  diag = this.error((what === 'new' ? 'allocating an object of abstract class type ' :
    'variable type ') + this.quote(type.unqualified) + (what === 'new' ? '' :
    ' is an abstract class'), range);
  pure.forEach(function (p) {
    self.note(diag, 'unimplemented pure virtual method \'' + p.name + '\' in ' +
      self.quote(self.types.record(p.parent)), p.range);
  });
  return false;
};

// ---------------------------------------------------------------------------
// Base initializers and implicit members with bases.

/**
 * `Base(args)` in a constructor's initializer list.
 *
 * @returns {?Object} CtorInitializer, or null if `name` is not a base.
 */
Sema.prototype.baseInitializer = function (ctor, name, args, style, range) {
  var record = ctor.parent;
  var info = this.classifyName(name);
  var bases = record.bases || [];
  var base = null;
  var i;
  var init;
  var node;
  if (info.kind !== 'type' || !T.isRecord(info.type)) {
    return null;
  }
  for (i = 0; i < bases.length; i++) {
    if (bases[i].type.decl === info.type.decl) {
      base = bases[i];
    }
  }
  if (!base) {
    return null;
  }
  for (i = 0; i < ctor.ctorInits.length; i++) {
    if (ctor.ctorInits[i].base === base) {
      this.error('multiple initializations given for base ' + this.quote(base.type), range);
      return ast.createNode('CtorInitializer', range, {});
    }
  }
  // An abstract base is constructed as a subobject, which is allowed.
  this._constructingSubobject = true;
  try {
    init = this.construct(base.type, args, style === 'list' ? 'list' : 'direct', range);
  } finally {
    this._constructingSubobject = false;
  }
  node = ast.createNode('CtorInitializer', range, { base: base, args: init ? [init] : [] });
  ctor.ctorInits.push(node);
  return node;
};

/** Bases without an initializer need a usable default constructor. */
Sema.prototype.checkBaseInitializers = function (ctor) {
  var record = ctor.parent;
  var self = this;
  (record.bases || []).forEach(function (b) {
    var initialized = ctor.ctorInits.some(function (i) { return i.base === b; });
    if (!initialized && !self._hasUsableDefaultConstructor(b.type.decl)) {
      self.error('constructor for ' + self.quote(self.types.record(record)) + ' must ' +
        'explicitly initialize the base class ' + self.quote(b.type) + ' which does not have ' +
        'a default constructor', ctor.range);
    }
  });
};

/**
 * Layout prefix contributed by bases and the virtual table pointer:
 * the base subobject comes first (empty bases take no space); a class
 * that introduces virtual functions starts with a 4-byte vptr.
 *
 * @returns {{offset: number, align: number}}
 */
Sema.prototype.layoutPrefix = function (record) {
  var base = record.bases && record.bases.length ? record.bases[0].type.decl : null;
  var offset = 0;
  var align = 1;
  if (base) {
    if (!isEmptyClass(base)) {
      offset = base.size;
      align = base.align;
    }
    record.hasVtablePointer = !!base.hasVtablePointer || (!!record.isPolymorphic &&
      !base.isPolymorphic);
    if (record.isPolymorphic && !base.isPolymorphic) {
      // The vptr goes before the base subobject.
      offset = Math.ceil((4 + offset) / Math.max(align, 4)) * Math.max(align, 4);
      align = Math.max(align, 4);
    }
  } else if (record.isPolymorphic) {
    record.hasVtablePointer = true;
    offset = 4;
    align = 4;
  }
  return { offset: offset, align: align };
};

function isEmptyClass(record) {
  return !record.isPolymorphic && !record.members.some(function (m) {
    return m.kind === 'FieldDecl';
  }) && !(record.bases || []).some(function (b) { return !isEmptyClass(b.type.decl); });
}

module.exports = {
  isEmptyClass: isEmptyClass
};
