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
function Parser(tokens, diagnostics, source) {
  this._tokens = tokens;
  this._pos = 0;
  this.diagnostics = diagnostics;
  this.sema = new Sema(diagnostics, source);
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
  var self = this;
  var decls;
  var i;
  while (this.peek().kind !== TokenKind.EOF) {
    if (this.isPunct('}')) {
      this.diagnostics.error('extraneous closing brace (\'}\')', this.rangeOf(this.next()));
      continue;
    }
    decls = this.withRecovery(function () {
      return self.parseDeclaration();
    });
    for (i = 0; decls && i < decls.length; i++) {
      this.sema.addTopLevel(decls[i]);
    }
  }
  return this.sema.translationUnit;
};

/**
 * declaration: empty-declaration | alias-declaration | simple-declaration |
 * function-definition (namespaces, linkage specifications and classes come
 * in later steps).
 *
 * @returns {Array.<Object>} The declarations introduced.
 */
Parser.prototype.parseDeclaration = function () {
  if (this.acceptPunct(';')) {
    return [];
  }
  if (this.isKeyword('using') && this.peek(1).kind === TokenKind.IDENTIFIER &&
      this.isPunct('=', 2)) {
    return [this.parseAliasDeclaration()];
  }
  return this.parseSimpleDeclaration();
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
  var spec = this.parseDeclSpecifiers();
  var decls = [];
  var declarator;
  var decl;
  if (this.acceptPunct(';')) {
    this.diagnostics.warning('declaration does not declare anything', spec.range);
    return [];
  }
  for (;;) {
    declarator = this.parseDeclarator(false);
    decl = this.sema.actOnDeclarator(spec, declarator);
    if (decl && decl.kind === 'FunctionDecl' && this.isPunct('{') && !decls.length) {
      if (this.sema.currentFunction()) {
        this.fail('function definition is not allowed here');
      }
      this.parseFunctionBody(decl);
      return [decl];
    }
    this.parseInitializer(decl);
    if (decl) {
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
  if (this.acceptPunct('=')) {
    style = 'copy';
    init = this.isPunct('{') ? this.parseBracedInitList() : this.parseAssignmentExpression();
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
    isConstexpr: false, isThreadLocal: false, isFriend: false, range: null
  };
  var first = this.peek();
  var tok;
  var hasType = false;
  var info;
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
      } else {
        break;
      }
      this.next();
      continue;
    }
    if (tok.kind === TokenKind.IDENTIFIER && !hasType) {
      info = this.sema.classifyName(tok.value);
      if (info.kind === 'type') {
        spec.namedType = info.type;
        hasType = true;
        this.next();
        continue;
      }
      if (info.kind === 'unknown' && this._looksLikeDeclaratorStart(1)) {
        // `foo x;` with an unknown `foo`: Clang's "unknown type name".
        this.diagnostics.error('unknown type name \'' + tok.value + '\'', this.rangeOf(tok));
        spec.namedType = this.sema.types.builtin('int');
        hasType = true;
        this.next();
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
  var info;
  if (tok.kind === TokenKind.KEYWORD) {
    return !!(BUILTIN_TYPE_WORDS[tok.value] || STORAGE_WORDS[tok.value] ||
      FUNCTION_SPECIFIER_WORDS[tok.value] || tok.value === 'const' ||
      tok.value === 'volatile' || tok.value === 'auto' || tok.value === 'typedef' ||
      tok.value === 'constexpr' || tok.value === 'friend');
  }
  if (tok.kind === TokenKind.IDENTIFIER) {
    info = this.sema.classifyName(tok.value);
    return info.kind === 'type';
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
  var declarator = { ptrOps: [], name: null, nameToken: null, nested: null, suffixes: [],
    range: null };
  var tok;
  var op;
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
  if (tok.kind === TokenKind.IDENTIFIER) {
    this.next();
    declarator.name = tok.value;
    declarator.nameToken = tok;
  } else if (this.isPunct('(') && this._isNestedDeclarator(abstract)) {
    this.next();
    declarator.nested = this.parseDeclarator(abstract);
    this.expectPunct(')', '', tok);
    declarator.name = declarator.nested.name;
    declarator.nameToken = declarator.nested.nameToken;
  } else if (!abstract) {
    this.fail('expected unqualified-id');
  }

  this._parseDeclaratorSuffixes(declarator, abstract);
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
Parser.prototype.parseFunctionSuffix = function () {
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
  for (;;) {
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
    suffix.trailingReturn = this.parseTypeId();
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

/** Function body: compound statement (step 1: minimal statements). */
Parser.prototype.parseFunctionBody = function (decl) {
  var body;
  this.sema.actOnStartFunctionBody(decl);
  try {
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
