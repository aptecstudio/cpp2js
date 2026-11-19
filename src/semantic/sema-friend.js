'use strict';

/**
 * Friends and static members (C++11 11.3, 9.4), extends Sema.prototype,
 * D-054.
 */

var T = require('./types');
var scopes = require('./scope');
var Sema = require('./sema').Sema;

var ScopeKind = scopes.ScopeKind;

/** Nearest namespace scope enclosing the current scope. */
Sema.prototype._enclosingNamespaceScope = function () {
  var scope = this.scope;
  while (scope.kind !== ScopeKind.NAMESPACE) {
    scope = scope.parent;
  }
  return scope;
};

/**
 * `friend class X;` / `friend X;`: X's members may access the private and
 * protected members of `record`.
 */
Sema.prototype.actOnFriendClass = function (record, type, range) {
  if (!T.isRecord(type)) {
    this.error('friend declaration does not name a class', range);
    return;
  }
  record.friends = (record.friends || []).concat([type.decl]);
};

/**
 * `friend R f(params);` (possibly with a definition): the function belongs
 * to the innermost enclosing namespace (C++11 7.3.1.2/3) and may access
 * the members of `record`.
 *
 * @returns {?Object} The FunctionDecl.
 */
Sema.prototype.actOnFriendFunction = function (record, spec, declarator) {
  var saved = this.scope;
  var type = this.typeFromDeclarator(this.typeFromSpecifiers(spec), declarator);
  var decl;
  if (!T.isFunction(type)) {
    this.error('friends can only be classes or functions', declarator.range);
    return null;
  }
  if (declarator.qualifier) {
    this.error('friend member functions of other classes are not supported yet',
      declarator.range);
    return null;
  }
  this.scope = this._enclosingNamespaceScope();
  try {
    spec = Object.create(spec);
    spec.isFriend = false;
    decl = this.declareFunction(spec, declarator, type);
    if (declarator.operatorName) {
      this.checkOperatorDeclaration(decl, declarator.operatorName, false);
    }
  } finally {
    this.scope = saved;
  }
  decl.friendOf = record;
  record.friends = (record.friends || []).concat([decl]);
  return decl;
};

// ---------------------------------------------------------------------------
// Static data members.

/**
 * `static T name [= init];` inside a class.
 *
 * @returns {?Object} VarDecl marked `isStaticMember`.
 */
Sema.prototype.actOnStaticDataMember = function (record, spec, declarator, type) {
  var previous = this.scope.lookupLocal(declarator.name);
  var decl;
  var diag;
  var scope = this.scope.parent;
  while (scope && scope.kind !== ScopeKind.NAMESPACE) {
    if (scope.kind === ScopeKind.FUNCTION || scope.kind === ScopeKind.BLOCK) {
      this.error('static data member \'' + declarator.name + '\' not allowed in local class ' +
        this.quote(this.types.record(record)), declarator.range);
      return null;
    }
    scope = scope.parent;
  }
  decl = this.createDecl('VarDecl', declarator.range, {
    name: declarator.name,
    type: type,
    storage: 'static',
    isConstexpr: !!spec.isConstexpr,
    parent: record
  });
  decl.isStaticMember = true;
  decl.access = record.access;
  if (previous.length && !scopes.isTag(previous[0])) {
    diag = this.error('duplicate member \'' + declarator.name + '\'', declarator.range);
    this.note(diag, 'previous declaration is here', previous[0].range);
    return decl;
  }
  this.scope.declare(declarator.name, decl);
  record.members.push(decl);
  return decl;
};

/**
 * In-class initializer of a static data member: only for const integral
 * or enumeration types, or constexpr (C++11 9.4.2/3).
 */
Sema.prototype.actOnStaticMemberInit = function (decl, init, style) {
  var result;
  if (!decl || !init) {
    return;
  }
  if (!decl.isConstexpr && !(decl.type.isConst && (T.isIntegral(decl.type) ||
      T.isEnum(decl.type)))) {
    this.error('non-const static data member must be initialized out of line', init.range);
    return;
  }
  result = this.initialize(decl.type, init, style, 'variable');
  decl.init = result ? result.init : null;
  decl.initStyle = style;
  if (decl.init && this.evaluateConstant(decl.init) === null && (T.isIntegral(decl.type) ||
      T.isEnum(decl.type))) {
    this.error('in-class initializer for static data member is not a constant expression',
      init.range);
  }
};

/**
 * Out-of-line definition `T S::name [= init];` of a static data member.
 *
 * @returns {?Object} The defining VarDecl (with `previous`).
 */
Sema.prototype.actOnStaticMemberDefinition = function (record, spec, declarator, type) {
  var found = record.scope.lookupLocal(declarator.name).filter(function (d) {
    return d.kind === 'VarDecl' && d.isStaticMember;
  });
  var match = found[0];
  var decl;
  var diag;
  if (!match) {
    this.error('out-of-line definition of \'' + declarator.name + '\' does not match any ' +
      'declaration in ' + this.describeQualifier(record), declarator.range);
    return null;
  }
  if (spec.storage === 'static') {
    this.error('\'static\' can only be specified inside the class definition',
      declarator.range);
  }
  if (match.type !== type && !(T.isArray(match.type) && T.isArray(type) &&
      match.type.size === null && match.type.element === type.element)) {
    diag = this.error('redefinition of \'' + declarator.name + '\' with a different type: ' +
      this.quote(type) + ' vs ' + this.quote(match.type), declarator.range);
    this.note(diag, 'previous declaration is here', match.range);
    return null;
  }
  if (match.definition) {
    diag = this.error('redefinition of \'' + declarator.name + '\'', declarator.range);
    this.note(diag, 'previous definition is here', match.definition.range);
    return null;
  }
  decl = this.createDecl('VarDecl', declarator.range, {
    name: declarator.name,
    type: type,
    storage: '',
    parent: record,
    previous: match
  });
  decl.isStaticMember = true;
  decl.access = match.access;
  match.definition = decl;
  return decl;
};

module.exports = {};
