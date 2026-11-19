'use strict';

/**
 * Constructors, destructors, special member functions and the
 * initialization of class objects (C++11 12.1, 12.4, 12.6, 12.8, 8.5),
 * extends Sema.prototype, D-051.
 *
 * Objects are JavaScript references at run time (D-018), so every copy of
 * a class object must be explicit in the AST: initializing an object from
 * a glvalue of its class becomes a `ConstructExpr` calling the copy (or
 * move) constructor, and assignment calls the copy (or move) assignment
 * operator. Prvalues initialize objects directly (copy elision).
 */

var ast = require('../ast/nodes');
var T = require('./types');
var Sema = require('./sema').Sema;

// ---------------------------------------------------------------------------
// Declarations of constructors and destructors.

/**
 * Declares a constructor or destructor from a member declarator whose
 * declarator-id is the class name (or `~` + class name).
 *
 * @param {Object} record
 * @param {Object} spec decl-specifiers (no type).
 * @param {Object} declarator
 * @param {string} kind 'constructor' or 'destructor'.
 * @returns {?Object} FunctionDecl.
 */
Sema.prototype.actOnConstructorDeclarator = function (record, spec, declarator, kind, virt) {
  var suffix = declarator.suffixes[0];
  var type;
  var decl;
  var diag;
  var existing;
  var i;
  if (!suffix || suffix.kind !== 'function' || declarator.suffixes.length > 1 ||
      declarator.ptrOps.length) {
    this.error('expected \'(\' after ' + kind + ' name', declarator.range);
    return null;
  }
  if (kind === 'destructor' && suffix.params.length) {
    this.error('destructor cannot have any parameters', declarator.range);
  }
  if (suffix.isConst || suffix.isVolatile) {
    this.error('\'const\' qualifier is not allowed on a ' + kind, declarator.range);
  }
  if (spec.storage === 'static') {
    this.error(kind + ' cannot be declared \'static\'', declarator.range);
  }
  if (kind === 'constructor' && spec.isVirtual) {
    this.error('constructor cannot be declared \'virtual\'', declarator.range);
  }
  if (suffix.trailingReturn) {
    this.error(kind + ' cannot have a return type', declarator.range);
  }
  type = this.types.func(this.types.builtin('void'),
    suffix.params.map(function (p) { return p.type; }).map(this.types.adjustParameter,
      this.types), { variadic: suffix.variadic });
  existing = kind === 'destructor' ? (record.destructor ? [record.destructor] : []) :
    (record.constructors || []);
  for (i = 0; i < existing.length; i++) {
    if (existing[i].type === type) {
      diag = this.error(kind === 'destructor' ? 'destructor cannot be redeclared' :
        'constructor cannot be redeclared', declarator.range);
      this.note(diag, 'previous declaration is here', existing[i].range);
      return null;
    }
  }
  decl = this.createDecl('FunctionDecl', declarator.range, {
    name: (kind === 'destructor' ? '~' : '') + record.name,
    type: type,
    storage: '',
    isInline: !!spec.isInline,
    isConstexpr: !!spec.isConstexpr,
    parent: record,
    isMethod: true,
    isStatic: false,
    isVirtual: !!spec.isVirtual,
    isExplicit: !!spec.isExplicit,
    access: record.access,
    methodKind: kind,
    params: [],
    ctorInits: []
  });
  decl.params = this._createParams(suffix.params);
  if (spec.isExplicit && kind !== 'constructor') {
    this.error('\'explicit\' can only be applied to a constructor', declarator.range);
  }
  if (kind === 'destructor') {
    record.destructor = decl;
    this.checkOverrides(decl, record, virt || {});
  } else {
    record.constructors = (record.constructors || []).concat([decl]);
    if (virt && (virt.override || virt['final'] || virt.pure)) {
      this.error('constructor cannot be declared \'' + (virt.pure ? 'pure' : virt.override ?
        'override' : 'final') + '\'', declarator.range);
    }
  }
  record.members.push(decl);
  return decl;
};

/**
 * Out-of-line definition of a constructor or destructor: it must match a
 * declaration in the class.
 *
 * @returns {?Object} The definition, linked to the declaration through
 *   `previous`.
 */
Sema.prototype.actOnOutOfLineConstructor = function (record, spec, declarator, kind) {
  var suffix = declarator.suffixes[0];
  var type = this.types.func(this.types.builtin('void'),
    suffix.params.map(function (p) { return p.type; }).map(this.types.adjustParameter,
      this.types), { variadic: suffix.variadic });
  var candidates = kind === 'destructor' ? (record.destructor ? [record.destructor] : []) :
    (record.constructors || []);
  var match = null;
  var decl;
  var i;
  for (i = 0; i < candidates.length; i++) {
    if (candidates[i].type === type && !candidates[i].isImplicit) {
      match = candidates[i];
    }
  }
  if (!match) {
    this.error('out-of-line definition of \'' + (kind === 'destructor' ? '~' : '') +
      record.name + '\' does not match any declaration in ' + this.describeQualifier(record),
      declarator.range);
    return null;
  }
  if (spec.isExplicit || spec.isVirtual) {
    this.error('\'' + (spec.isExplicit ? 'explicit' : 'virtual') + '\' can only be specified ' +
      'inside the class definition', declarator.range);
  }
  decl = this.createDecl('FunctionDecl', declarator.range, {
    name: match.name,
    type: type,
    storage: '',
    isInline: !!spec.isInline,
    parent: record,
    previous: match,
    isMethod: true,
    isStatic: false,
    isVirtual: match.isVirtual,
    isExplicit: match.isExplicit,
    access: match.access,
    methodKind: kind,
    params: [],
    ctorInits: []
  });
  decl.params = this._createParams(suffix.params);
  this._mergeDefaultArguments(decl, match);
  return decl;
};

/** `= default;` and `= delete;` (C++11 8.4.2, 8.4.3). */
Sema.prototype.actOnDefaultedOrDeleted = function (decl, isDelete, range) {
  if (!decl || decl.kind !== 'FunctionDecl') {
    return;
  }
  if (isDelete) {
    if (decl.previous) {
      this.error('deleted definition must be first declaration', range);
      return;
    }
    decl.isDeleted = true;
    return;
  }
  if (!this._isSpecialMember(decl)) {
    this.error('only special member functions may be defaulted', range);
    return;
  }
  decl.isDefaulted = true;
};

/** Kind of special member function a method is, or null. */
Sema.prototype._isSpecialMember = function (decl) {
  var record = decl.parent;
  var params = decl.type.params;
  var selfRef;
  if (!decl.isMethod) {
    return null;
  }
  if (decl.methodKind === 'destructor') {
    return 'destructor';
  }
  if (decl.methodKind === 'constructor') {
    if (!params.length) {
      return 'default';
    }
    if (params.length === 1 && T.isReference(params[0]) &&
        params[0].referee.unqualified === this.types.record(record)) {
      return params[0].kind === T.TypeKind.LVALUE_REF ? 'copy' : 'move';
    }
    return null;
  }
  if (decl.name === 'operator=' && params.length === 1) {
    selfRef = params[0];
    if (T.isReference(selfRef) && selfRef.referee.unqualified === this.types.record(record)) {
      return selfRef.kind === T.TypeKind.LVALUE_REF ? 'copy-assign' : 'move-assign';
    }
  }
  return null;
};

// ---------------------------------------------------------------------------
// Implicit special member functions (C++11 12.1/5, 12.4/4, 12.8).

/**
 * Declares the implicit special members a completed class gets, marking
 * them deleted when its members require it.
 */
Sema.prototype.declareImplicitMembers = function (record) {
  var ctors = record.constructors || [];
  var classType = this.types.record(record);
  var constRef = this.types.lvalueReference(this.types.qualified(classType, true, false));
  var rref = this.types.rvalueReference(classType);
  var selfRef = this.types.lvalueReference(classType);
  var assigns = record.scope.lookupLocal('operator=').filter(function (d) {
    return d.kind === 'FunctionDecl';
  });
  var self = this;
  var has = { copy: false, move: false, 'copy-assign': false, 'move-assign': false };
  // Base subobjects take part like members of their class type.
  var fields = record.members.filter(function (m) { return m.kind === 'FieldDecl'; })
    .concat((record.bases || []).map(function (b) { return { type: b.type, init: null }; }));
  var decl;
  var userMove;
  var noImplicitMove;
  ctors.concat(assigns).forEach(function (d) {
    var kind = self._isSpecialMember(d);
    if (kind && has.hasOwnProperty(kind)) {
      has[kind] = true;
    }
  });
  userMove = has.move || has['move-assign'];
  // No implicit move operations when the class declares copy operations,
  // move operations or a destructor (C++11 12.8/9, /20).
  noImplicitMove = has.copy || has['copy-assign'] || userMove ||
    !!(record.destructor && !record.destructor.isImplicit);

  if (!ctors.length) {
    decl = this._implicitMember(record, 'constructor', 'default', this.types.builtin('void'), []);
    decl.isDeleted = this._defaultCtorDeleted(record, fields);
  }
  if (!has.copy) {
    decl = this._implicitMember(record, 'constructor', 'copy', this.types.builtin('void'),
      [constRef]);
    decl.isDeleted = userMove || this._copyDeleted(fields, 'copy');
  }
  if (!noImplicitMove && !has.move) {
    decl = this._implicitMember(record, 'constructor', 'move', this.types.builtin('void'),
      [rref]);
    decl.isDeleted = this._copyDeleted(fields, 'copy');
  }
  if (!has['copy-assign']) {
    decl = this._implicitMember(record, 'operator', 'copy-assign', selfRef, [constRef]);
    decl.isDeleted = userMove || this._assignDeleted(fields);
  }
  if (!noImplicitMove && !has['move-assign']) {
    decl = this._implicitMember(record, 'operator', 'move-assign', selfRef, [rref]);
    decl.isDeleted = this._assignDeleted(fields);
  }
  if (!record.destructor) {
    decl = this._implicitMember(record, 'destructor', 'destructor',
      this.types.builtin('void'), []);
    this.checkOverrides(decl, record, {});
  }
};

Sema.prototype._implicitMember = function (record, methodKind, special, returnType, params) {
  var self = this;
  var decl = this.createDecl('FunctionDecl', record.range, {
    name: methodKind === 'operator' ? 'operator=' : (methodKind === 'destructor' ? '~' : '') +
      record.name,
    type: this.types.func(returnType, params),
    storage: '',
    isInline: true,
    parent: record,
    isMethod: true,
    isStatic: false,
    isVirtual: false,
    access: 'public',
    methodKind: methodKind === 'operator' ? 'operator' : methodKind,
    params: [],
    ctorInits: []
  });
  decl.params = params.map(function (type, index) {
    return self.createDecl('ParamDecl', record.range, { name: null, type: type, index: index });
  });
  decl.isImplicit = true;
  decl.special = special;
  decl.isDefaulted = true;
  if (methodKind === 'destructor') {
    record.destructor = decl;
  } else if (methodKind === 'constructor') {
    record.constructors = (record.constructors || []).concat([decl]);
  } else {
    record.scope.declare('operator=', decl);
  }
  return decl;
};

/** Implicit default constructor is deleted (C++11 12.1/5). */
Sema.prototype._defaultCtorDeleted = function (record, fields) {
  var self = this;
  return fields.some(function (f) {
    if (f.init) {
      return false;
    }
    if (T.isReference(f.type)) {
      return true;
    }
    if (f.type.isConst && !T.isRecord(f.type)) {
      return true;
    }
    if (T.isRecord(f.type)) {
      return !self._hasUsableDefaultConstructor(f.type.decl);
    }
    return false;
  });
};

Sema.prototype._hasUsableDefaultConstructor = function (record) {
  var ctors = record.constructors || [];
  return ctors.some(function (c) {
    var required = c.params.length;
    while (required > 0 && c.params[required - 1].defaultArg) {
      required--;
    }
    return required === 0 && !c.isDeleted;
  });
};

Sema.prototype._copyDeleted = function (fields, which) {
  return fields.some(function (f) {
    var ctors;
    // An rvalue reference member deletes the copy constructor (12.8/11).
    if (f.type.kind === T.TypeKind.RVALUE_REF && which === 'copy') {
      return true;
    }
    if (!T.isRecord(f.type)) {
      return false;
    }
    ctors = f.type.decl.constructors || [];
    return ctors.some(function (c) {
      return c.special === which && c.isDeleted;
    }) || !ctors.some(function (c) {
      return c.params.length === 1 && T.isReference(c.type.params[0]) &&
        c.type.params[0].kind === T.TypeKind.LVALUE_REF && !c.isDeleted;
    });
  });
};

Sema.prototype._assignDeleted = function (fields) {
  return fields.some(function (f) {
    var assigns;
    if (T.isReference(f.type) || (f.type.isConst && !T.isRecord(f.type))) {
      return true;
    }
    if (!T.isRecord(f.type)) {
      return false;
    }
    assigns = f.type.decl.scope.lookupLocal('operator=');
    return !assigns.some(function (a) {
      return a.kind === 'FunctionDecl' && !a.isDeleted;
    });
  });
};

// ---------------------------------------------------------------------------
// Member initializer lists (C++11 12.6.2).

/**
 * One `name(args)` / `name{args}` of a constructor's initializer list.
 *
 * @returns {?Object} CtorInitializer.
 */
Sema.prototype.actOnMemberInitializer = function (ctor, name, args, style, range) {
  var record = ctor.parent;
  var found = record.scope.lookupLocal(name);
  var field = null;
  var init;
  var i;
  var diag;
  var node;
  node = this.baseInitializer(ctor, name, args, style, range);
  if (node) {
    return node;
  }
  if (name === record.name) {
    // Delegating constructor (C++11 12.6.2/6).
    if (ctor.ctorInits.length) {
      this.error('an initializer for a delegating constructor must appear alone', range);
      return null;
    }
    init = this.construct(this.types.record(record), args, style === 'list' ? 'list' :
      'direct', range);
    node = ast.createNode('CtorInitializer', range, { args: init ? [init] : [],
      isDelegating: true });
    ctor.ctorInits.push(node);
    return node;
  }
  for (i = 0; i < found.length; i++) {
    if (found[i].kind === 'FieldDecl') {
      field = found[i];
    }
  }
  if (!field) {
    this.error('member initializer \'' + name + '\' does not name a non-static data member or ' +
      'base class', range);
    return null;
  }
  for (i = 0; i < ctor.ctorInits.length; i++) {
    if (ctor.ctorInits[i].member === field) {
      diag = this.error('multiple initializations given for non-static member \'' + name + '\'',
        range);
      this.note(diag, 'previous initialization is here', ctor.ctorInits[i].range);
      return null;
    }
    if (ctor.ctorInits[i].isDelegating) {
      this.error('an initializer for a delegating constructor must appear alone', range);
      return null;
    }
  }
  init = this._initializeMember(field, args, style, range);
  node = ast.createNode('CtorInitializer', range, { member: field, args: init ? [init] : [] });
  ctor.ctorInits.push(node);
  return node;
};

/** Initializes a member from `(args)` or `{args}`. */
Sema.prototype._initializeMember = function (field, args, style, range) {
  var list = this._expr('InitListExpr', range, { inits: args }, null, 'prvalue');
  var result;
  if (T.isRecord(field.type)) {
    return this.construct(field.type.unqualified, args, style === 'list' ? 'list' : 'direct',
      range);
  }
  if (T.isArray(field.type)) {
    if (style !== 'list') {
      this.error('array initializer must be an initializer list', range);
      return null;
    }
    result = this._arrayInit(field.type, list);
    return result ? result.init : null;
  }
  if (style === 'list') {
    return this._scalarListInit(list, field.type);
  }
  if (!args.length) {
    return this.actOnValueInit(field.type.unqualified, range);
  }
  if (args.length > 1) {
    this.error('excess elements in scalar initializer', args[1].range);
    return null;
  }
  return this.convertTo(args[0], field.type, 'variable');
};

/**
 * After the initializer list: reference and const members must be
 * initialized, by the list or by a default member initializer.
 */
Sema.prototype.actOnFinishMemberInitializers = function (ctor) {
  var record = ctor.parent;
  var self = this;
  var initialized = ctor.ctorInits.map(function (i) { return i.member; });
  if (ctor.ctorInits.some(function (i) { return i.isDelegating; })) {
    return;
  }
  this.checkBaseInitializers(ctor);
  record.members.forEach(function (f) {
    if (f.kind !== 'FieldDecl' || f.init || initialized.indexOf(f) !== -1) {
      return;
    }
    if (T.isReference(f.type)) {
      self.note(self.error('constructor for ' + self.quote(self.types.record(record)) +
        ' must explicitly initialize the reference member \'' + f.name + '\'', ctor.range),
        'declared here', f.range);
    } else if (f.type.isConst && !T.isRecord(f.type)) {
      self.note(self.error('constructor for ' + self.quote(self.types.record(record)) +
        ' must explicitly initialize the const member \'' + f.name + '\'', ctor.range),
        'declared here', f.range);
    } else if (T.isRecord(f.type) && !self._hasUsableDefaultConstructor(f.type.decl)) {
      self.error('constructor for ' + self.quote(self.types.record(record)) +
        ' must explicitly initialize the member \'' + f.name + '\' which does not have a ' +
        'default constructor', ctor.range);
    }
  });
};

// ---------------------------------------------------------------------------
// Construction of class objects.

/**
 * Initializes an object of class type `type` with constructor arguments.
 *
 * @param {Object} type cv-unqualified record type.
 * @param {Array.<Object>} args
 * @param {string} style 'default', 'direct', 'copy' (one argument),
 *   'list' or 'copy-list'.
 * @param {Object} range
 * @returns {?Object} ConstructExpr (or InitListExpr for aggregates).
 */
Sema.prototype.construct = function (type, args, style, range) {
  var record = type.decl;
  var candidates;
  var chosen;
  var list;
  if (!record.complete) {
    this.error('variable has incomplete type ' + this.quote(type), range);
    return null;
  }
  if (record.isAbstract && !this._constructingSubobject && !this.checkNotAbstract(type,
      range, this._constructionContext || 'new')) {
    return null;
  }
  if ((style === 'list' || style === 'copy-list') && this.isAggregate(record)) {
    list = this._expr('InitListExpr', range, { inits: args }, null, 'prvalue');
    return this.aggregateInit(type, list);
  }
  if (style === 'copy' && args.length === 1 && args[0].type &&
      args[0].type.unqualified === type && args[0].valueCategory === 'prvalue') {
    // A prvalue of the same class initializes the object directly.
    return args[0];
  }
  candidates = (record.constructors || []).filter(function (c) {
    // Explicit constructors are not candidates in copy-initialization.
    return !(style === 'copy' && c.isExplicit);
  });
  chosen = this.resolveConstructor(candidates, args, range, type, style === 'copy' &&
    args.length === 1 && args[0].type && args[0].type.unqualified !== type ? args[0] : null);
  if (!chosen) {
    return null;
  }
  if (style === 'copy-list' && chosen.decl.isExplicit) {
    this.note(this.error('chosen constructor is explicit in copy-initialization', range),
      'explicit constructor declared here', chosen.decl.range);
    return null;
  }
  return this._expr('ConstructExpr', range, { constructorDecl: chosen.decl, args: chosen.args,
    isListInit: style === 'list' || style === 'copy-list' }, type, 'prvalue');
};

/**
 * Overload resolution among constructors, with Clang's messages.
 */
Sema.prototype.resolveConstructor = function (candidates, args, range, type, converted) {
  var checked = [];
  var viable = [];
  var best;
  var diag;
  var i;
  var j;
  var c;
  for (i = 0; i < candidates.length; i++) {
    c = this._checkCandidate(candidates[i], args);
    checked.push(c);
    if (c.viable) {
      viable.push(c);
    }
  }
  if (!viable.length) {
    // Copy-initialization from another type is a conversion for Clang.
    diag = converted ? this.error('no viable conversion from ' + this.quote(converted.type) +
      ' to ' + this.quote(type), range) :
      this.error('no matching constructor for initialization of ' + this.quote(type), range);
    for (i = 0; i < checked.length; i++) {
      this.note(diag, 'candidate constructor' + (checked[i].decl.isImplicit ? ' (the implicit ' +
        specialName(checked[i].decl.special) + ')' : '') + ' not viable: ' + checked[i].reason,
        checked[i].decl.range);
    }
    return null;
  }
  best = null;
  for (i = 0; i < viable.length && !best; i++) {
    for (j = 0; j < viable.length; j++) {
      if (i !== j && !this._candidateBetter(viable[i], viable[j])) {
        break;
      }
    }
    if (j === viable.length) {
      best = viable[i];
    }
  }
  if (!best) {
    diag = this.error('call to constructor of ' + this.quote(type) + ' is ambiguous', range);
    for (i = 0; i < viable.length; i++) {
      this.note(diag, 'candidate constructor', viable[i].decl.range);
    }
    return null;
  }
  if (best.decl.isDeleted) {
    diag = this.error('call to ' + (best.decl.isImplicit ? 'implicitly-deleted ' : 'deleted ') +
      (best.decl.isImplicit ? specialName(best.decl.special) : 'constructor') + ' of ' +
      this.quote(type), range);
    this.note(diag, best.decl.isImplicit ? 'implicitly deleted here' :
      '\'' + best.decl.parent.name + '\' has been explicitly marked deleted here',
      best.decl.range);
    return null;
  }
  if (!this._constructorAccessible(best.decl, range)) {
    return null;
  }
  return { decl: best.decl, args: this._applyCandidate(best, args, range) };
};

/** Access check for constructors, with Clang's wording. */
Sema.prototype._constructorAccessible = function (ctor, range) {
  return this.checkAccess(ctor, ctor.parent, range, 'calling a ' + ctor.access +
    ' constructor of class ' + this.quote(this.types.record(ctor.parent)));
};

function specialName(special) {
  return { 'default': 'default constructor', copy: 'copy constructor',
    move: 'move constructor', 'copy-assign': 'copy assignment operator',
    'move-assign': 'move assignment operator', destructor: 'destructor' }[special] ||
    'constructor';
}

/**
 * Default-initialization of a variable of class type (`S s;`).
 */
Sema.prototype.defaultConstruct = function (type, range) {
  return this.construct(type.unqualified, [], 'default', range);
};

/**
 * Copy of a class object from a glvalue of the same class, used by the
 * conversion machinery (`ConstructorConversion` step).
 */
Sema.prototype.copyObject = function (expr, type) {
  return this.construct(type.unqualified, [expr], 'direct', expr.range);
};

/**
 * Assignment between objects of the same class: calls the copy or move
 * assignment operator.
 */
Sema.prototype.assignObject = function (left, right, range) {
  var record = left.type.decl;
  var candidates = record.scope.lookupLocal('operator=').filter(function (d) {
    return d.kind === 'FunctionDecl';
  });
  var chosen = this.resolveMethodOverload(candidates, left.type, [right], range, 'operator=');
  if (!chosen) {
    return null;
  }
  if (chosen.decl.isDeleted) {
    this.note(this.error('object of type ' + this.quote(left.type) + ' cannot be assigned ' +
      'because its ' + specialName(chosen.decl.special || 'copy-assign') + ' is ' +
      (chosen.decl.isImplicit ? 'implicitly deleted' : 'deleted'), range),
      chosen.decl.isImplicit ? 'implicitly deleted here' : 'deleted here', chosen.decl.range);
    return null;
  }
  return this._expr('BinaryExpr', range, { operator: '=', left: left, right: chosen.args[0],
    'function': chosen.decl }, left.type, 'lvalue');
};

/** Deleted functions may not be called (C++11 8.4.3/2). */
Sema.prototype.checkNotDeleted = function (decl, range) {
  if (decl && decl.isDeleted) {
    this.note(this.error('call to deleted function \'' + decl.name + '\'', range),
      'candidate function has been explicitly deleted', decl.range);
    return false;
  }
  return true;
};

module.exports = {};
