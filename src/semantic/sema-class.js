'use strict';

/**
 * Semantic analysis of classes (C++11 clause 9, 11), extends
 * Sema.prototype, D-050.
 *
 * Covers class definitions, data members, member functions, `this`,
 * member access, access control, out-of-line member definitions, layout
 * and aggregate initialization. Constructors, inheritance, operators,
 * friends and static members come in the next sub-steps.
 */

var T = require('./types');
var scopes = require('./scope');
var conv = require('./conversions');
var Sema = require('./sema').Sema;

var Scope = scopes.Scope;
var ScopeKind = scopes.ScopeKind;

// ---------------------------------------------------------------------------
// Class heads.

/**
 * `class|struct|union name` followed by `{` (definition), `;` (forward
 * declaration) or a declarator (elaborated reference).
 *
 * @param {string} tag 'class', 'struct' or 'union'.
 * @param {?string} name
 * @param {string} form 'definition', 'declaration' or 'reference'.
 * @returns {?Object} The RecordDecl.
 */
Sema.prototype.actOnClassHead = function (tag, name, form, range) {
  var previous = name ? this._lookupTag(name, form !== 'reference') : null;
  var diag;
  var scope;
  if (previous && previous.kind !== 'RecordDecl') {
    this._tagMismatch(name, previous, range);
    return null;
  }
  if (previous && (previous.tag === 'union') !== (tag === 'union')) {
    this._tagMismatch(name, previous, range);
    return null;
  }
  if (previous) {
    if (form === 'definition' && previous.isDefined) {
      diag = this.error('redefinition of \'' + name + '\'', range);
      this.note(diag, 'previous definition is here', previous.range);
      return this._newRecord(tag, name, range, null);
    }
    if (form === 'definition') {
      previous.range = range;
      previous.tag = tag;
    }
    return previous;
  }
  scope = this.scope;
  if (form === 'reference') {
    // `struct S *p;` declares S in the nearest namespace or block scope
    // (C++11 3.3.2/7).
    while (scope.kind === ScopeKind.CLASS || scope.kind === ScopeKind.PROTOTYPE ||
        scope.kind === ScopeKind.ENUM) {
      scope = scope.parent;
    }
  }
  return this._newRecord(tag, name, range, scope);
};

Sema.prototype._newRecord = function (tag, name, range, declareIn) {
  var decl = this.createDecl('RecordDecl', range, {
    tag: tag,
    name: name || '',
    complete: false,
    parent: declareIn ? (declareIn.entity || this.currentContext()) : this.currentContext(),
    bases: [],
    members: []
  });
  decl.isDefined = false;
  decl.scope = new Scope(ScopeKind.CLASS, declareIn || this.scope, decl);
  this._nameTag(decl);
  if (declareIn && name) {
    declareIn.declare(name, decl);
  }
  return decl;
};

/** Opens a class body. */
Sema.prototype.actOnStartClassBody = function (decl) {
  decl.isDefined = true;
  decl.members = [];
  decl.access = decl.tag === 'class' ? 'private' : 'public';
  this.scope = decl.scope;
};

/** `public:` / `protected:` / `private:` */
Sema.prototype.actOnAccessSpecifier = function (record, access) {
  record.access = access;
};

/**
 * Closes a class body: lays the class out and marks it complete.
 */
Sema.prototype.actOnFinishClassBody = function (decl) {
  this.scope = decl.scope.parent;
  this._layout(decl);
  decl.complete = true;
  decl.isAbstract = this.pureFunctions(decl).length > 0;
  delete decl.access;
  this.declareImplicitMembers(decl);
};

// ---------------------------------------------------------------------------
// Members.

/** Innermost class being defined, or null. */
Sema.prototype.currentClass = function () {
  return this.scope.kind === ScopeKind.CLASS ? this.scope.entity : null;
};

/**
 * Declares a data member or member function from a member declarator.
 *
 * @param {Object} spec decl-specifiers.
 * @param {Object} declarator
 * @param {?Object} bitWidth Bit-field width expression.
 * @returns {?Object} FieldDecl or FunctionDecl.
 */
Sema.prototype.actOnMemberDeclarator = function (spec, declarator, bitWidth, virt) {
  var record = this.currentClass();
  var base = this.typeFromSpecifiers(spec);
  var type = this.typeFromDeclarator(base, declarator);
  var decl;
  if (!declarator.name) {
    this.error('declaration does not declare anything', declarator.range || spec.range);
    return null;
  }
  if (spec.isExplicit && !declarator.conversionType) {
    this.error('\'explicit\' can only be applied to a constructor or conversion function',
      declarator.range);
  }
  if (declarator.name === record.name && !T.isFunction(type)) {
    this.error('member \'' + declarator.name + '\' has the same name as its class',
      declarator.range);
    return null;
  }
  if (spec.isTypedef) {
    decl = this.declareTypedef(declarator.name, type, declarator.range, false);
    decl.access = record.access;
    record.members.push(decl);
    return decl;
  }
  if (T.isFunction(type)) {
    if (bitWidth) {
      this.error('bit-field \'' + declarator.name + '\' has non-integral type ' +
        this.quote(type), declarator.range);
    }
    decl = this.declareFunction(spec, declarator, type);
    decl.isMethod = true;
    decl.isStatic = spec.storage === 'static';
    decl.storage = '';
    decl.access = record.access;
    decl.parent = record;
    decl.isVirtual = !!spec.isVirtual;
    if (decl.isVirtual && decl.isStatic) {
      this.error('\'virtual\' can only appear on non-static member functions',
        declarator.range);
      decl.isVirtual = false;
    }
    this.checkOverrides(decl, record, virt || {});
    if (declarator.operatorName) {
      this.checkOperatorDeclaration(decl, declarator.operatorName, true);
    }
    if (declarator.conversionType) {
      this.checkConversionFunction(decl, declarator.conversionType);
    }
    if (decl.isStatic && (type.methodConst || type.methodVolatile)) {
      this.error('static member function cannot have \'const\' qualifier', declarator.range);
    }
    record.members.push(decl);
    return decl;
  }
  if (virt && (virt.override || virt['final'] || virt.pure)) {
    this.error(virt.pure ? 'initializer on function does not look like a pure-specifier' :
      'only virtual member functions can be marked \'' + (virt.override ? 'override' :
        'final') + '\'', declarator.range);
  }
  return this._declareField(spec, declarator, type, bitWidth, record);
};

Sema.prototype._declareField = function (spec, declarator, type, bitWidth, record) {
  var name = declarator.name;
  var previous = this.scope.lookupLocal(name);
  var decl;
  var diag;
  var width = null;
  if (spec.storage === 'static') {
    this.error('static data members are not supported yet', declarator.range);
    return null;
  }
  if (spec.storage && spec.storage !== 'mutable') {
    this.error('storage class specified for a member declaration', declarator.range);
  }
  if (spec.storage === 'mutable' && (type.isConst || T.isReference(type))) {
    this.error('\'mutable\' cannot be applied to ' + (T.isReference(type) ? 'references' :
      'const members'), declarator.range);
  }
  if (T.isRecord(type) && type.decl.complete && this.pureFunctions(type.decl).length) {
    this.checkNotAbstract(type, declarator.range, 'field');
  }
  if (!T.isComplete(type) && !T.isReference(type) && !(T.isArray(type) &&
      type.size === null)) {
    this.error('field has incomplete type ' + this.quote(type), declarator.range);
    type = this.types.builtin('int');
  } else if (T.isArray(type) && type.size === null) {
    this.error('flexible array members are not supported in C++', declarator.range);
    type = this.types.builtin('int');
  }
  if (bitWidth) {
    width = this._bitFieldWidth(name, type, bitWidth);
  }
  decl = this.createDecl('FieldDecl', declarator.range, {
    name: name,
    type: type,
    access: record.access,
    isMutable: spec.storage === 'mutable',
    parent: record,
    index: null
  });
  decl.bitWidth = bitWidth;
  decl.width = width;
  if (previous.length && !scopes.isTag(previous[0])) {
    diag = this.error('duplicate member \'' + name + '\'', declarator.range);
    this.note(diag, 'previous declaration is here', previous[0].range);
    return decl;
  }
  this.scope.declare(name, decl);
  record.members.push(decl);
  return decl;
};

Sema.prototype._bitFieldWidth = function (name, type, expr) {
  var value;
  if (!(T.isIntegral(type) || T.isEnum(type))) {
    this.error('bit-field \'' + name + '\' has non-integral type ' + this.quote(type),
      expr.range);
    return null;
  }
  value = this.evaluateConstant(expr);
  if (value === null) {
    this.error('bit-field \'' + name + '\' width is not an integral constant expression',
      expr.range);
    return null;
  }
  if (value < 0) {
    this.error('bit-field \'' + name + '\' has negative width (' + value + ')', expr.range);
    return null;
  }
  if (value > T.sizeOf(type) * 8) {
    this.error('width of bit-field \'' + name + '\' (' + value + ' bits) exceeds the width ' +
      'of its type (' + T.sizeOf(type) * 8 + ' bits)', expr.range);
    return null;
  }
  return value;
};

/** Non-static data member initializer (`int x = 1;` in a class). */
Sema.prototype.actOnFieldInit = function (field, init, style) {
  var result;
  if (!field || field.kind !== 'FieldDecl' || !init) {
    return;
  }
  if (field.width !== null && field.width !== undefined) {
    this.error('default member initializer for bit-field is a C++20 extension', init.range);
    return;
  }
  result = this.initialize(field.type, init, style, 'variable');
  field.init = result ? result.init : null;
};

// ---------------------------------------------------------------------------
// Layout (ILP32, D-036): natural alignment, like wasm32 and Windows 32.

Sema.prototype._layout = function (record) {
  var prefix = this.layoutPrefix(record);
  var offset = prefix.offset;
  var align = prefix.align;
  var bitOffset = 0;
  var unitSize = 0;
  var unitStart = 0;
  var fields = record.members.filter(function (m) { return m.kind === 'FieldDecl'; });
  var i;
  var f;
  var size;
  var fieldAlign;
  var index = 0;
  for (i = 0; i < fields.length; i++) {
    f = fields[i];
    f.index = index++;
    size = T.isReference(f.type) ? T.POINTER_SIZE : T.sizeOf(f.type);
    fieldAlign = T.isReference(f.type) ? T.POINTER_SIZE : this.alignOf(f.type);
    if (record.tag === 'union') {
      f.offset = 0;
      offset = Math.max(offset, f.width !== null && f.width !== undefined ?
        Math.ceil(f.width / 8) : size);
      align = Math.max(align, fieldAlign);
      continue;
    }
    if (f.width !== null && f.width !== undefined) {
      // Bit-fields share an allocation unit of their type while they fit.
      if (f.width === 0 || unitSize !== size || bitOffset + f.width > size * 8) {
        offset = alignUp(unitSize ? unitStart + unitSize : offset, fieldAlign);
        unitStart = offset;
        unitSize = size;
        bitOffset = 0;
      }
      f.offset = unitStart;
      f.bitOffset = bitOffset;
      bitOffset += f.width;
      align = Math.max(align, fieldAlign);
      if (f.width === 0) {
        unitSize = 0;
      }
      continue;
    }
    if (unitSize) {
      offset = unitStart + unitSize;
      unitSize = 0;
    }
    offset = alignUp(offset, fieldAlign);
    f.offset = offset;
    offset += size;
    align = Math.max(align, fieldAlign);
  }
  if (unitSize) {
    offset = unitStart + unitSize;
  }
  record.align = align;
  // An empty class still occupies one byte (C++11 9/4).
  record.size = Math.max(alignUp(offset, align), 1);
};

function alignUp(value, align) {
  return Math.ceil(value / align) * align;
}

// ---------------------------------------------------------------------------
// this and member access.

/**
 * The member function whose body is being parsed, or null.
 */
Sema.prototype.currentMethod = function () {
  var fn = this.currentFunction();
  return fn && fn.isMethod ? fn : null;
};

/** `this` (explicit or implicit). */
Sema.prototype.actOnThis = function (range, implicit) {
  var method = this.currentMethod();
  var record;
  var type;
  if (!method || method.isStatic) {
    if (!implicit) {
      this.error('invalid use of \'this\' outside of a non-static member function', range);
    }
    return null;
  }
  record = method.parent;
  type = this.types.pointer(this.types.qualified(this.types.record(record),
    method.type.methodConst, method.type.methodVolatile));
  return this._expr('ThisExpr', range, { isImplicit: !!implicit }, type, 'prvalue');
};

/**
 * Builds `object.member` (or `object->member` when `isArrow`).
 *
 * @param {Object} object Object expression (a pointer for `->`).
 * @param {string} name Member name.
 * @param {boolean} isArrow
 * @param {Object} range
 * @param {Object} nameRange
 * @returns {?Object} MemberExpr.
 */
Sema.prototype.actOnMemberAccess = function (object, name, isArrow, range, nameRange) {
  var objType;
  var record;
  var result;
  if (!object) {
    return null;
  }
  if (isArrow && T.isRecord(T.removeReference(object.type))) {
    // `p->m` on a class calls `operator->()` until it yields a pointer.
    object = this._overloadedArrow(object, range);
    if (!object) {
      return null;
    }
  }
  if (isArrow) {
    object = this.rvalue(object);
    if (!object) {
      return null;
    }
    if (!T.isPointer(object.type) || !T.isRecord(object.type.pointee)) {
      this.error('member reference type ' + this.quote(object.type) + ' is not a pointer' +
        (T.isPointer(object.type) ? ' to a structure or union' : ''), object.range);
      return null;
    }
    objType = object.type.pointee;
  } else {
    objType = object.type;
    if (!T.isRecord(objType)) {
      this.error('member reference base type ' + this.quote(objType) + ' is not a ' +
        'structure or union', object.range);
      return null;
    }
  }
  record = objType.decl;
  if (!record.complete && !this._isBeingDefined(record)) {
    this.error('member access into incomplete type ' + this.quote(objType), object.range);
    return null;
  }
  result = scopes.lookupMember(record, name);
  if (!result.decls.length) {
    this.error('no member named \'' + name + '\' in ' + this.describeQualifier(record),
      nameRange);
    return null;
  }
  if (result.ambiguous) {
    this.error('member \'' + name + '\' found in multiple base classes of different types',
      nameRange);
    return null;
  }
  return this._buildMemberExpr(object, objType, isArrow, result.decls, range, nameRange,
    record);
};

/** The object of a member of a base must be convertible to that base. */
Sema.prototype._convertObjectToBase = function (object, isArrow, base, range) {
  var type = isArrow ? object.type.pointee : object.type;
  if (!T.isRecord(type) || type.decl === base || !this.isDerivedFrom(type.decl, base)) {
    return true;
  }
  if (!this.isAccessibleBase(type.decl, base) && !this._accessContexts().some(function (c) {
    return c === type.decl;
  })) {
    this.error('cannot cast ' + this.quote(type.unqualified) + ' to its ' +
      this.basePath(type.decl, base)[0].access + ' base class ' +
      this.quote(this.types.record(base)), range);
    return false;
  }
  return true;
};

Sema.prototype._overloadedArrow = function (object, range) {
  var depth = 0;
  var result = object;
  while (T.isRecord(T.removeReference(result.type)) && depth < 32) {
    result = this.tryOverloadedOperator('->', [result], range);
    if (result === undefined) {
      this.error('member reference type ' + this.quote(object.type) + ' is not a pointer',
        object.range);
      return null;
    }
    if (!result) {
      return null;
    }
    depth++;
  }
  return result;
};

Sema.prototype._isBeingDefined = function (record) {
  var scope = this.scope;
  while (scope) {
    if (scope.entity === record) {
      return true;
    }
    scope = scope.parent;
  }
  return false;
};

/**
 * Builds a MemberExpr for a data member or a (possibly overloaded) member
 * function, checking access.
 */
Sema.prototype._buildMemberExpr = function (object, objType, isArrow, decls, range,
    nameRange, namingClass) {
  var member = decls[0];
  var objectCategory = isArrow || !object ? 'lvalue' : object.valueCategory;
  var type;
  var node;
  var methods;
  if (member.kind === 'FieldDecl') {
    if (!this.checkAccess(member, namingClass, nameRange)) {
      return null;
    }
    if (object && namingClass !== member.parent && !this._convertObjectToBase(object, isArrow,
        member.parent, nameRange)) {
      return null;
    }
    if (T.isReference(member.type)) {
      type = member.type.referee;
      objectCategory = 'lvalue';
    } else {
      type = member.isMutable ? this.types.qualified(member.type, member.type.isConst,
        member.type.isVolatile || objType.isVolatile) :
        this.types.addQualifiers(member.type, objType.isConst, objType.isVolatile);
    }
    return this._expr('MemberExpr', range, { object: object, member: member,
      isArrow: isArrow }, type, objectCategory === 'lvalue' ? 'lvalue' : 'xvalue');
  }
  if (member.kind === 'FunctionDecl') {
    methods = require('./sema-expr').uniqueFunctions(decls.filter(function (d) {
      return d.kind === 'FunctionDecl';
    }));
    node = this._expr('MemberExpr', range, { object: object, member: methods[0],
      isArrow: isArrow }, methods[0].type, 'prvalue');
    node.candidates = methods;
    node.namingClass = namingClass;
    node.nameRange = nameRange;
    return node;
  }
  if (member.kind === 'EnumeratorDecl') {
    return this._expr('DeclRefExpr', range, { decl: member }, member.type, 'prvalue');
  }
  this.error('\'' + member.name + '\' does not refer to a value', nameRange);
  return null;
};

/**
 * A data member or member function named without an object inside a
 * member function: an implicit `this->member` (C++11 9.3.1/3).
 */
Sema.prototype.implicitMemberAccess = function (decls, range, qualifier) {
  var member = decls[0];
  var self = this.actOnThis(range, true);
  var thisRecord;
  var result;
  if (!self) {
    if (member.kind === 'FieldDecl') {
      this.error('invalid use of non-static data member \'' + member.name + '\'', range);
      return null;
    }
    // Calls to non-static methods without an object are checked at the call.
    return this._buildMemberExpr(null, this.types.record(member.parent), false, decls, range,
      range, qualifier || member.parent);
  }
  thisRecord = self.type.pointee;
  result = this._buildMemberExpr(self, thisRecord, true, decls, range, range,
    qualifier || thisRecord.decl);
  if (result && qualifier) {
    // `Base::f()` calls exactly that function (no virtual dispatch).
    result.isQualified = true;
  }
  return result;
};

// ---------------------------------------------------------------------------
// Access control (C++11 clause 11).

/**
 * The class whose members (or friends) the current code belongs to.
 */
Sema.prototype._accessContexts = function () {
  var out = [];
  var scope = this.scope;
  var fn;
  while (scope) {
    if (scope.kind === ScopeKind.CLASS && scope.entity) {
      out.push(scope.entity);
    }
    if (scope.kind === ScopeKind.FUNCTION && scope.entity && scope.entity.isMethod) {
      fn = scope.entity;
      out.push(fn.parent);
    }
    scope = scope.parent;
  }
  return out;
};

/**
 * Checks that `member` is accessible from the current context.
 *
 * @param {string} [message] Replaces the default error message.
 * @returns {boolean}
 */
Sema.prototype.checkAccess = function (member, namingClass, range, message) {
  // `namingClass` matters for access through derived classes (step 5d).
  if (namingClass && namingClass !== member.parent && namingClass.bases &&
      namingClass.bases.length) {
    return this._baseAccessible(namingClass, member, range);
  }
  var contexts;
  var owner = member.parent;
  var diag;
  var i;
  if (!member.access || member.access === 'public') {
    return true;
  }
  contexts = this._accessContexts();
  for (i = 0; i < contexts.length; i++) {
    // Members of the class, and of classes nested in it, have access.
    if (contexts[i] === owner || this._isNestedIn(contexts[i], owner)) {
      return true;
    }
    if (owner.friends && owner.friends.indexOf(contexts[i]) !== -1) {
      return true;
    }
    if (member.access === 'protected' && this.isDerivedFrom(contexts[i], owner)) {
      return true;
    }
  }
  if (owner.friends && this.currentFunction() &&
      this._isFriendFunction(owner, this.currentFunction())) {
    return true;
  }
  diag = this.error(message || '\'' + member.name + '\' is a ' + member.access +
    ' member of ' + this.quote(this.types.record(owner)), range);
  this.note(diag, 'declared ' + member.access + ' here', member.range);
  return false;
};

Sema.prototype._isNestedIn = function (inner, outer) {
  var current = inner.parent;
  while (current) {
    if (current === outer) {
      return true;
    }
    current = current.parent;
  }
  return false;
};

/** Access to a member through the bases of a naming class (step 5d). */
Sema.prototype._baseAccessible = function () {
  return true;
};

/** Whether `derived` has `base` among its (direct or indirect) bases. */
Sema.prototype.isDerivedFrom = function (derived, base) {
  var i;
  var bases = derived.bases || [];
  for (i = 0; i < bases.length; i++) {
    if (bases[i].type && bases[i].type.decl &&
        (bases[i].type.decl === base || this.isDerivedFrom(bases[i].type.decl, base))) {
      return true;
    }
  }
  return false;
};

Sema.prototype._isFriendFunction = function (owner, fn) {
  var root = fn;
  while (root.previous) {
    root = root.previous;
  }
  return owner.friends.some(function (f) {
    var r = f;
    while (r.previous) {
      r = r.previous;
    }
    return r === root;
  });
};

// ---------------------------------------------------------------------------
// Member function calls.

/**
 * Conversion of the implicit object argument to the implicit object
 * parameter of a method (C++11 13.3.1/4-5): binding to `cv C&`, where cv
 * comes from the method. Dropping qualifiers is not possible.
 *
 * @returns {?Object} A conversion sequence (rank exact), or null.
 */
Sema.prototype._objectConversion = function (method, objType) {
  var fnType = method.type;
  if ((objType.isConst && !fnType.methodConst) || (objType.isVolatile &&
      !fnType.methodVolatile)) {
    return null;
  }
  return { kind: 'standard', rank: conv.RANK_EXACT, steps: [], isBoolean: false, target: null,
    reference: { lvalueRef: true, rvalueBinding: false, temporary: false,
      referee: this.types.qualified(objType.unqualified, fnType.methodConst,
        fnType.methodVolatile) } };
};

/**
 * Calls a member function through a MemberExpr callee.
 */
Sema.prototype.actOnMemberCall = function (callee, args, range) {
  var objType = callee.object ? (callee.isArrow ? callee.object.type.pointee :
    callee.object.type) : null;
  var call;
  var chosen;
  var converted;
  var method;
  if (!callee.object) {
    this.error('call to non-static member function without an object argument', range);
    return null;
  }
  chosen = this.resolveMethodOverload(callee.candidates, objType, args, range,
    callee.member.name);
  if (!chosen) {
    return null;
  }
  method = chosen.decl;
  if (!this.checkAccess(method, callee.namingClass, callee.nameRange || range)) {
    return null;
  }
  converted = chosen.args;
  call = this._expr('CallExpr', range, {
    callee: this._expr('MemberExpr', callee.range, { object: callee.object, member: method,
      isArrow: callee.isArrow, isQualified: !!callee.isQualified }, method.type, 'prvalue'),
    args: converted,
    'function': method
  }, resultTypeOf(method.type.returnType), callCategoryOf(method.type.returnType));
  call.isVirtualCall = !!method.isVirtual && !callee.isQualified;
  return call;
};

function resultTypeOf(type) {
  if (T.isReference(type)) {
    return type.referee;
  }
  return T.isRecord(type) ? type : type.unqualified;
}

function callCategoryOf(type) {
  if (type.kind === T.TypeKind.LVALUE_REF) {
    return 'lvalue';
  }
  return type.kind === T.TypeKind.RVALUE_REF ? 'xvalue' : 'prvalue';
}

// ---------------------------------------------------------------------------
// Out-of-line member definitions.

/**
 * Redirects a qualified declaration `T C::m` to the class scope of C.
 */
Sema.prototype.startClassMemberDefinition = function (record, name, range) {
  var saved = this.scope;
  // Constructors and destructors (name null) are matched by the caller.
  var found = name === null ? [null] : record.scope.lookupLocal(name);
  if (!record.complete) {
    this.error('incomplete type ' + this.quote(this.types.record(record)) + ' named in ' +
      'nested name specifier', range);
    return null;
  }
  if (!found.length) {
    this.error('out-of-line definition of \'' + name + '\' does not match any declaration in ' +
      this.describeQualifier(record), range);
    return null;
  }
  if (this.scope.kind !== ScopeKind.NAMESPACE) {
    this.error('cannot define or redeclare \'' + name + '\' here because ' +
      this.describeQualifier(record) + ' is not a namespace', range);
    return null;
  }
  this.scope = record.scope;
  return saved;
};

/**
 * Matches an out-of-line member function definition to its declaration.
 *
 * @returns {?Object} The FunctionDecl of the definition (linked to the
 *   in-class declaration through `previous`).
 */
Sema.prototype.actOnOutOfLineMethod = function (spec, declarator, type, record) {
  var candidates = record.scope.lookupLocal(declarator.name).filter(function (d) {
    return d.kind === 'FunctionDecl';
  });
  var match = null;
  var decl;
  var diag;
  var i;
  for (i = candidates.length - 1; i >= 0; i--) {
    if (sameMethodSignature(candidates[i].type, type)) {
      match = candidates[i];
      break;
    }
  }
  if (!match) {
    diag = this.error('out-of-line definition of \'' + declarator.name + '\' does not match ' +
      'any declaration in ' + this.describeQualifier(record), declarator.range);
    for (i = 0; i < candidates.length; i++) {
      this.note(diag, 'member declaration does not match because it ' +
        (candidates[i].type.methodConst !== type.methodConst ? 'is ' +
          (candidates[i].type.methodConst ? '' : 'not ') + 'const qualified' :
          'has a different signature'), candidates[i].range);
    }
    return null;
  }
  if (match.type.returnType !== type.returnType) {
    diag = this.error('return type of out-of-line definition of \'' + declarator.name +
      '\' differs from that in the declaration', declarator.range);
    this.note(diag, 'previous declaration is here', match.range);
    return null;
  }
  if (spec.storage === 'static') {
    this.error('\'static\' can only be specified inside the class definition',
      declarator.range);
  }
  if (spec.isVirtual) {
    this.error('\'virtual\' can only be specified inside the class definition',
      declarator.range);
  }
  decl = this.createDecl('FunctionDecl', declarator.range, {
    name: declarator.name,
    type: type,
    storage: '',
    isInline: !!spec.isInline,
    parent: record,
    previous: match,
    isMethod: true,
    isStatic: match.isStatic,
    isVirtual: match.isVirtual,
    access: match.access
  });
  decl.params = this._createParams(innermostParams(declarator));
  decl.methodKind = match.methodKind;
  decl.conversionType = match.conversionType;
  decl.overloadedOperator = match.overloadedOperator;
  decl.isExplicit = match.isExplicit;
  this._mergeDefaultArguments(decl, match);
  record.scope.declare(declarator.name, decl);
  return decl;
};

function sameMethodSignature(a, b) {
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

function innermostParams(declarator) {
  var d = declarator;
  var found = [];
  while (d) {
    if (d.suffixes.length && d.suffixes[0].kind === 'function') {
      found = d.suffixes[0].params;
    }
    if (d.ptrOps.length) {
      break;
    }
    d = d.nested;
  }
  return found;
}

// ---------------------------------------------------------------------------
// Aggregate initialization (C++11 8.5.1).

/**
 * Whether a class is an aggregate: no user-provided constructors, no
 * private or protected non-static data members, no base classes, no
 * virtual functions.
 */
Sema.prototype.isAggregate = function (record) {
  return !record.members.some(function (m) {
    return (m.kind === 'FieldDecl' && m.access !== 'public') ||
      (m.kind === 'FunctionDecl' && (m.isVirtual || (m.methodKind === 'constructor' &&
        !m.isImplicit)));
  }) && !(record.bases && record.bases.length);
};

/**
 * `S s = {a, b}` / `S s{a, b}` for an aggregate class: members are
 * copy-initialized in declaration order, the rest value-initialized.
 *
 * @returns {?Object} InitListExpr of the class type.
 */
Sema.prototype.aggregateInit = function (type, list) {
  var record = type.decl;
  var fields;
  var out = [];
  var i;
  var item;
  var converted;
  var result;
  if (!record.complete) {
    this.error('variable has incomplete type ' + this.quote(type), list.range);
    return null;
  }
  fields = record.members.filter(function (m) {
    return m.kind === 'FieldDecl' && m.width !== 0;
  });
  if (record.tag === 'union') {
    fields = fields.slice(0, 1);
  }
  if (list.inits.length > fields.length) {
    this.error('excess elements in ' + (record.tag === 'union' ? 'union' : 'struct') +
      ' initializer', list.inits[fields.length].range);
    return null;
  }
  for (i = 0; i < list.inits.length; i++) {
    item = list.inits[i];
    if (T.isRecord(fields[i].type) && item.kind === 'InitListExpr') {
      converted = this.initialize(fields[i].type, item, 'list', 'element');
      converted = converted ? converted.init : null;
    } else if (T.isArray(fields[i].type)) {
      result = this._arrayInit(fields[i].type, item);
      converted = result ? result.init : null;
    } else if (item.kind === 'InitListExpr') {
      converted = this._scalarListInit(item, fields[i].type);
    } else {
      converted = this.convertTo(item, fields[i].type, 'element', true);
      if (converted && !T.isReference(fields[i].type)) {
        this._checkNarrowing(item, fields[i].type);
      }
    }
    if (!converted) {
      return null;
    }
    out.push(converted);
  }
  for (i = list.inits.length; i < fields.length; i++) {
    if (T.isReference(fields[i].type)) {
      this.error('reference member \'' + fields[i].name + '\' is not initialized', list.range);
      return null;
    }
  }
  return this._expr('InitListExpr', list.range, { inits: out }, type, 'prvalue');
};

module.exports = {};
