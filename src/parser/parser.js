'use strict';

/**
 * Recursive-descent C++11 parser (D-035, D-042).
 *
 * The parser reads the tokens of one translation unit and calls `Sema`
 * for every name classification and every construct it recognizes; the
 * result is the resolved AST in `sema.translationUnit`.
 *
 * Error recovery: after a syntax error the parser skips to the end of the
 * current declaration or statement (`;` or a closing brace at the same
 * nesting level) and goes on, so that one mistake gives one error.
 *
 * This file holds the token machinery and declarations; expressions and
 * statements live in `parse-expr.js` and `parse-stmt.js`, which extend
 * `Parser.prototype`.
 */

var TokenKind = require('../lexer/lexer').TokenKind;
var ast = require('../ast/nodes');
var Sema = require('../semantic/sema').Sema;
var T = require('../semantic/types');

/** Words that start a builtin type specifier. */
var BUILTIN_TYPE_WORDS = {
  'void': true, 'bool': true, 'char': true, 'char16_t': true, 'char32_t': true,
  'wchar_t': true, 'short': true, 'int': true, 'long': true, 'signed': true,
  'unsigned': true, 'float': true, 'double': true
};

var STORAGE_WORDS = { 'static': true, 'extern': true, 'register': true, 'mutable': true,
  'thread_local': true };

var FUNCTION_SPECIFIER_WORDS = { 'inline': true, 'virtual': true, 'explicit': true };

/**
 * Thrown to abandon the current declaration or statement after an error
 * was reported; caught where recovery happens.
 *
 * @constructor
 */
function ParseError() {}

/**
 * @constructor
 * @param {Array.<Object>} tokens Lexer output (ending with `eof`).
 * @param {DiagnosticBag} diagnostics
 * @param {SourceFile} source Main file.
 */
function Parser(tokens, diagnostics, source, options) {
  this._tokens = tokens;
  this._pos = 0;
  this.diagnostics = diagnostics;
  this.options = options || {};
  // Defaults of D-021.
  this.options.platform = this.options.platform || 'browser';
  this.options.target = this.options.target || 'es5';
  this.sema = new Sema(diagnostics, source, this.options);
  // Language of the enclosing linkage specification ('C', 'C++', 'JS').
  this._linkage = null;
  // Whether the linkage specification is the unbraced form
  // (`extern "C" int x;`), which makes variables declarations only.
  this._linkageUnbraced = false;
}

// ---------------------------------------------------------------------------
// Tokens.

Parser.prototype.peek = function (offset) {
  var index = this._pos + (offset || 0);
  return this._tokens[Math.min(index, this._tokens.length - 1)];
};

Parser.prototype.next = function () {
  var tok = this.peek();
  if (this._pos < this._tokens.length - 1) {
    this._pos++;
  }
  return tok;
};

/** Whether the current token is the punctuator `value`. */
Parser.prototype.isPunct = function (value, offset) {
  var tok = this.peek(offset);
  return tok.kind === TokenKind.PUNCT && tok.value === value;
};

/** Whether the current token is the keyword `word`. */
Parser.prototype.isKeyword = function (word, offset) {
  var tok = this.peek(offset);
  return tok.kind === TokenKind.KEYWORD && tok.value === word;
};

Parser.prototype.acceptPunct = function (value) {
  if (this.isPunct(value)) {
    return this.next();
  }
  return null;
};

Parser.prototype.acceptKeyword = function (word) {
  if (this.isKeyword(word)) {
    return this.next();
  }
  return null;
};

/**
 * Range of a token in the user's file (outermost macro invocation for
 * tokens produced by macros).
 */
Parser.prototype.rangeOf = function (tok) {
  while (tok.expansion) {
    tok = tok.expansion.site;
  }
  return { source: tok.source, start: tok.start, end: tok.end };
};

/** Range from the start of `first` to the end of `last`. */
Parser.prototype.rangeFrom = function (first, last) {
  var a = this.rangeOf(first);
  var b = this.rangeOf(last || this._tokens[Math.max(this._pos - 1, 0)]);
  if (a.source !== b.source || b.end < a.start) {
    return a;
  }
  return { source: a.source, start: a.start, end: b.end };
};

/** Reports an error at the current token and abandons the construct. */
Parser.prototype.fail = function (message, tok) {
  this.diagnostics.error(message, this.rangeOf(tok || this.peek()));
  throw new ParseError();
};

/**
 * Consumes the punctuator `value` or fails with `expected 'value'`.
 *
 * @param {string} value
 * @param {string} [context] Appended to the message (`after expression`).
 * @param {Object} [opener] Token of the matching opening bracket, for a
 *   `to match this` note.
 */
Parser.prototype.expectPunct = function (value, context, opener) {
  var tok;
  var diag;
  if (this.isPunct(value)) {
    return this.next();
  }
  tok = this.peek();
  diag = this.diagnostics.error('expected \'' + value + '\'' + (context ? ' ' + context : ''),
    this.rangeOf(this._expectedAt(tok)));
  if (opener) {
    diag.addNote('to match this \'' + opener.value + '\'', this.rangeOf(opener));
  }
  throw new ParseError();
};

/**
 * Where a missing token is reported: Clang points at the end of the
 * previous token when the next one is on another line.
 */
Parser.prototype._expectedAt = function (tok) {
  var prev = this._pos > 0 ? this._tokens[this._pos - 1] : null;
  if (prev && (tok.lineStart || tok.kind === TokenKind.EOF)) {
    return { source: this.rangeOf(prev).source, start: this.rangeOf(prev).end,
      end: this.rangeOf(prev).end, expansion: null };
  }
  return tok;
};

/**
 * Skips tokens until the end of the current declaration or statement: a
 * `;` (consumed) or a `}` (not consumed) at nesting depth 0. A balanced
 * `{...}` block is skipped entirely and ends the construct.
 */
Parser.prototype.skipToRecoveryPoint = function () {
  var depth = 0;
  var tok;
  for (;;) {
    tok = this.peek();
    if (tok.kind === TokenKind.EOF) {
      return;
    }
    if (tok.kind === TokenKind.PUNCT) {
      if (tok.value === '(' || tok.value === '[') {
        depth++;
      } else if ((tok.value === ')' || tok.value === ']') && depth > 0) {
        depth--;
      } else if (tok.value === '{') {
        this._skipBraces();
        if (depth === 0) {
          this.acceptPunct(';');
          return;
        }
        continue;
      } else if (tok.value === '}' && depth === 0) {
        return;
      } else if (tok.value === ';' && depth === 0) {
        this.next();
        return;
      }
    }
    this.next();
  }
};

Parser.prototype._skipBraces = function () {
  var depth = 0;
  var tok;
  do {
    tok = this.next();
    if (tok.kind === TokenKind.PUNCT && tok.value === '{') {
      depth++;
    } else if (tok.kind === TokenKind.PUNCT && tok.value === '}') {
      depth--;
    }
  } while (depth > 0 && tok.kind !== TokenKind.EOF);
};

/**
 * Runs `fn`; on a ParseError, skips to the next `{` (a function body).
 */
Parser.prototype.withRecoveryUntilBrace = function (fn) {
  try {
    return fn.call(this);
  } catch (err) {
    if (err instanceof ParseError) {
      while (!this.isPunct('{') && this.peek().kind !== TokenKind.EOF) {
        this.next();
      }
      return null;
    }
    throw err;
  }
};

/**
 * Runs `fn`; on a ParseError, recovers and returns null.
 */
Parser.prototype.withRecovery = function (fn) {
  try {
    return fn.call(this);
  } catch (err) {
    if (err instanceof ParseError) {
      this.skipToRecoveryPoint();
      return null;
    }
    throw err;
  }
};

// ---------------------------------------------------------------------------
// Translation unit and declarations.

/**
 * Parses the whole translation unit.
 *
 * @returns {Object} The TranslationUnit node.
 */
Parser.prototype.parseTranslationUnit = function () {
  var decls = this.parseDeclarationSeq(false);
  var i;
  for (i = 0; i < decls.length; i++) {
    this.sema.addTopLevel(decls[i]);
  }
  // Function templates and members of class templates used in the unit.
  this.processPendingInstantiations();
  return this.sema.translationUnit;
};

/**
 * Declarations until end of file, or until `}` when `braced`.
 *
 * @returns {Array.<Object>}
 */
Parser.prototype.parseDeclarationSeq = function (braced) {
  var self = this;
  var out = [];
  var decls;
  while (this.peek().kind !== TokenKind.EOF) {
    if (this.isPunct('}')) {
      if (braced) {
        break;
      }
      this.diagnostics.error('extraneous closing brace (\'}\')', this.rangeOf(this.next()));
      continue;
    }
    decls = this.withRecovery(function () {
      return self.parseDeclaration();
    });
    if (decls) {
      out = out.concat(decls.filter(function (d) { return d !== null; }));
    }
  }
  return out;
};

/**
 * declaration: empty-declaration | alias-declaration | simple-declaration |
 * function-definition (namespaces, linkage specifications and classes come
 * in later steps).
 *
 * @returns {Array.<Object>} The declarations introduced.
 */
Parser.prototype.parseDeclaration = function () {
  var attributes = this.parseAttributes();
  if (this.acceptPunct(';')) {
    return [];
  }
  if (this.isKeyword('namespace')) {
    return [this.parseNamespace(false, attributes)];
  }
  if (this.isKeyword('inline') && this.isKeyword('namespace', 1)) {
    this.next();
    return [this.parseNamespace(true, attributes)];
  }
  if (this.isKeyword('extern') && this.peek(1).kind === TokenKind.STRING) {
    return [this.parseLinkageSpecification()];
  }
  if (this.isKeyword('static_assert')) {
    return [this.parseStaticAssert()];
  }
  if (this.isKeyword('template')) {
    return this.parseTemplateDeclaration();
  }
  if (this.isKeyword('using')) {
    if (this.isKeyword('namespace', 1)) {
      return [this.parseUsingDirective()];
    }
    if (this.peek(1).kind === TokenKind.IDENTIFIER && this.isPunct('=', 2)) {
      return [this.parseAliasDeclaration()];
    }
    return [this.parseUsingDeclaration()];
  }
  this.rejectAttributes(attributes, 'declarations');
  return this.parseSimpleDeclaration();
};

// ---------------------------------------------------------------------------
// Attributes (C++11 7.6).

/**
 * Parses `[[ attribute-list ]]...`.
 *
 * @returns {Array.<{scope: ?string, name: string, args: ?Array.<Object>,
 *   range: Object}>}
 */
Parser.prototype.parseAttributes = function () {
  var out = [];
  var open;
  var tok;
  var attr;
  var attrStart;
  var depth;
  while (this.isPunct('[') && this.isPunct('[', 1)) {
    open = this.next();
    this.next();
    while (!this.isPunct(']')) {
      tok = this.peek();
      if (tok.kind !== TokenKind.IDENTIFIER && tok.kind !== TokenKind.KEYWORD) {
        this.fail('expected attribute name');
      }
      this.next();
      attrStart = tok;
      attr = { scope: null, name: tok.value, args: null, range: null };
      if (this.acceptPunct('::')) {
        attr.scope = attr.name;
        tok = this.peek();
        if (tok.kind !== TokenKind.IDENTIFIER && tok.kind !== TokenKind.KEYWORD) {
          this.fail('expected attribute name');
        }
        attr.name = this.next().value;
      }
      if (this.isPunct('(')) {
        attr.args = [];
        depth = 0;
        this.next();
        while (depth > 0 || !this.isPunct(')')) {
          if (this.peek().kind === TokenKind.EOF) {
            this.fail('expected \')\'');
          }
          tok = this.next();
          depth += tok.value === '(' ? 1 : tok.value === ')' ? -1 : 0;
          attr.args.push(tok);
        }
        this.next();
      }
      attr.range = this.rangeFrom(attrStart);
      out.push(attr);
      if (!this.acceptPunct(',')) {
        break;
      }
    }
    this.expectPunct(']', '', open);
    this.expectPunct(']', '', open);
  }
  return out;
};

/** Standard attributes, accepted and ignored (they need no code). */
var STANDARD_ATTRIBUTES = { 'noreturn': true, 'carries_dependency': true, 'deprecated': true,
  'maybe_unused': true, 'nodiscard': true, 'fallthrough': true };

/** Full name of an attribute, e.g. `js::module`. */
function attributeName(attr) {
  return (attr.scope ? attr.scope + '::' : '') + attr.name;
}

/**
 * Reports attributes that do not apply where they appear. Unknown
 * attributes are ignored with a warning, as Clang does.
 */
Parser.prototype.rejectAttributes = function (attributes, what) {
  var i;
  for (i = 0; i < attributes.length; i++) {
    if (attributeName(attributes[i]) === 'js::module') {
      this.diagnostics.error('\'js::module\' attribute only applies to namespaces',
        attributes[i].range);
    } else if (!STANDARD_ATTRIBUTES[attributeName(attributes[i])]) {
      this.diagnostics.warning('unknown attribute \'' + attributeName(attributes[i]) +
        '\' ignored', attributes[i].range);
    }
    void what;
  }
};

/**
 * Extracts `[[js::module("name")]]` (D-031) from a namespace's attributes.
 *
 * @returns {?string} The module name.
 */
Parser.prototype._jsModuleAttribute = function (attributes) {
  var module = null;
  var i;
  var args;
  for (i = 0; i < attributes.length; i++) {
    if (attributeName(attributes[i]) !== 'js::module') {
      if (STANDARD_ATTRIBUTES[attributeName(attributes[i])]) {
        continue;
      }
      this.diagnostics.warning('unknown attribute \'' + attributeName(attributes[i]) +
        '\' ignored', attributes[i].range);
      continue;
    }
    args = attributes[i].args || [];
    if (args.length !== 1 || args[0].kind !== TokenKind.STRING ||
        args[0].value.encoding !== '') {
      this.diagnostics.error('\'js::module\' attribute requires a module name string',
        attributes[i].range);
      continue;
    }
    module = String.fromCharCode.apply(null, args[0].value.units);
    if (!module) {
      this.diagnostics.error('\'js::module\' attribute requires a non-empty module name',
        attributes[i].range);
      module = null;
    }
  }
  return module;
};

// ---------------------------------------------------------------------------
// Namespaces, using, linkage specifications.

/**
 * `namespace [[attrs]] name { ... }`, `namespace { ... }`, or the alias
 * `namespace name = qualified-namespace;`.
 */
Parser.prototype.parseNamespace = function (isInline, leading) {
  var keyword = this.next();
  var attributes = this.parseAttributes();
  var nameTok = null;
  var open;
  var decl;
  var decls;
  var jsModule;
  var target;
  this.rejectAttributes(leading, 'namespaces');
  if (this.peek().kind === TokenKind.IDENTIFIER) {
    nameTok = this.next();
  }
  if (nameTok && this.acceptPunct('=')) {
    target = this.parseNamespaceName();
    this.expectPunct(';', 'after namespace alias');
    return this.sema.actOnNamespaceAlias(nameTok.value, target, this.rangeOf(nameTok));
  }
  jsModule = this._jsModuleAttribute(attributes);
  if (jsModule !== null) {
    this._checkJsModule(jsModule, attributes);
  }
  open = this.peek();
  if (!this.isPunct('{')) {
    this.fail('expected \'{\'');
  }
  this.next();
  decl = this.sema.actOnStartNamespace(nameTok ? nameTok.value : null, isInline,
    this.rangeOf(nameTok || keyword), jsModule);
  try {
    decls = this.parseDeclarationSeq(true);
    this.expectPunct('}', '', open);
  } finally {
    this.sema.actOnFinishNamespace(decl, decls || []);
  }
  return decl;
};

/** Checks where `[[js::module]]` may be used (D-031). */
Parser.prototype._checkJsModule = function (module, attributes) {
  var range = attributes[0].range;
  if (this._linkage !== 'JS') {
    this.diagnostics.error('\'js::module\' attribute requires the namespace to be declared ' +
      'inside \'extern "JS"\'', range);
  } else if (this.options.platform === 'browser') {
    this.diagnostics.error('CommonJS module \'' + module + '\' cannot be imported on the ' +
      'browser platform', range);
  }
};

/**
 * Parses a (possibly qualified) name that must denote a namespace.
 *
 * @returns {Object} The NamespaceDecl.
 */
Parser.prototype.parseNamespaceName = function () {
  var name = this.parseQualifiedName();
  var info = name.info;
  if (info.kind !== 'namespace') {
    this.fail(info.kind === 'unknown' ? 'expected namespace name' :
      'expected namespace name', name.nameToken);
  }
  return this.sema.resolveNamespace(info.decls[0]);
};

/** `using namespace N;` */
Parser.prototype.parseUsingDirective = function () {
  var start = this.next();
  var target;
  this.next();
  target = this.parseNamespaceName();
  this.expectPunct(';', 'after using directive');
  return this.sema.actOnUsingDirective(target, this.rangeFrom(start));
};

/** `using N::name;` */
Parser.prototype.parseUsingDeclaration = function () {
  var start = this.next();
  var name;
  this.acceptKeyword('typename');
  name = this.parseQualifiedName();
  if (!name.qualifier) {
    this.fail('using declaration requires a qualified name', name.nameToken);
  }
  this.expectPunct(';', 'after using declaration');
  return this.sema.actOnUsingDeclaration(name.qualifier, name.name, this.rangeFrom(start));
};

/** `extern "lang" declaration` or `extern "lang" { declaration-seq }`. */
Parser.prototype.parseLinkageSpecification = function () {
  var start = this.next();
  var strTok = this.next();
  var language = String.fromCharCode.apply(null, strTok.value.units);
  var savedLinkage = this._linkage;
  var savedUnbraced = this._linkageUnbraced;
  var open;
  var decls;
  var node;
  if (language !== 'C' && language !== 'C++' && language !== 'JS') {
    this.diagnostics.error('unknown linkage language', this.rangeOf(strTok));
    language = 'C++';
  }
  node = ast.createNode('LinkageSpecDecl', this.rangeFrom(start), { language: language,
    decls: [], braced: false });
  this._linkage = language === 'C++' ? null : language;
  try {
    if (this.isPunct('{')) {
      open = this.next();
      node.braced = true;
      this._linkageUnbraced = false;
      decls = this.parseDeclarationSeq(true);
      this.expectPunct('}', '', open);
    } else {
      this._linkageUnbraced = true;
      decls = this.parseDeclaration();
    }
  } finally {
    this._linkage = savedLinkage;
    this._linkageUnbraced = savedUnbraced;
  }
  node.decls = decls;
  return node;
};

// ---------------------------------------------------------------------------
// Qualified names.

/**
 * Scans `::opt (name ::)* name` from `offset` without consuming tokens,
 * resolving each qualifier through Sema.
 *
 * @returns {?{qualifier: ?Object, global: boolean, name: string, nameOffset:
 *   number, info: Object, length: number, error: ?Object}} null if no name
 *   starts there. `error` describes a qualifier that is not a namespace,
 *   class or enumeration.
 */
Parser.prototype._scanQualifiedName = function (offset) {
  var i = offset;
  var qualifier = null;
  var global = false;
  var tok;
  var info;
  var decl;
  var templateId;
  var splitGreater = false;
  if (this.isPunct('::', i)) {
    global = true;
    qualifier = this.sema.globalNamespace;
    i++;
  }
  for (;;) {
    tok = this.peek(i);
    if (tok.kind !== TokenKind.IDENTIFIER) {
      return null;
    }
    info = qualifier ? this.sema.classifyQualifiedName(qualifier, tok.value) :
      this.sema.classifyName(tok.value);
    if (info.kind === 'type' && info.template && this.isPunct('<', i + 1)) {
      info = { kind: 'template', decls: [info.template] };
    }
    if (info.kind === 'template' && this.isPunct('<', i + 1) &&
        info.decls[0].templateKind !== 'function') {
      // `X<args>`: parsed (and instantiated) once, cached by position.
      templateId = this.parseTemplateIdAt(this._pos + i, info.decls[0]);
      splitGreater = templateId.splitGreater;
      if (!templateId.type) {
        return { qualifier: qualifier, global: global, name: tok.value, nameOffset: i,
          info: { kind: 'error', decls: [] }, length: templateId.end - this._pos - offset,
          error: null };
      }
      info = { kind: 'type', decls: [], type: templateId.type };
      i = templateId.end - this._pos - 1;
    }
    if (!this.isPunct('::', i + 1) || splitGreater) {
      return { qualifier: qualifier, global: global, name: tok.value, nameOffset: i,
        info: info, length: i - offset + 1, error: null, splitGreater: splitGreater };
    }
    decl = info.decls[0];
    if (info.kind === 'namespace') {
      qualifier = this.sema.resolveNamespace(decl);
    } else if (info.kind === 'type' && info.type && info.type.decl) {
      qualifier = info.type.decl;
    } else {
      return { qualifier: qualifier, global: global, name: tok.value, nameOffset: i, info: info,
        length: i - offset + 1, error: { token: tok, unknown: info.kind === 'unknown' } };
    }
    i += 2;
  }
};

/** Whether a qualified (or global-qualified) name starts at `offset`. */
Parser.prototype._startsQualifiedName = function (offset) {
  return this.isPunct('::', offset) || (this.peek(offset).kind === TokenKind.IDENTIFIER &&
    this.isPunct('::', offset + 1));
};

/**
 * Consumes a possibly qualified name.
 *
 * @returns {{qualifier: ?Object, name: string, nameToken: Object, info: Object}}
 */
Parser.prototype.parseQualifiedName = function () {
  var scan = this._scanQualifiedName(0);
  var i;
  var tok;
  if (!scan) {
    this.fail(this.isPunct('::') ? 'expected unqualified-id' : 'expected unqualified-id');
  }
  if (scan.error) {
    for (i = 0; i < scan.nameOffset; i++) {
      this.next();
    }
    this.fail(scan.error.unknown ? 'use of undeclared identifier \'' + scan.name + '\'' :
      '\'' + scan.name + '\' is not a class, namespace, or enumeration', scan.error.token);
  }
  for (i = 0; i < scan.nameOffset; i++) {
    this.next();
  }
  tok = this.next();
  return { qualifier: scan.qualifier, name: scan.name, nameToken: tok, info: scan.info };
};

/** `using Name = type-id ;` */
Parser.prototype.parseAliasDeclaration = function () {
  var nameTok;
  this.next();
  nameTok = this.next();
  var type;
  this.next();
  type = this.parseTypeId();
  this.expectPunct(';', 'after alias declaration');
  return this.sema.declareTypedef(nameTok.value, type, this.rangeOf(nameTok), true);
};

/**
 * decl-specifier-seq init-declarator-list ; or a function definition.
 */
Parser.prototype.parseSimpleDeclaration = function () {
  var outOfLine = this.sema.scope.kind === 'namespace' ? this.parseOutOfLineConstructor() :
    null;
  var spec;
  if (outOfLine) {
    return outOfLine;
  }
  if (this._startsQualifiedOperator() && this._conversionAfterOperator()) {
    // `S::operator T() const { ... }` has no decl-specifiers.
    return this._parseOutOfLineConversion();
  }
  spec = this.parseDeclSpecifiers();
  var decls = [];
  var declarator;
  var decl;
  var saved;
  if (this.acceptPunct(';')) {
    if (spec.tagDecl) {
      return [spec.tagDecl];
    }
    this.diagnostics.warning('declaration does not declare anything', spec.range);
    return [];
  }
  spec.linkage = this._linkage;
  if ((this._linkageUnbraced || this._linkage === 'JS') && !spec.storage && !spec.isTypedef) {
    // `extern "C" int x;` declares; in extern "JS" everything is provided
    // by JavaScript (D-031).
    spec.storage = 'extern';
  }
  for (;;) {
    declarator = this.parseDeclarator(false);
    saved = undefined;
    if (declarator.qualifier && declarator.qualifier.kind === 'RecordDecl') {
      return this._parseOutOfLineMember(spec, declarator);
    }
    if (declarator.qualifier) {
      saved = this.sema.actOnStartQualifiedDeclaration(declarator.qualifier, declarator.name,
        declarator.range);
    }
    if (saved === null && this.isPunct('{')) {
      // The definition was rejected: skip its body without further errors.
      this._skipBraces();
      return decls;
    }
    try {
      decl = saved === null ? null : this.sema.actOnDeclarator(spec, declarator);
      if (decl && decl.kind === 'FunctionDecl' && this.isPunct('{') && !decls.length) {
        if (this.sema.currentFunction()) {
          this.fail('function definition is not allowed here');
        }
        this.sema.checkLinkage(decl, this._linkage, true);
        this.parseFunctionBody(decl);
        return [decl];
      }
      this.parseInitializer(decl);
    } finally {
      if (saved) {
        this.sema.actOnFinishQualifiedDeclaration(saved);
      }
    }
    if (decl) {
      this.sema.checkLinkage(decl, this._linkage, decl.kind === 'VarDecl' && !!decl.init);
      decls.push(decl);
    }
    if (!this.acceptPunct(',')) {
      break;
    }
  }
  if (!this.isPunct(';')) {
    this.expectPunct(';', decls.length && decls[0].kind === 'FunctionDecl' ?
      'after top level declarator' : 'after declaration');
  }
  this.next();
  return decls;
};

/**
 * Optional initializer of a declarator: `= expr`, `= {...}`, `(args)` or
 * `{...}` (C++11 8.5).
 */
Parser.prototype.parseInitializer = function (decl) {
  var init = null;
  var style = null;
  var open;
  var args;
  if (this.isPunct('=') && (this.isKeyword('default', 1) || this.isKeyword('delete', 1)) &&
      decl && decl.kind === 'FunctionDecl') {
    this.next();
    this.sema.actOnDefaultedOrDeleted(decl, this.next().value === 'delete',
      this.rangeOf(this.peek(-1)));
    return;
  }
  if (this.acceptPunct('=')) {
    style = 'copy';
    if (this.isPunct('{')) {
      init = this.parseBracedInitList();
      // `auto x = {1}` would deduce std::initializer_list (D-055).
      init.isBracedCopy = true;
    } else {
      init = this.parseAssignmentExpression();
    }
  } else if (this.isPunct('{')) {
    style = 'list';
    init = this.parseBracedInitList();
  } else if (this.isPunct('(') && decl && decl.kind === 'VarDecl') {
    style = 'direct';
    open = this.next();
    args = this.isPunct(')') ? [] : this.parseExpressionList();
    this.expectPunct(')', '', open);
    init = this.sema.actOnInitList(args, this.rangeFrom(open));
  }
  if (decl && decl.kind === 'FunctionDecl') {
    if (init) {
      this.diagnostics.error('illegal initializer (only variables can be initialized)',
        decl.range);
    }
    return;
  }
  this.sema.actOnVariableInit(decl, init, style);
};

/** `{ initializer-list ,opt }` */
Parser.prototype.parseBracedInitList = function () {
  var open = this.expectPunct('{');
  var inits = [];
  while (!this.isPunct('}')) {
    inits.push(this.isPunct('{') ? this.parseBracedInitList() :
      this.parseAssignmentExpression());
    if (!this.acceptPunct(',')) {
      break;
    }
  }
  this.expectPunct('}', '', open);
  return this.sema.actOnInitList(inits, this.rangeFrom(open));
};

/**
 * Parses a decl-specifier-seq (C++11 7.1).
 *
 * @returns {Object} `{builtins, namedType, isConst, isVolatile, isAuto,
 *   isTypedef, storage, isInline, isConstexpr, isThreadLocal, range}`.
 */
Parser.prototype.parseDeclSpecifiers = function () {
  var spec = {
    builtins: [], namedType: null, isConst: false, isVolatile: false, isAuto: false,
    isTypedef: false, storage: '', isInline: false, isVirtual: false, isExplicit: false,
    isConstexpr: false, isThreadLocal: false, isFriend: false, range: null, tagDecl: null
  };
  var first = this.peek();
  var tok;
  var hasType = false;
  var scan;
  for (;;) {
    tok = this.peek();
    if (tok.kind === TokenKind.KEYWORD) {
      if (BUILTIN_TYPE_WORDS[tok.value]) {
        if (spec.namedType || spec.isAuto) {
          this.fail('cannot combine with previous \'' + this._typeSpelling(spec) +
            '\' declaration specifier');
        }
        spec.builtins.push({ word: tok.value, range: this.rangeOf(tok) });
        hasType = true;
      } else if (tok.value === 'const' || tok.value === 'volatile') {
        if (spec[tok.value === 'const' ? 'isConst' : 'isVolatile']) {
          this.diagnostics.warning('duplicate \'' + tok.value + '\' declaration specifier',
            this.rangeOf(tok));
        }
        spec[tok.value === 'const' ? 'isConst' : 'isVolatile'] = true;
      } else if (tok.value === 'auto') {
        if (hasType) {
          this.fail('\'auto\' cannot be combined with a type specifier');
        }
        spec.isAuto = true;
        hasType = true;
      } else if (STORAGE_WORDS[tok.value] && tok.value !== 'thread_local') {
        if (spec.storage) {
          this.fail('cannot combine with previous \'' + spec.storage +
            '\' declaration specifier');
        }
        if (tok.value === 'register') {
          this.diagnostics.warning('\'register\' storage class specifier is deprecated',
            this.rangeOf(tok));
        }
        spec.storage = tok.value;
      } else if (tok.value === 'thread_local') {
        spec.isThreadLocal = true;
      } else if (FUNCTION_SPECIFIER_WORDS[tok.value]) {
        spec['is' + tok.value.charAt(0).toUpperCase() + tok.value.slice(1)] = true;
      } else if (tok.value === 'typedef') {
        spec.isTypedef = true;
      } else if (tok.value === 'constexpr') {
        spec.isConstexpr = true;
      } else if (tok.value === 'friend') {
        spec.isFriend = true;
      } else if (tok.value === 'decltype' && !hasType) {
        spec.namedType = this.parseDecltype();
        hasType = true;
        continue;
      } else if (tok.value === 'enum' && !hasType) {
        spec.namedType = this.parseEnumSpecifier(spec);
        hasType = true;
        continue;
      } else if ((tok.value === 'class' || tok.value === 'struct' || tok.value === 'union') &&
          !hasType) {
        spec.namedType = this.parseClassSpecifier(spec);
        hasType = true;
        continue;
      } else {
        break;
      }
      this.next();
      continue;
    }
    if ((tok.kind === TokenKind.IDENTIFIER || this.isPunct('::')) && !hasType) {
      scan = this._scanQualifiedName(0);
      if (scan && !scan.error && scan.info.kind === 'type') {
        this._skip(scan.length);
        if (scan.splitGreater) {
          // The template-id ended with `>>`: one `>` is still pending.
          this._splitGreater = true;
        }
        spec.namedType = scan.info.type;
        hasType = true;
        continue;
      }
      if (scan && scan.info.kind === 'error') {
        // An invalid template-id, already reported.
        this._skip(scan.length);
        spec.namedType = this.sema.types.builtin('int');
        hasType = true;
        continue;
      }
      if (scan && !scan.error && scan.info.kind === 'template' &&
          scan.info.decls[0].templateKind === 'class' && this._looksLikeDeclaratorStart(
            scan.length)) {
        this._skip(scan.nameOffset);
        this.diagnostics.error('use of class template \'' + scan.name + '\' requires template ' +
          'arguments', this.rangeOf(this.next()));
        spec.namedType = this.sema.types.builtin('int');
        hasType = true;
        continue;
      }
      if (scan && !scan.error && scan.info.kind === 'unknown' &&
          this._looksLikeDeclaratorStart(scan.length)) {
        // `foo x;` with an unknown `foo`: Clang's "unknown type name".
        this._skip(scan.nameOffset);
        this.diagnostics.error(scan.qualifier ? 'no type named \'' + scan.name + '\' in ' +
          this.sema.describeQualifier(scan.qualifier) : 'unknown type name \'' + scan.name +
          '\'', this.rangeOf(this.next()));
        spec.namedType = this.sema.types.builtin('int');
        hasType = true;
        continue;
      }
    }
    break;
  }
  if (this.peek() === first) {
    this.fail('expected unqualified-id');
  }
  spec.range = this.rangeFrom(first);
  if (spec.isTypedef && spec.storage) {
    this.diagnostics.error('\'' + spec.storage + '\' cannot be combined with \'typedef\'',
      spec.range);
  }
  return spec;
};

Parser.prototype._typeSpelling = function (spec) {
  if (spec.isAuto) {
    return 'auto';
  }
  return spec.namedType ? T.typeToString(spec.namedType) : '';
};

// ---------------------------------------------------------------------------
// Enumerations (C++11 7.2).

/**
 * enum-specifier, opaque-enum-declaration or elaborated `enum` reference,
 * inside a decl-specifier-seq. A definition or declaration is recorded in
 * `spec.tagDecl`.
 *
 * @returns {Object} The enumeration type (int after an error).
 */
Parser.prototype.parseEnumSpecifier = function (spec) {
  var keyword = this.next();
  var scoped = false;
  var nameTok = null;
  var underlying = null;
  var form;
  var decl;
  var open;
  var self = this;
  if (this.acceptKeyword('class') || this.acceptKeyword('struct')) {
    scoped = true;
  }
  this.rejectAttributes(this.parseAttributes(), 'enumerations');
  if (this._startsQualifiedName(0) && !this.isPunct('::', 0)) {
    this.fail('qualified enumeration names are not supported yet');
  }
  if (this.peek().kind === TokenKind.IDENTIFIER) {
    nameTok = this.next();
  } else if (scoped) {
    this.fail('scoped enumeration requires a name');
  }
  if (this.acceptPunct(':')) {
    underlying = this.parseTypeId();
  }
  if (this.isPunct('{')) {
    form = 'definition';
  } else if (this.isPunct(';') && nameTok) {
    // `enum E;` without a fixed type is rejected by Sema, but it is still
    // meant as a declaration.
    form = 'declaration';
  } else if (!nameTok) {
    this.fail('expected identifier or \'{\'');
  } else if (scoped || underlying) {
    this.fail('expected \'{\' or \';\' after enumeration');
  } else {
    form = 'reference';
  }
  decl = this.sema.actOnEnumHead(nameTok ? nameTok.value : null, scoped, underlying, form,
    this.rangeOf(nameTok || keyword));
  if (!decl) {
    if (form === 'definition') {
      this._skipBraces();
    }
    return this.sema.types.builtin('int');
  }
  if (form !== 'reference') {
    spec.tagDecl = decl;
  }
  if (form === 'definition') {
    open = this.next();
    this.sema.actOnStartEnumBody(decl);
    try {
      while (!this.isPunct('}')) {
        this.withRecovery(function () {
          self._parseEnumerator(decl);
        });
        if (this.isPunct('}') || this.peek().kind === TokenKind.EOF) {
          break;
        }
        if (!this.acceptPunct(',')) {
          this.diagnostics.error('expected \'}\' or \',\'', this.rangeOf(this.peek()));
          this._skipTo('}');
          break;
        }
      }
      this.expectPunct('}', '', open);
    } finally {
      this.sema.actOnFinishEnumBody(decl, this.rangeFrom(open));
    }
  }
  return this.sema.types.enumeration(decl);
};

/** Skips tokens up to (not including) a punctuator at depth 0. */
Parser.prototype._skipTo = function (value) {
  var depth = 0;
  var tok;
  while (this.peek().kind !== TokenKind.EOF) {
    tok = this.peek();
    if (tok.kind === TokenKind.PUNCT) {
      if (depth === 0 && tok.value === value) {
        return;
      }
      if (tok.value === '(' || tok.value === '[' || tok.value === '{') {
        depth++;
      } else if (tok.value === ')' || tok.value === ']' || tok.value === '}') {
        if (depth === 0) {
          return;
        }
        depth--;
      }
    }
    this.next();
  }
};

/** `name [= constant-expression]` */
Parser.prototype._parseEnumerator = function (decl) {
  var nameTok = this.peek();
  var init = null;
  if (nameTok.kind !== TokenKind.IDENTIFIER) {
    this.fail('expected identifier');
  }
  this.next();
  this.rejectAttributes(this.parseAttributes(), 'enumerators');
  if (this.acceptPunct('=')) {
    init = this.parseConstantExpression();
    if (!init) {
      return;
    }
  }
  this.sema.actOnEnumerator(decl, nameTok.value, init, this.rangeOf(nameTok));
};

/** `decltype ( expression )` as a type specifier (C++11 7.1.6.2). */
Parser.prototype.parseDecltype = function () {
  var open;
  var expr;
  this.next();
  open = this.expectPunct('(', 'after \'decltype\'');
  expr = this.parseExpression();
  this.expectPunct(')', '', open);
  return this.sema.actOnDecltype(expr && expr.kind === 'ParenExpr' ? expr.expr : expr,
    !!expr && expr.kind === 'ParenExpr');
};

/** `static_assert ( constant-expression [, string-literal] ) ;` */
Parser.prototype.parseStaticAssert = function () {
  var keyword = this.next();
  var open = this.expectPunct('(', 'after \'static_assert\'');
  var condition = this.parseConstantExpression();
  var message = null;
  if (this.acceptPunct(',')) {
    if (this.peek().kind !== TokenKind.STRING) {
      this.fail('expected string literal');
    }
    message = this.next().value;
  } else {
    this.diagnostics.warning('static_assert with no message is a C++17 extension',
      this.rangeOf(this.peek()));
  }
  this.expectPunct(')', '', open);
  this.expectPunct(';', 'after static_assert');
  return this.sema.actOnStaticAssert(condition, message, this.rangeFrom(keyword));
};

/** Consumes `count` tokens. */
Parser.prototype._skip = function (count) {
  var i;
  for (i = 0; i < count; i++) {
    this.next();
  }
};

/** Whether the token at `offset` can start a (named) declarator. */
Parser.prototype._looksLikeDeclaratorStart = function (offset) {
  var tok = this.peek(offset);
  return tok.kind === TokenKind.IDENTIFIER ||
    (tok.kind === TokenKind.PUNCT && (tok.value === '*' || tok.value === '&' ||
      tok.value === '&&'));
};

/** Whether the current token can start a decl-specifier-seq. */
Parser.prototype.startsDeclSpecifier = function (offset) {
  var tok = this.peek(offset);
  var scan;
  if (tok.kind === TokenKind.KEYWORD) {
    return !!(BUILTIN_TYPE_WORDS[tok.value] || STORAGE_WORDS[tok.value] ||
      FUNCTION_SPECIFIER_WORDS[tok.value] || tok.value === 'const' ||
      tok.value === 'volatile' || tok.value === 'auto' || tok.value === 'typedef' ||
      tok.value === 'constexpr' || tok.value === 'friend' || tok.value === 'enum' ||
      tok.value === 'decltype' ||
      tok.value === 'class' || tok.value === 'struct' || tok.value === 'union');
  }
  if (tok.kind === TokenKind.IDENTIFIER || (tok.kind === TokenKind.PUNCT &&
      tok.value === '::')) {
    scan = this._scanQualifiedName(offset);
    // An invalid template-id or a class template without arguments still
    // starts a declaration (the error is reported there).
    return !!scan && !scan.error && (scan.info.kind === 'type' || scan.info.kind === 'error' ||
      (scan.info.kind === 'template' && scan.info.decls[0].templateKind === 'class' &&
        this._looksLikeDeclaratorStart(offset + scan.length)));
  }
  return false;
};

/**
 * Parses a declarator (C++11 8).
 *
 * @param {boolean} abstract Whether the name may (or must, for type-ids)
 *   be omitted: true for parameters and type-ids.
 * @returns {Object} `{ptrOps, name, nameToken, nested, suffixes, range}`;
 *   `name` is also propagated from a nested declarator.
 */
Parser.prototype.parseDeclarator = function (abstract) {
  var first = this.peek();
  var declarator = { ptrOps: [], name: null, nameToken: null, qualifier: null, nested: null,
    suffixes: [], range: null };
  if (abstract && this._splitGreater) {
    // A pending `>` of a `>>` closes the enclosing template argument.
    declarator.range = this.rangeOf(first);
    return declarator;
  }
  var tok;
  var op;
  var qualified;
  var savedScope;
  for (;;) {
    tok = this.peek();
    if (this.isPunct('*')) {
      this.next();
      op = { kind: 'pointer', isConst: false, isVolatile: false, range: this.rangeOf(tok) };
      for (;;) {
        if (this.acceptKeyword('const')) {
          op.isConst = true;
        } else if (this.acceptKeyword('volatile')) {
          op.isVolatile = true;
        } else {
          break;
        }
      }
      declarator.ptrOps.push(op);
    } else if (this.isPunct('&') || this.isPunct('&&')) {
      this.next();
      declarator.ptrOps.push({ kind: tok.value === '&' ? 'lvalue-ref' : 'rvalue-ref',
        range: this.rangeOf(tok) });
    } else {
      break;
    }
  }

  tok = this.peek();
  if (!abstract && this._startsQualifiedOperator()) {
    declarator.qualifier = this._parseOperatorQualifier();
    this._parseOperatorName(declarator);
  } else if (!abstract && this.isKeyword('operator')) {
    this._parseOperatorName(declarator);
  } else if (!abstract && this._startsQualifiedName(0)) {
    qualified = this.parseQualifiedName();
    declarator.name = qualified.name;
    declarator.nameToken = qualified.nameToken;
    declarator.qualifier = qualified.qualifier;
  } else if (tok.kind === TokenKind.IDENTIFIER) {
    this.next();
    declarator.name = tok.value;
    declarator.nameToken = tok;
  } else if (this.isPunct('(') && this._isNestedDeclarator(abstract)) {
    this.next();
    declarator.nested = this.parseDeclarator(abstract);
    this.expectPunct(')', '', tok);
    declarator.name = declarator.nested.name;
    declarator.nameToken = declarator.nested.nameToken;
    declarator.qualifier = declarator.nested.qualifier;
  } else if (!abstract) {
    this.fail('expected unqualified-id');
  }

  if (declarator.qualifier && declarator.qualifier.scope && !declarator.nested) {
    // After a qualified declarator-id, names are looked up in the scope of
    // the qualifier (C++11 3.4.1/8): `int S::arr[k]`, `void S::f(T x)`.
    savedScope = this.sema.scope;
    this.sema.scope = declarator.qualifier.scope;
    try {
      this._parseDeclaratorSuffixes(declarator, abstract);
    } finally {
      this.sema.scope = savedScope;
    }
  } else {
    this._parseDeclaratorSuffixes(declarator, abstract);
  }
  declarator.range = declarator.nameToken ? this.rangeOf(declarator.nameToken) :
    this.rangeFrom(first);
  return declarator;
};

/**
 * After `(` in a declarator: a nested declarator, or (in abstract
 * declarators) a parameter list? C++11 8.2/7: in an abstract declarator, a
 * `(` followed by `)`, `...` or a decl-specifier starts parameters.
 */
Parser.prototype._isNestedDeclarator = function (abstract) {
  var next = this.peek(1);
  if (!abstract) {
    return true;
  }
  if (next.kind === TokenKind.PUNCT && (next.value === ')' || next.value === '...')) {
    return false;
  }
  return !this.startsDeclSpecifier(1);
};

Parser.prototype._parseDeclaratorSuffixes = function (declarator, abstract) {
  var tok;
  var size;
  for (;;) {
    tok = this.peek();
    // `int b(2);` is a variable with a direct initializer: after a named
    // declarator, `(` starts parameters only if what follows can start a
    // parameter declaration (C++11 8.2/1: what can be a declaration is).
    if (this.isPunct('(') && !abstract && !this._startsParameters(1)) {
      return;
    }
    if (this.isPunct('[')) {
      this.next();
      size = this.isPunct(']') ? null : this.parseConstantExpression();
      this.expectPunct(']', '', tok);
      declarator.suffixes.push({ kind: 'array', size: size, range: this.rangeFrom(tok) });
    } else if (this.isPunct('(')) {
      declarator.suffixes.push(this.parseFunctionSuffix());
    } else {
      return;
    }
  }
};

/** Operator tokens that may follow `operator` (C++11 13.5). */
var OPERATOR_TOKENS = { '+': 1, '-': 1, '*': 1, '/': 1, '%': 1, '^': 1, '&': 1, '|': 1, '~': 1,
  '!': 1, '=': 1, '<': 1, '>': 1, '+=': 1, '-=': 1, '*=': 1, '/=': 1, '%=': 1, '^=': 1,
  '&=': 1, '|=': 1, '<<': 1, '>>': 1, '>>=': 1, '<<=': 1, '==': 1, '!=': 1, '<=': 1, '>=': 1,
  '&&': 1, '||': 1, '++': 1, '--': 1, ',': 1, '->*': 1, '->': 1 };

/** Whether `A::B::operator...` starts here. */
Parser.prototype._startsQualifiedOperator = function () {
  var i = this.isPunct('::') ? 1 : 0;
  if (this.peek(i).kind !== TokenKind.IDENTIFIER) {
    return false;
  }
  while (this.peek(i).kind === TokenKind.IDENTIFIER && this.isPunct('::', i + 1)) {
    i += 2;
  }
  return i > 0 && this.isKeyword('operator', i);
};

/** Consumes `A::B::` before `operator` and returns the qualifier. */
Parser.prototype._parseOperatorQualifier = function () {
  var qualifier = this.acceptPunct('::') ? this.sema.globalNamespace : null;
  var tok;
  var info;
  while (this.peek().kind === TokenKind.IDENTIFIER && this.isPunct('::', 1)) {
    tok = this.next();
    this.next();
    info = qualifier ? this.sema.classifyQualifiedName(qualifier, tok.value) :
      this.sema.classifyName(tok.value);
    if (info.kind === 'namespace') {
      qualifier = this.sema.resolveNamespace(info.decls[0]);
    } else if (info.kind === 'type' && T.isRecord(info.type)) {
      qualifier = info.type.decl;
    } else {
      this.fail('\'' + tok.value + '\' is not a class, namespace, or enumeration', tok);
    }
  }
  return qualifier;
};

/**
 * `operator @`, `operator ()`, `operator []`, `operator new[]` or a
 * conversion function `operator T` (12.3.2) as a declarator-id.
 */
Parser.prototype._parseOperatorName = function (declarator) {
  var keyword = this.next();
  var tok = this.peek();
  var op;
  var spec;
  var type;
  if (tok.kind === TokenKind.PUNCT && tok.value === '(' && this.isPunct(')', 1)) {
    this.next();
    this.next();
    op = '()';
  } else if (tok.kind === TokenKind.PUNCT && tok.value === '[' && this.isPunct(']', 1)) {
    this.next();
    this.next();
    op = '[]';
  } else if (tok.kind === TokenKind.PUNCT && OPERATOR_TOKENS[tok.value]) {
    this.next();
    op = tok.value;
  } else if (tok.kind === TokenKind.KEYWORD && (tok.value === 'new' || tok.value === 'delete')) {
    this.next();
    op = tok.value;
    if (this.isPunct('[') && this.isPunct(']', 1)) {
      this.next();
      this.next();
      op += '[]';
    }
  } else if (this.startsTypeId(0)) {
    // conversion-type-id: type specifiers and pointer operators only.
    spec = this.parseDeclSpecifiers();
    type = this.sema.typeFromSpecifiers(spec) || this.sema.types.builtin('int');
    while (this.isPunct('*') || this.isPunct('&') || this.isPunct('&&')) {
      tok = this.next();
      type = tok.value === '*' ? this.sema.types.pointer(type) : tok.value === '&' ?
        this.sema.types.lvalueReference(type) : this.sema.types.rvalueReference(type);
      while (this.isKeyword('const') || this.isKeyword('volatile')) {
        tok = this.next();
        type = this.sema.types.addQualifiers(type, tok.value === 'const',
          tok.value === 'volatile');
      }
    }
    declarator.conversionType = type;
    declarator.name = 'operator ' + T.typeToString(type);
    declarator.nameToken = keyword;
    return;
  } else {
    this.fail('expected a type or an operator after \'operator\'');
  }
  declarator.operatorName = op;
  declarator.name = 'operator' + op;
  declarator.nameToken = keyword;
};

/** Whether the token at `offset` can begin a parameter-declaration-clause. */
Parser.prototype._startsParameters = function (offset) {
  var tok = this.peek(offset);
  if (tok.kind === TokenKind.PUNCT && (tok.value === ')' || tok.value === '...')) {
    return true;
  }
  return this.startsDeclSpecifier(offset);
};

/**
 * `( parameter-declaration-clause ) cv-qualifier-seq ref-qualifier
 * exception-specification trailing-return-type`
 */
Parser.prototype.parseFunctionSuffix = function (isLambda) {
  var open = this.expectPunct('(');
  var suffix = { kind: 'function', params: [], variadic: false, isConst: false,
    isVolatile: false, refQualifier: '', noexcept: null, trailingReturn: null, range: null };
  if (this.isKeyword('void') && this.isPunct(')', 1)) {
    this.next();
  } else {
    while (!this.isPunct(')')) {
      if (this.acceptPunct('...')) {
        suffix.variadic = true;
        break;
      }
      suffix.params.push(this.parseParameter());
      if (!this.acceptPunct(',')) {
        if (this.acceptPunct('...')) {
          suffix.variadic = true;
        }
        break;
      }
    }
  }
  this.expectPunct(')', '', open);
  if (isLambda && this.acceptKeyword('mutable')) {
    suffix.isMutable = true;
  }
  for (;;) {
    if (isLambda) {
      break;
    }
    if (this.acceptKeyword('const')) {
      suffix.isConst = true;
    } else if (this.acceptKeyword('volatile')) {
      suffix.isVolatile = true;
    } else {
      break;
    }
  }
  if (this.isPunct('&') || this.isPunct('&&')) {
    suffix.refQualifier = this.next().value;
  }
  this._parseExceptionSpecification(suffix);
  if (this.acceptPunct('->')) {
    // Parameters are in scope in the trailing return type (C++11 3.3.4).
    this.sema.pushScope('prototype', null);
    try {
      suffix.params.forEach(function (param) {
        if (param.name) {
          this.sema.scope.declare(param.name, this.sema.createDecl('ParamDecl', param.range,
            { name: param.name, type: param.type }));
        }
      }, this);
      suffix.trailingReturn = this.parseTypeId();
    } finally {
      this.sema.popScope();
    }
  }
  suffix.range = this.rangeFrom(open);
  return suffix;
};

/** `noexcept`, `noexcept(constant-expression)` or `throw(type-ids)`. */
Parser.prototype._parseExceptionSpecification = function (suffix) {
  var open;
  if (this.acceptKeyword('noexcept')) {
    suffix.noexcept = true;
    if (this.isPunct('(')) {
      open = this.next();
      this.parseConstantExpression();
      this.expectPunct(')', '', open);
    }
  } else if (this.isKeyword('throw') && this.isPunct('(', 1)) {
    this.next();
    open = this.next();
    while (!this.isPunct(')')) {
      this.parseTypeId();
      if (!this.acceptPunct(',')) {
        break;
      }
    }
    this.expectPunct(')', '', open);
    suffix.noexcept = false;
  }
};

/** parameter-declaration: decl-specifiers declarator-or-abstract (= default)? */
Parser.prototype.parseParameter = function () {
  var spec = this.parseDeclSpecifiers();
  var declarator = this.parseDeclarator(true);
  var base = this.sema.typeFromSpecifiers(spec);
  var type = this.sema.typeFromDeclarator(base, declarator);
  var defaultArg = null;
  if (spec.storage && spec.storage !== 'register') {
    this.diagnostics.error('invalid storage class specifier in function declarator',
      spec.range);
  }
  if (type && this.sema.containsAuto(type)) {
    this.diagnostics.error('\'auto\' not allowed in function prototype', spec.range);
    type = this.sema.types.builtin('int');
  }
  if (type && T.isVoid(type)) {
    this.diagnostics.error(declarator.name ? 'argument may not have \'void\' type' :
      '\'void\' must be the first and only parameter if specified', declarator.range);
    type = this.sema.types.builtin('int');
  }
  if (this.acceptPunct('=')) {
    defaultArg = this.parseAssignmentExpression();
  }
  return { name: declarator.name, type: type || this.sema.types.builtin('int'),
    defaultArg: defaultArg, range: declarator.range };
};

/** type-id: type-specifier-seq abstract-declarator (C++11 8.1). */
Parser.prototype.parseTypeId = function () {
  var spec = this.parseDeclSpecifiers();
  var declarator = this.parseDeclarator(true);
  var type;
  if (declarator.name) {
    this.diagnostics.error('type-id cannot have a name', declarator.range);
  }
  type = this.sema.typeFromDeclarator(this.sema.typeFromSpecifiers(spec), declarator);
  return type || this.sema.types.builtin('int');
};

/** Whether a type (a conversion function) follows the next `operator`. */
Parser.prototype._conversionAfterOperator = function () {
  var i = 0;
  while (!this.isKeyword('operator', i)) {
    i++;
  }
  return this.startsTypeId(i + 1);
};

Parser.prototype._parseOutOfLineConversion = function () {
  var declarator = this.parseDeclarator(false);
  var spec = { builtins: [], namedType: declarator.conversionType, isConst: false,
    isVolatile: false, isAuto: false, isTypedef: false, storage: '', isInline: false,
    isVirtual: false, isExplicit: false, isConstexpr: false, isThreadLocal: false,
    isFriend: false, range: declarator.range, tagDecl: null };
  if (!declarator.qualifier || declarator.qualifier.kind !== 'RecordDecl') {
    this.fail('conversion function must be a non-static member function', declarator.nameToken);
  }
  return this._parseOutOfLineMember(spec, declarator);
};

/**
 * Out-of-line definition of a member function: `R C::f(params) { ... }`.
 */
Parser.prototype._parseOutOfLineMember = function (spec, declarator) {
  var record = declarator.qualifier;
  var saved = this.sema.startClassMemberDefinition(record, declarator.name, declarator.range);
  var type;
  var decl = null;
  if (saved === null) {
    this._skipDefinitionRest();
    return [];
  }
  try {
    type = this.sema.typeFromDeclarator(this.sema.typeFromSpecifiers(spec), declarator);
    if (!T.isFunction(type)) {
      decl = this.sema.actOnStaticMemberDefinition(record, spec, declarator, type);
      // The initializer is looked up in the scope of the class (9.4.2/2).
      this.parseInitializer(decl);
      this.expectPunct(';', 'after declaration');
      return decl ? [decl] : [];
    }
    decl = this.sema.actOnOutOfLineMethod(spec, declarator, type, record);
    if (!this.isPunct('{')) {
      if (decl) {
        this.diagnostics.error('out-of-line declaration of a member must be a definition',
          declarator.range);
      }
      this.expectPunct(';', 'after top level declarator');
      return [];
    }
    if (!decl) {
      this._skipBraces();
      return [];
    }
    this.parseFunctionBody(decl);
  } finally {
    this.sema.actOnFinishQualifiedDeclaration(saved);
  }
  return [decl];
};

/** After a rejected definition: skips a body or up to `;`. */
Parser.prototype._skipDefinitionRest = function () {
  while (this.peek().kind !== TokenKind.EOF) {
    if (this.isPunct('{')) {
      this._skipBraces();
      return;
    }
    if (this.isPunct(';')) {
      this.next();
      return;
    }
    if (this.isPunct('(') || this.isPunct('[')) {
      this.next();
      this._skipBalanced();
      continue;
    }
    this.next();
  }
};

/** Function body: compound statement (step 1: minimal statements). */
Parser.prototype.parseFunctionBody = function (decl) {
  var body;
  var self = this;
  this.sema.actOnStartFunctionBody(decl);
  try {
    if (this.isPunct(':')) {
      this.withRecoveryUntilBrace(function () {
        self.parseMemberInitializers(decl);
      });
    }
    if (decl.methodKind === 'constructor') {
      this.sema.actOnFinishMemberInitializers(decl);
    }
    body = this.parseCompoundStatement(false);
  } finally {
    this.sema.actOnFinishFunctionBody(decl, body || null);
  }
};

module.exports = {
  Parser: Parser,
  ParseError: ParseError
};

require('./parse-expr');
require('./parse-stmt');
require('./parse-class');
require('./parse-template');
