'use strict';

/**
 * Class parsing (extends Parser.prototype), C++11 clause 9, D-050.
 *
 * Member function bodies defined inside a class are a complete-class
 * context (C++11 9.2/2): they may use members declared later. The parser
 * skips them and parses them when the outermost enclosing class is
 * complete, by moving back to their saved token position.
 */

var Parser = require('./parser').Parser;
var TokenKind = require('../lexer/lexer').TokenKind;
var T = require('../semantic/types');

var ACCESS_WORDS = { 'public': true, 'protected': true, 'private': true };

/**
 * Whether a declarator declares a function (not a pointer to one): the
 * innermost declarator holding the name decides; suffixes bind tighter
 * than pointer operators, and an empty level defers to the enclosing one.
 */
function isFunctionDeclarator(declarator) {
  var chain = [];
  var d = declarator;
  var i;
  while (d) {
    chain.push(d);
    d = d.nested;
  }
  for (i = chain.length - 1; i >= 0; i--) {
    if (chain[i].suffixes.length) {
      return chain[i].suffixes[0].kind === 'function';
    }
    if (chain[i].ptrOps.length) {
      return false;
    }
  }
  return false;
}

/**
 * class-specifier or elaborated class reference inside a
 * decl-specifier-seq. A definition or declaration is recorded in
 * `spec.tagDecl`.
 *
 * @returns {Object} The class type (int after an error).
 */
Parser.prototype.parseClassSpecifier = function (spec) {
  var keyword = this.next();
  var nameTok = null;
  var form;
  var decl;
  var isFinal = false;
  this.rejectAttributes(this.parseAttributes(), 'classes');
  if (this.isPunct('::') || (this.peek().kind === TokenKind.IDENTIFIER &&
      this.isPunct('::', 1))) {
    this.fail('qualified class names are not supported yet');
  }
  if (this.peek().kind === TokenKind.IDENTIFIER) {
    nameTok = this.next();
  }
  if (nameTok && this.isPunct('<') && this.sema._classInstantiationTarget) {
    // Replaying a partial specialization: its pattern was matched already.
    this._skipAngleGroup();
  }
  if (this.peek().kind === TokenKind.IDENTIFIER && this.peek().value === 'final' &&
      (this.isPunct('{', 1) || this.isPunct(':', 1))) {
    this.next();
    isFinal = true;
  }
  if (this.isPunct('{') || this.isPunct(':')) {
    form = 'definition';
  } else if (this.isPunct(';') && nameTok && !spec.isFriend) {
    form = 'declaration';
  } else if (!nameTok) {
    this.fail('declaration of anonymous ' + keyword.value + ' must be a definition');
  } else {
    form = 'reference';
  }
  if (form === 'definition' && !nameTok) {
    this.fail('anonymous ' + keyword.value + 's are not supported yet');
  }
  decl = this.sema.actOnClassHead(keyword.value, nameTok ? nameTok.value : null, form,
    this.rangeOf(nameTok || keyword));
  if (!decl) {
    if (form === 'definition') {
      this._skipTo('{');
      this._skipBraces();
    }
    return this.sema.types.builtin('int');
  }
  if (form !== 'reference') {
    spec.tagDecl = decl;
  }
  if (form === 'definition') {
    decl.isFinal = isFinal;
    if (this.isPunct(':')) {
      this.withRecoveryUntilBrace(function () {
        this.parseBaseClause(decl);
      });
    }
    this.parseClassBody(decl);
  }
  return this.sema.types.record(decl);
};

/** `: [virtual] [access] class-name, ...` (C++11 10). */
Parser.prototype.parseBaseClause = function (record) {
  var access;
  var isVirtual;
  var start;
  var scan;
  this.next();
  for (;;) {
    access = null;
    isVirtual = false;
    start = this.peek();
    for (;;) {
      if (this.acceptKeyword('virtual')) {
        isVirtual = true;
      } else if (this.peek().kind === TokenKind.KEYWORD && ACCESS_WORDS[this.peek().value] &&
          !access) {
        access = this.next().value;
      } else {
        break;
      }
    }
    scan = this._scanQualifiedName(0);
    if (!scan || scan.error || scan.info.kind !== 'type') {
      this.fail(scan && scan.info.kind === 'unknown' ? 'unknown class name \'' + scan.name +
        '\'' : 'expected class name');
    }
    this._skip(scan.length);
    this.sema.actOnBaseSpecifier(record, scan.info.type, access, isVirtual,
      this.rangeFrom(start));
    if (!this.acceptPunct(',')) {
      break;
    }
  }
};

/** `override`, `final` and `= 0` after a member function declarator. */
Parser.prototype._parseVirtSpecifiers = function () {
  var specs = { override: false, 'final': false, pure: false };
  var tok;
  for (;;) {
    tok = this.peek();
    if (tok.kind === TokenKind.IDENTIFIER && (tok.value === 'override' ||
        tok.value === 'final')) {
      this.next();
      specs[tok.value] = true;
    } else {
      break;
    }
  }
  if (this.isPunct('=') && this.peek(1).kind === TokenKind.INTEGER &&
      this.peek(1).text === '0') {
    this.next();
    this.next();
    specs.pure = true;
  }
  return specs;
};

/** `{ member-specification }` */
Parser.prototype.parseClassBody = function (decl) {
  var open = this.expectPunct('{');
  var self = this;
  var delayed;
  var i;
  this._classDepth = (this._classDepth || 0) + 1;
  this._delayedBodies = this._delayedBodies || [];
  this.sema.actOnStartClassBody(decl);
  try {
    while (!this.isPunct('}') && this.peek().kind !== TokenKind.EOF) {
      this.withRecovery(function () {
        self.parseMemberDeclaration(decl);
      });
    }
    this.expectPunct('}', '', open);
  } finally {
    this.sema.actOnFinishClassBody(decl);
    this._classDepth--;
  }
  if (this._classDepth === 0) {
    delayed = this._delayedBodies;
    this._delayedBodies = [];
    for (i = 0; i < delayed.length; i++) {
      this._parseDelayedBody(delayed[i]);
    }
  }
};

/** Parses a member function body saved while its class was incomplete. */
Parser.prototype._parseDelayedBody = function (item) {
  var savedPos = this._pos;
  var savedScope = this.sema.scope;
  var self = this;
  this._pos = item.pos;
  this.sema.scope = item.scope || item.decl.parent.scope;
  try {
    this.withRecovery(function () {
      self.parseFunctionBody(item.decl);
    });
  } finally {
    this.sema.scope = savedScope;
    this._pos = savedPos;
  }
};

/**
 * member-declaration: access specifier, nested types, typedefs, data
 * members, member functions (declarations and inline definitions).
 */
Parser.prototype.parseMemberDeclaration = function (record) {
  var tok = this.peek();
  var spec;
  var declarator;
  var decl;
  var bitWidth;
  var virt;
  var first = true;
  if (tok.kind === TokenKind.KEYWORD && ACCESS_WORDS[tok.value] && this.isPunct(':', 1)) {
    this.next();
    this.next();
    this.sema.actOnAccessSpecifier(record, tok.value);
    return;
  }
  if (this.acceptPunct(';')) {
    return;
  }
  this.rejectAttributes(this.parseAttributes(), 'members');
  if (this.isKeyword('using')) {
    if (this.peek(1).kind === TokenKind.IDENTIFIER && this.isPunct('=', 2)) {
      this._memberAccess(this.parseAliasDeclaration(), record);
      return;
    }
    this.fail('using-declarations in classes are not supported yet');
  }
  if (this.isKeyword('static_assert')) {
    record.members.push(this.parseStaticAssert());
    return;
  }
  if (this.isKeyword('template')) {
    this.parseMemberTemplate(record);
    return;
  }
  if (this._startsConstructor(record)) {
    this._parseConstructorMember(record);
    return;
  }
  if (this._startsConversionFunction()) {
    this._parseConversionMember(record);
    return;
  }
  spec = this.parseDeclSpecifiers();
  if (spec.isFriend) {
    this._parseFriend(record, spec);
    return;
  }
  if (spec.missingSemi || this.acceptPunct(';')) {
    if (spec.tagDecl) {
      this._memberAccess(spec.tagDecl, record);
      return;
    }
    this.diagnostics.warning('declaration does not declare anything', spec.range);
    return;
  }
  for (;;) {
    declarator = this.parseDeclarator(false);
    bitWidth = null;
    if (this.isPunct(':') && declarator.suffixes.length &&
        declarator.suffixes[0].kind === 'function' && !declarator.nested) {
      this.diagnostics.error('only constructors take base initializers',
        this.rangeOf(this.peek()));
      this._skipFunctionBody();
      return;
    }
    if (this.acceptPunct(':')) {
      bitWidth = this.parseConstantExpression();
    }
    // `= 0` is a pure-specifier only after a function declarator.
    virt = isFunctionDeclarator(declarator) ? this._parseVirtSpecifiers() : {};
    decl = this.sema.actOnMemberDeclarator(spec, declarator, bitWidth, virt);
    if (decl && decl.kind === 'FunctionDecl' && this.isPunct('{') && first) {
      // Parsed when the outermost class is complete (or when used, in a
      // class template instantiation).
      if (!this._deferTemplateBody(decl, record.scope)) {
        this._delayedBodies.push({ decl: decl, pos: this._pos });
      }
      this._skipBraces();
      return;
    }
    if (this.isPunct('=') && (this.isKeyword('default', 1) || this.isKeyword('delete', 1))) {
      this.next();
      this.sema.actOnDefaultedOrDeleted(decl, this.next().value === 'delete',
        this.rangeOf(this.peek(-1)));
    } else if ((this.isPunct('=') || this.isPunct('{')) && decl && decl.kind === 'VarDecl') {
      this._parseStaticMemberInitializer(decl);
    } else if (this.isPunct('=') || this.isPunct('{')) {
      this._parseMemberInitializer(decl);
    }
    first = false;
    if (!this.acceptPunct(',')) {
      break;
    }
  }
  this.expectSemi('at end of declaration list');
};

Parser.prototype._memberAccess = function (decl, record) {
  if (decl && !decl.access) {
    decl.access = record.access;
  }
};

/** `= initializer` or `{ initializer }` of a data member (C++11 9.2/4). */
Parser.prototype._parseMemberInitializer = function (decl) {
  var init;
  var style;
  if (this.acceptPunct('=')) {
    if (decl && decl.kind === 'FunctionDecl') {
      this.fail('pure, deleted and defaulted functions are not supported yet');
    }
    style = 'copy';
    init = this.isPunct('{') ? this.parseBracedInitList() : this.parseAssignmentExpression();
  } else {
    style = 'list';
    init = this.parseBracedInitList();
  }
  this.sema.actOnFieldInit(decl, init, style);
};

// ---------------------------------------------------------------------------
// Constructors and destructors (C++11 12.1, 12.4).

var CONSTRUCTOR_SPECIFIERS = { 'explicit': true, 'inline': true, 'constexpr': true,
  'virtual': true };

/**
 * Whether a member declaration declares a constructor (`S(...)`) or a
 * destructor (`~S(...)`) of `record`, after optional specifiers.
 */
Parser.prototype._startsConstructor = function (record) {
  var i = 0;
  while (this.peek(i).kind === TokenKind.KEYWORD && CONSTRUCTOR_SPECIFIERS[this.peek(i).value]) {
    i++;
  }
  if (this.peek(i).kind === TokenKind.IDENTIFIER && this.peek(i).value === record.name &&
      this.isPunct('(', i + 1)) {
    return true;
  }
  return this.isPunct('~', i) && this.peek(i + 1).kind === TokenKind.IDENTIFIER &&
    this.peek(i + 1).value === record.name && this.isPunct('(', i + 2);
};

/** Reads `explicit`, `inline`, `constexpr`, `virtual` before a constructor. */
Parser.prototype._parseConstructorSpecifiers = function () {
  var spec = { builtins: [], namedType: null, storage: '', isExplicit: false, isInline: false,
    isConstexpr: false, isVirtual: false, range: this.rangeOf(this.peek()) };
  var tok;
  while (this.peek().kind === TokenKind.KEYWORD && CONSTRUCTOR_SPECIFIERS[this.peek().value]) {
    tok = this.next();
    spec['is' + tok.value.charAt(0).toUpperCase() + tok.value.slice(1)] = true;
  }
  return spec;
};

/** Builds the declarator of a constructor or destructor at the name. */
Parser.prototype._constructorDeclarator = function () {
  var isDestructor = !!this.acceptPunct('~');
  var nameTok = this.next();
  var declarator = { ptrOps: [], name: nameTok.value, nameToken: nameTok, qualifier: null,
    nested: null, suffixes: [this.parseFunctionSuffix()], range: this.rangeOf(nameTok) };
  return { declarator: declarator, kind: isDestructor ? 'destructor' : 'constructor' };
};

Parser.prototype._parseConstructorMember = function (record) {
  var spec = this._parseConstructorSpecifiers();
  var parsed = this._constructorDeclarator();
  var virt = this._parseVirtSpecifiers();
  var decl = this.sema.actOnConstructorDeclarator(record, spec, parsed.declarator, parsed.kind,
    virt);
  if (this.isPunct('=') && (this.isKeyword('default', 1) || this.isKeyword('delete', 1))) {
    this.next();
    this.sema.actOnDefaultedOrDeleted(decl, this.next().value === 'delete',
      this.rangeOf(this.peek(-1)));
    this.expectSemi('at end of declaration list');
    return;
  }
  if (this.isPunct(':') || this.isPunct('{')) {
    if (decl && !this._deferTemplateBody(decl, record.scope)) {
      this._delayedBodies.push({ decl: decl, pos: this._pos });
    }
    this._skipFunctionBody();
    return;
  }
  this.expectSemi('at end of declaration list');
};

/**
 * Skips an optional ctor-initializer and the function body (both are
 * parsed later, when the class is complete).
 */
Parser.prototype._skipFunctionBody = function () {
  if (this.acceptPunct(':')) {
    for (;;) {
      while (this.peek().kind === TokenKind.IDENTIFIER || this.isPunct('::')) {
        this.next();
      }
      if (this.isPunct('(')) {
        this.next();
        this._skipBalanced();
      } else if (this.isPunct('{')) {
        this._skipBraces();
      } else {
        this.fail('expected \'(\' or \'{\'');
      }
      if (!this.acceptPunct(',')) {
        break;
      }
    }
  }
  if (!this.isPunct('{')) {
    this.fail('expected function body after function declarator');
  }
  this._skipBraces();
};

/**
 * `: mem-initializer, ...` of a constructor definition, parsed in the
 * scope of the constructor's parameters (C++11 12.6.2).
 */
Parser.prototype.parseMemberInitializers = function (ctor) {
  var colon = this.next();
  var nameTok;
  var open;
  var args;
  var style;
  if (ctor.methodKind !== 'constructor') {
    this.diagnostics.error('only constructors take base initializers', this.rangeOf(colon));
  }
  for (;;) {
    nameTok = this.peek();
    if (nameTok.kind !== TokenKind.IDENTIFIER) {
      this.fail('expected class member or base class name');
    }
    this.next();
    if (this.isPunct('{')) {
      args = this.parseBracedInitList().inits;
      style = 'list';
    } else {
      open = this.expectPunct('(', 'or \'{\' after member initializer name');
      args = this.isPunct(')') ? [] : this.parseExpressionList();
      this.expectPunct(')', '', open);
      style = 'direct';
    }
    if (ctor.methodKind === 'constructor' && args.indexOf(null) === -1) {
      this.sema.actOnMemberInitializer(ctor, nameTok.value, args, style,
        this.rangeFrom(nameTok));
    }
    if (!this.acceptPunct(',')) {
      break;
    }
  }
};

/**
 * Out-of-line constructor or destructor definition at namespace scope:
 * `S::S(int x) : a(x) {}`, `S::~S() {}`, `S::S() = default;`.
 *
 * @returns {?Array.<Object>} null if the tokens do not start one.
 */
Parser.prototype.parseOutOfLineConstructor = function () {
  var i = 0;
  var j;
  var templateId;
  var tok;
  var info;
  var qualifier = null;
  var record = null;
  var spec;
  var parsed;
  var decl;
  var saved;
  while (this.peek(i).kind === TokenKind.KEYWORD && CONSTRUCTOR_SPECIFIERS[this.peek(i).value]) {
    i++;
  }
  // Walk `A::B::...::` and stop at `S(` or `~S(` where S names the last
  // qualifier, a class.
  for (j = i; ; j += 2) {
    tok = this.peek(j);
    if (tok.kind !== TokenKind.IDENTIFIER) {
      return null;
    }
    info = qualifier ? this.sema.classifyQualifiedName(qualifier, tok.value) :
      this.sema.classifyName(tok.value);
    if (info.kind === 'template' && info.decls[0].templateKind === 'class' &&
        this.isPunct('<', j + 1)) {
      // `X<T>::X(...)` in an out-of-line member of a class template.
      templateId = this.parseTemplateIdAt(this._pos + j, info.decls[0]);
      if (!templateId.type || !T.isRecord(templateId.type)) {
        return null;
      }
      j = templateId.end - this._pos - 1;
      info = { kind: 'type', type: templateId.type };
    }
    if (!this.isPunct('::', j + 1)) {
      return null;
    }
    if (info.kind === 'namespace') {
      qualifier = this.sema.resolveNamespace(info.decls[0]);
    } else if (info.kind === 'type' && info.type && T.isRecord(info.type)) {
      qualifier = info.type.decl;
    } else {
      return null;
    }
    if (qualifier.kind === 'RecordDecl' && ((this.peek(j + 2).value === qualifier.name &&
        this.peek(j + 2).kind === TokenKind.IDENTIFIER && this.isPunct('(', j + 3)) ||
        (this.isPunct('~', j + 2) && this.peek(j + 3).value === qualifier.name &&
          this.isPunct('(', j + 4)))) {
      record = qualifier;
      break;
    }
  }
  spec = this._parseConstructorSpecifiers();
  this._skip(j + 2 - i);
  parsed = this._constructorDeclarator();
  saved = this.sema.startClassMemberDefinition(record, null, parsed.declarator.range);
  if (saved === null) {
    this._skipDefinitionRest();
    return [];
  }
  try {
    decl = this.sema.actOnOutOfLineConstructor(record, spec, parsed.declarator, parsed.kind);
    if (this.isPunct('=') && (this.isKeyword('default', 1) || this.isKeyword('delete', 1))) {
      this.next();
      this.sema.actOnDefaultedOrDeleted(decl, this.next().value === 'delete',
        this.rangeOf(this.peek(-1)));
      this.expectPunct(';', 'after declaration');
      return decl ? [decl] : [];
    }
    if (!decl) {
      this._skipDefinitionRest();
      return [];
    }
    if (!this.isPunct(':') && !this.isPunct('{')) {
      this.diagnostics.error('out-of-line declaration of a member must be a definition',
        parsed.declarator.range);
      this.expectPunct(';', 'after declaration');
      return [];
    }
    if (!this._deferFunctionTemplateBody(decl)) {
      this.parseFunctionBody(decl);
    }
  } finally {
    this.sema.actOnFinishQualifiedDeclaration(saved);
  }
  return [decl];
};

/** `[explicit|inline|virtual] operator T (` without a return type. */
Parser.prototype._startsConversionFunction = function () {
  var i = 0;
  while (this.peek(i).kind === TokenKind.KEYWORD && CONSTRUCTOR_SPECIFIERS[this.peek(i).value]) {
    i++;
  }
  return this.isKeyword('operator', i) && this.startsTypeId(i + 1);
};

/** A conversion function member: `explicit operator bool() const;` */
Parser.prototype._parseConversionMember = function (record) {
  var spec = this._parseConstructorSpecifiers();
  var declarator = { ptrOps: [], name: null, nameToken: null, qualifier: null, nested: null,
    suffixes: [], range: null };
  var decl;
  var virt;
  this._parseOperatorName(declarator);
  declarator.suffixes.push(this.parseFunctionSuffix());
  declarator.range = this.rangeOf(declarator.nameToken);
  spec.namedType = declarator.conversionType;
  spec.isConst = false;
  spec.isVolatile = false;
  spec.isAuto = false;
  spec.isTypedef = false;
  virt = this._parseVirtSpecifiers();
  decl = this.sema.actOnMemberDeclarator(spec, declarator, null, virt);
  if (decl && spec.isExplicit) {
    decl.isExplicit = true;
  }
  if (decl && this.isPunct('{')) {
    if (!this._deferTemplateBody(decl, record.scope)) {
      this._delayedBodies.push({ decl: decl, pos: this._pos });
    }
    this._skipBraces();
    return;
  }
  if (this.isPunct('=') && (this.isKeyword('default', 1) || this.isKeyword('delete', 1))) {
    this.next();
    this.sema.actOnDefaultedOrDeleted(decl, this.next().value === 'delete',
      this.rangeOf(this.peek(-1)));
  }
  this.expectSemi('at end of declaration list');
};

/** `= init` / `{init}` of a static data member declared in the class. */
Parser.prototype._parseStaticMemberInitializer = function (decl) {
  var init;
  var style;
  if (this.acceptPunct('=')) {
    style = 'copy';
    init = this.isPunct('{') ? this.parseBracedInitList() : this.parseAssignmentExpression();
  } else {
    style = 'list';
    init = this.parseBracedInitList();
  }
  this.sema.actOnStaticMemberInit(decl, init, style);
};

/**
 * `friend class X;`, `friend X;`, `friend R f(...);` or an inline friend
 * function definition (C++11 11.3).
 */
Parser.prototype._parseFriend = function (record, spec) {
  var declarator;
  var decl;
  if (this.acceptPunct(';')) {
    this.sema.actOnFriendClass(record, spec.namedType || this.sema.types.builtin('int'),
      spec.range);
    return;
  }
  declarator = this.parseDeclarator(false);
  decl = this.sema.actOnFriendFunction(record, spec, declarator);
  if (decl && this.isPunct('{')) {
    // Defined in the class: parsed with the other delayed bodies, in the
    // scope of the class (C++11 11.3/7).
    if (!this._deferTemplateBody(decl, record.scope)) {
      this._delayedBodies.push({ decl: decl, pos: this._pos, scope: record.scope });
    }
    this._skipBraces();
    return;
  }
  this.expectSemi('after friend declaration');
};

/** Skips `< ... >` (with nested angle groups). */
Parser.prototype._skipAngleGroup = function () {
  var depth = 0;
  var tok;
  do {
    tok = this.next();
    if (tok.kind === TokenKind.PUNCT) {
      if (tok.value === '<') {
        depth++;
      } else if (tok.value === '>') {
        depth--;
      } else if (tok.value === '>>') {
        depth -= 2;
      }
    }
  } while (depth > 0 && tok.kind !== TokenKind.EOF);
};

