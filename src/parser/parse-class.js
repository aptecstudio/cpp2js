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

var ACCESS_WORDS = { 'public': true, 'protected': true, 'private': true };

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
  if (this._startsQualifiedName(0)) {
    this.fail('qualified class names are not supported yet');
  }
  if (this.peek().kind === TokenKind.IDENTIFIER) {
    nameTok = this.next();
  }
  if (this.peek().kind === TokenKind.IDENTIFIER && this.peek().value === 'final' &&
      (this.isPunct('{', 1) || this.isPunct(':', 1))) {
    this.next();
    isFinal = true;
  }
  if (this.isPunct('{') || this.isPunct(':')) {
    form = 'definition';
  } else if (this.isPunct(';') && nameTok) {
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
      this.parseBaseClause(decl);
    }
    this.parseClassBody(decl);
  }
  return this.sema.types.record(decl);
};

/** Base classes come in step 5d. */
Parser.prototype.parseBaseClause = function () {
  this.fail('base classes are not supported yet');
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
  this.sema.scope = item.decl.parent.scope;
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
  if (this.isKeyword('static_assert') || this.isKeyword('template')) {
    this.fail('\'' + tok.value + '\' in classes is not supported yet');
  }
  spec = this.parseDeclSpecifiers();
  if (spec.isFriend) {
    this.fail('friend declarations are not supported yet');
  }
  if (this.acceptPunct(';')) {
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
    if (this.acceptPunct(':')) {
      bitWidth = this.parseConstantExpression();
    }
    decl = this.sema.actOnMemberDeclarator(spec, declarator, bitWidth);
    if (decl && decl.kind === 'FunctionDecl' && this.isPunct('{') && first) {
      // Parsed when the outermost class is complete.
      this._delayedBodies.push({ decl: decl, pos: this._pos });
      this._skipBraces();
      return;
    }
    if (this.isPunct('=') || this.isPunct('{')) {
      this._parseMemberInitializer(decl);
    }
    first = false;
    if (!this.acceptPunct(',')) {
      break;
    }
  }
  this.expectPunct(';', 'after member declaration');
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
