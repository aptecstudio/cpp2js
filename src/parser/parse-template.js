'use strict';

/**
 * Template parsing (extends Parser.prototype), C++11 clause 14, D-059.
 *
 * A template declaration is not analysed where it is written: its tokens
 * are skipped and recorded. Instantiation moves the parser back to those
 * tokens with the template parameters bound to the arguments.
 */

var Parser = require('./parser').Parser;
var TokenKind = require('../lexer/lexer').TokenKind;
var T = require('../semantic/types');
var ScopeKind = require('../semantic/scope').ScopeKind;

// ---------------------------------------------------------------------------
// Parser state, for instantiations that re-parse other tokens.

Parser.prototype._saveState = function () {
  return {
    pos: this._pos,
    scope: this.sema.scope,
    linkage: this._linkage,
    linkageUnbraced: this._linkageUnbraced,
    classDepth: this._classDepth,
    delayed: this._delayedBodies,
    argDepth: this._templateArgDepth,
    splitGreater: this._splitGreater,
    breakables: this.sema._breakableStack,
    functionStates: this.sema._functionStates
  };
};

Parser.prototype._restoreState = function (state) {
  this._pos = state.pos;
  this.sema.scope = state.scope;
  this._linkage = state.linkage;
  this._linkageUnbraced = state.linkageUnbraced;
  this._classDepth = state.classDepth;
  this._delayedBodies = state.delayed;
  this._templateArgDepth = state.argDepth;
  this._splitGreater = state.splitGreater;
  this.sema._breakableStack = state.breakables;
  this.sema._functionStates = state.functionStates;
};

/** A fresh state for parsing a template's tokens. */
Parser.prototype._resetForInstantiation = function () {
  this._linkage = null;
  this._linkageUnbraced = false;
  this._classDepth = 0;
  this._delayedBodies = [];
  this._templateArgDepth = 0;
  this._splitGreater = false;
  this.sema._breakableStack = [];
  this.sema._functionStates = [];
};

// ---------------------------------------------------------------------------
// Angle brackets.

/** Whether the current token closes a template argument list. */
Parser.prototype._atCloseAngle = function () {
  return this._splitGreater || this.isPunct('>') || this.isPunct('>>');
};

/** Consumes a `>`; a `>>` closes two lists (C++11 14.2/3). */
Parser.prototype._closeAngle = function (open) {
  if (this._splitGreater) {
    this._splitGreater = false;
    return;
  }
  if (this.isPunct('>>')) {
    this.next();
    this._splitGreater = true;
    return;
  }
  this.expectPunct('>', '', open);
};

/**
 * Skips a template argument or default (to `,` or the closing `>` at
 * depth 0), recognizing nested template-ids by name.
 *
 * @returns {{start: number, end: number}} Token positions.
 */
Parser.prototype._skipTemplateArgument = function () {
  var start = this._pos;
  var angle = 0;
  var depth = 0;
  var tok;
  var prev;
  for (;;) {
    tok = this.peek();
    if (tok.kind === TokenKind.EOF) {
      break;
    }
    if (tok.kind === TokenKind.PUNCT) {
      if (depth === 0 && angle === 0 && (tok.value === ',' || tok.value === '>' ||
          tok.value === '>>')) {
        break;
      }
      if (tok.value === '(' || tok.value === '[' || tok.value === '{') {
        depth++;
      } else if (tok.value === ')' || tok.value === ']' || tok.value === '}') {
        if (depth === 0) {
          break;
        }
        depth--;
      } else if (depth === 0 && tok.value === '<' && prev &&
          prev.kind === TokenKind.IDENTIFIER &&
          this.sema.classifyName(prev.value).kind === 'template') {
        angle++;
      } else if (depth === 0 && angle > 0 && tok.value === '>') {
        angle--;
      } else if (depth === 0 && angle > 0 && tok.value === '>>') {
        angle = Math.max(angle - 2, 0);
      }
    }
    prev = tok;
    this.next();
  }
  return { start: start, end: this._pos };
};

// ---------------------------------------------------------------------------
// Template declarations.

/**
 * `template < parameter-list > declaration`.
 *
 * @returns {Array.<Object>} The TemplateDecl.
 */
Parser.prototype.parseTemplateDeclaration = function () {
  var keyword = this.next();
  var open;
  var params;
  var start;
  var info;
  if (this.sema.currentFunction()) {
    this.fail('templates can only be declared in namespace or class scope', keyword);
  }
  if (this.isPunct('<') && this.isPunct('>', 1)) {
    return this.parseExplicitSpecialization(keyword);
  }
  open = this.expectPunct('<', 'after \'template\'');
  params = this.parseTemplateParameters(open);
  start = this._pos;
  info = this._templatedDeclarationInfo(params, keyword);
  if (info.partial) {
    return [];
  }
  info.tokenStart = start;
  info.tokenEnd = this._pos;
  return [this.sema.actOnTemplateDecl(info)];
};

/**
 * template-parameter-list: `typename T`, `class... Ts`, `int N = 3`.
 * Parameter names are visible to later parameters' types and defaults.
 */
Parser.prototype.parseTemplateParameters = function (open) {
  var params = [];
  var start;
  var param;
  var spec;
  var declarator;
  var nameTok;
  this.sema.pushScope(ScopeKind.TEMPLATE, null);
  try {
    while (!this._atCloseAngle()) {
      start = this.peek();
      if ((this.isKeyword('typename') || this.isKeyword('class')) &&
          !(this.peek(1).kind === TokenKind.IDENTIFIER && this.isPunct('::', 2))) {
        this.next();
        param = { kind: 'type', name: null, isPack: !!this.acceptPunct('...'),
          defaultTokens: null, range: null };
        if (this.peek().kind === TokenKind.IDENTIFIER) {
          nameTok = this.next();
          param.name = nameTok.value;
        }
        if (this.acceptPunct('=')) {
          param.defaultTokens = this._skipTemplateArgument();
        }
        param.range = this.rangeFrom(start);
        if (param.name) {
          this.sema.scope.declare(param.name, this.sema.createDecl('TypedefDecl', param.range,
            { name: param.name, type: this.sema.dependentType(param.name) }));
        }
      } else if (this.isKeyword('template')) {
        this.fail('template template parameters are not supported yet');
      } else {
        spec = this.parseDeclSpecifiers();
        param = { kind: 'value', name: null, isPack: !!this.acceptPunct('...'),
          defaultTokens: null, range: null };
        declarator = this.parseDeclarator(true);
        param.name = declarator.name;
        param.type = this.sema.typeFromDeclarator(this.sema.typeFromSpecifiers(spec),
          declarator);
        if (!T.isIntegral(param.type) && !T.isEnum(param.type)) {
          this.diagnostics.error('non-type template parameters of type ' +
            this.sema.quote(param.type) + ' are not supported yet', this.rangeFrom(start));
          param.type = this.sema.types.builtin('int');
        }
        if (this.acceptPunct('=')) {
          param.defaultTokens = this._skipTemplateArgument();
        }
        param.range = this.rangeFrom(start);
      }
      if (param.isPack && param.defaultTokens) {
        this.diagnostics.error('template parameter pack cannot have a default argument',
          param.range);
      }
      params.push(param);
      if (!this.acceptPunct(',')) {
        break;
      }
    }
    this._closeAngle(open);
  } finally {
    this.sema.popScope();
  }
  this._checkTemplateParameters(params);
  return params;
};

Parser.prototype._checkTemplateParameters = function (params) {
  var seen = Object.create(null);
  var self = this;
  var defaulted = false;
  params.forEach(function (p, i) {
    if (p.name && seen[p.name]) {
      self.diagnostics.error('declaration of \'' + p.name + '\' shadows template parameter',
        p.range);
    }
    if (p.name) {
      seen[p.name] = true;
    }
    if (p.isPack && i !== params.length - 1) {
      self.diagnostics.error('template parameter pack must be the last template parameter',
        p.range);
    }
    if (p.defaultTokens) {
      defaulted = true;
    } else if (defaulted && !p.isPack) {
      self.diagnostics.error('template parameter missing a default argument', p.range);
    }
  });
};

/**
 * Identifies and skips the declaration following a template parameter
 * list.
 *
 * @returns {Object} Info for Sema.actOnTemplateDecl.
 */
Parser.prototype._templatedDeclarationInfo = function (params, keyword) {
  var tok = this.peek();
  var nameTok;
  var isDefinition;
  var pattern;
  var i;
  if (tok.kind === TokenKind.KEYWORD && (tok.value === 'class' || tok.value === 'struct' ||
      tok.value === 'union')) {
    nameTok = this.peek(1);
    if (nameTok.kind !== TokenKind.IDENTIFIER) {
      this.fail('expected identifier');
    }
    if (this.isPunct('<', 2)) {
      return this.parsePartialSpecialization(params, keyword);
    }
    i = 2;
    if (this.peek(2).kind === TokenKind.IDENTIFIER && this.peek(2).value === 'final') {
      i = 3;
    }
    isDefinition = this.isPunct('{', i) || this.isPunct(':', i);
    if (isDefinition) {
      this._skipTo('{');
      this._skipBraces();
    } else {
      this._skip(2);
    }
    this.expectPunct(';', 'after class');
    return { name: nameTok.value, params: params, templateKind: 'class',
      isDefinition: isDefinition, range: this.rangeOf(nameTok) };
  }
  if (this.isKeyword('using') && this.peek(1).kind === TokenKind.IDENTIFIER &&
      this.isPunct('=', 2)) {
    nameTok = this.peek(1);
    this._skipTo(';');
    this.expectPunct(';', 'after alias declaration');
    return { name: nameTok.value, params: params, templateKind: 'alias', isDefinition: true,
      range: this.rangeOf(nameTok) };
  }
  if (this.isKeyword('template')) {
    this.fail('member templates of class templates are not supported yet');
  }
  nameTok = this._functionTemplateName();
  pattern = this._parseSignaturePattern(params);
  this._skipDefinitionRest();
  return { name: nameTok.value, params: params, templateKind: 'function',
    isDefinition: this.isPunct('}', -1), pattern: pattern, range: this.rangeOf(nameTok) };
};

/**
 * Analyses a function template's signature once, with each parameter
 * replaced by a placeholder, to get the pattern used for deduction. Errors
 * are discarded: the real check happens at instantiation.
 *
 * @returns {?{type: Object, requiredArgs: number, key: string}}
 */
Parser.prototype._parseSignaturePattern = function (params) {
  var state = this._saveState();
  var saved = this._swapDiagnostics();
  var placeholders = this.sema.placeholderArguments({ params: params });
  var spec;
  var declarator;
  var type;
  var suffix;
  var required;
  var pack;
  try {
    this.sema.scope = this.sema.bindTemplateParameters({ params: params,
      scope: this.sema.scope }, placeholders);
    this._patternMode = (this._patternMode || 0) + 1;
    spec = this.parseDeclSpecifiers();
    declarator = this.parseDeclarator(false);
    type = this.sema.typeFromDeclarator(this.sema.typeFromSpecifiers(spec), declarator);
  } catch (err) {
    type = null;
    if (!(err instanceof require('./parser').ParseError)) {
      throw err;
    }
  } finally {
    this._patternMode--;
    this._swapDiagnostics(saved);
    this._restoreState(state);
  }
  if (!type || !T.isFunction(type)) {
    return null;
  }
  suffix = declarator.suffixes[0] || { params: [] };
  required = suffix.params.length;
  while (required > 0 && suffix.params[required - 1].defaultArg) {
    required--;
  }
  pack = suffix.params.filter(function (p) { return p.isPatternPack; })[0];
  if (pack) {
    // A trailing function parameter pack takes any number of arguments.
    required = suffix.params.indexOf(pack);
    return { type: type, requiredArgs: required, key: this.sema.patternKey(type) + '...',
      packAt: suffix.params.indexOf(pack), packParam: pack.packParam };
  }
  return { type: type, requiredArgs: required, key: this.sema.patternKey(type) };
};

/**
 * Sends diagnostics to a throwaway bag (no argument) or restores the
 * previous one (argument).
 */
Parser.prototype._swapDiagnostics = function (saved) {
  var Bag = require('../diagnostics/diagnostic-bag');
  var previous = this.diagnostics;
  var next = saved || new Bag();
  this.diagnostics = next;
  this.sema.diagnostics = next;
  return previous;
};

/**
 * The declarator-id of a function template: the identifier before the
 * first top-level `(` that is not part of `decltype(...)`.
 */
Parser.prototype._functionTemplateName = function () {
  var i = 0;
  var depth = 0;
  var tok;
  var prev = null;
  for (;;) {
    tok = this.peek(i);
    if (tok.kind === TokenKind.EOF || (depth === 0 && tok.kind === TokenKind.PUNCT &&
        (tok.value === ';' || tok.value === '{'))) {
      this.fail('expected a function or class after template parameter list');
    }
    if (tok.kind === TokenKind.PUNCT && tok.value === '(') {
      if (depth === 0 && prev && prev.kind === TokenKind.IDENTIFIER) {
        if (this.isPunct('::', i - 2)) {
          this.fail('out-of-line members of class templates are not supported yet');
        }
        return prev;
      }
      if (depth === 0 && prev && prev.kind === TokenKind.KEYWORD &&
          prev.value === 'operator') {
        return { value: 'operator()', kind: TokenKind.IDENTIFIER, source: prev.source,
          start: prev.start, end: prev.end, expansion: prev.expansion };
      }
      if (depth === 0 && prev && prev.kind === TokenKind.PUNCT && this.isKeyword('operator',
          i - 2)) {
        return { value: 'operator' + prev.value, kind: TokenKind.IDENTIFIER,
          source: prev.source, start: prev.start, end: prev.end, expansion: prev.expansion };
      }
      depth++;
    } else if (tok.kind === TokenKind.PUNCT && tok.value === ')') {
      depth--;
    }
    prev = tok;
    i++;
  }
};

/** The primary class template named by `name`, or a failure. */
Parser.prototype._primaryClassTemplate = function (nameTok) {
  var info = this.sema.classifyName(nameTok.value);
  if (info.kind !== 'template' || info.decls[0].templateKind !== 'class') {
    this.fail('\'' + nameTok.value + '\' is not a class template', nameTok);
  }
  return info.decls[0];
};

/**
 * `template <params> class X<pattern> { ... };` — a partial
 * specialization, recorded on the primary template (14.5.5).
 */
Parser.prototype.parsePartialSpecialization = function (params) {
  var tokenStart = this._pos;
  var nameTok = this.peek(1);
  var primary = this._primaryClassTemplate(nameTok);
  var state;
  var saved;
  var patternArgs = null;
  var self = this;
  this._skip(2);
  state = this._saveState();
  saved = this._swapDiagnostics();
  try {
    this.sema.scope = this.sema.bindTemplateParameters({ params: params,
      scope: this.sema.scope }, this.sema.placeholderArguments({ params: params }));
    this._patternMode = (this._patternMode || 0) + 1;
    patternArgs = this.withRecovery(function () {
      return self.parseTemplateArguments(primary);
    });
  } finally {
    this._patternMode--;
    this._swapDiagnostics(saved);
    state.pos = this._pos;
    this._restoreState(state);
  }
  if (!patternArgs) {
    this.fail('invalid template arguments in partial specialization', nameTok);
  }
  if (!this.isPunct('{') && !this.isPunct(':')) {
    this.fail('partial specializations must be definitions', nameTok);
  }
  this._skipTo('{');
  this._skipBraces();
  this.expectPunct(';', 'after class');
  primary.specializations.push({ params: params, patternArgs: patternArgs,
    tokenStart: tokenStart, range: this.rangeOf(nameTok) });
  return { partial: true };
};

/**
 * `template <> class X<args> { ... };` or `template <> R f<args>(...)`
 * (14.7.3): the specialization replaces the instantiation for those
 * arguments.
 */
Parser.prototype.parseExplicitSpecialization = function () {
  var nameTok;
  var primary;
  var args;
  var key;
  var record;
  var tag;
  this.next();
  this.next();
  if (this.isKeyword('class') || this.isKeyword('struct') || this.isKeyword('union')) {
    tag = this.next().value;
    nameTok = this.next();
    primary = this._primaryClassTemplate(nameTok);
    if (!this.isPunct('<')) {
      this.fail('expected \'<\' after the name of an explicit specialization');
    }
    args = this.parseTemplateArguments(primary);
    args = args && this.completeTemplateArguments(primary, args, this.rangeOf(nameTok));
    if (!args) {
      this._skipDefinitionRest();
      return [];
    }
    key = this.sema.instantiationKey(args);
    if (primary.instantiations[key] && !primary.instantiations[key].isExplicitSpecialization) {
      this.diagnostics.error('explicit specialization of ' + this.sema.quote(
        this.sema.types.record(primary.instantiations[key])) + ' after instantiation',
        this.rangeOf(nameTok));
      this._skipDefinitionRest();
      return [];
    }
    record = this.sema.startClassInstantiation({ template: primary, args: args, key: key },
      tag, this.rangeOf(nameTok));
    record.isExplicitSpecialization = true;
    if (this.isPunct(':')) {
      this.parseBaseClause(record);
    }
    if (this.isPunct('{')) {
      this.parseClassBody(record);
    }
    this.expectPunct(';', 'after class');
    this.sema.finishClassInstantiation(record);
    return [];
  }
  return this._parseFunctionSpecialization();
};

/** Explicit specialization of a function template. */
Parser.prototype._parseFunctionSpecialization = function () {
  var start = this.peek();
  var decls;
  var decl;
  var candidates;
  var self = this;
  var registered = false;
  this.sema.pushScope(ScopeKind.TEMPLATE, null);
  this._explicitSpecialization = (this._explicitSpecialization || 0) + 1;
  try {
    decls = this.parseSimpleDeclaration();
  } finally {
    this._explicitSpecialization--;
    this.sema.popScope();
  }
  decl = decls && decls[0];
  if (!decl || decl.kind !== 'FunctionDecl') {
    return [];
  }
  candidates = this.sema.classifyName(decl.name);
  (candidates.kind === 'template' ? candidates.decls : []).forEach(function (tmpl) {
    var deduced = [];
    var args;
    if (registered || tmpl.templateKind !== 'function' || !tmpl.pattern) {
      return;
    }
    (decl.explicitTemplateArgs || []).forEach(function (a, i) {
      deduced[i] = a;
    });
    if (!self.sema.matchExact(tmpl.pattern.type, decl.type, deduced)) {
      return;
    }
    args = self.completeTemplateArguments(tmpl, deduced, decl.range, true);
    if (!args) {
      return;
    }
    tmpl.instantiations[self.sema.instantiationKey(args)] = decl;
    decl.templateOf = tmpl;
    decl.templateArgs = args;
    decl.isExplicitSpecialization = true;
    self.sema.translationUnit.instantiations.push(decl);
    registered = true;
  });
  if (!registered) {
    this.diagnostics.error('no function template matches function template specialization \'' +
      decl.name + '\'', this.rangeOf(start));
  }
  return [];
};

// ---------------------------------------------------------------------------
// Template-ids and class template instantiation.

/**
 * Parses `< template-argument-list >` for a known template, filling
 * default arguments.
 *
 * @returns {?Array.<Object>} Arguments, or null after an error.
 */
Parser.prototype.parseTemplateArguments = function (tmpl) {
  var open = this.next();
  var args = [];
  var params = tmpl.params;
  var start;
  var param;
  var expr;
  var arg;
  var dots;
  this._templateArgDepth = (this._templateArgDepth || 0) + 1;
  try {
    while (!this._atCloseAngle()) {
      start = this.peek();
      dots = this._findExpansionEnd(true);
      if (dots >= 0) {
        // `Ts...` / `Ns...`: one argument per pack element.
        args = args.concat(this._expandTemplateArgument(tmpl, args.length, dots));
        if (!this.acceptPunct(',')) {
          break;
        }
        continue;
      }
      // Arguments beyond the parameters belong to the trailing pack.
      param = params[Math.min(args.length, params.length - 1)];
      if (param && param.kind === 'value') {
        expr = this.parseConditionalExpression();
        arg = expr ? this.sema.nonTypeArgument(param, expr, this.rangeFrom(start)) : null;
      } else if (this.startsTypeId(0)) {
        arg = { kind: 'type', type: this.parseTypeId(), range: this.rangeFrom(start) };
      } else {
        // An expression for a type parameter: reported by Sema's checks.
        expr = this.parseConditionalExpression();
        arg = expr ? { kind: 'value', value: null, type: expr.type,
          range: this.rangeFrom(start) } : null;
      }
      if (!arg) {
        this._skipTemplateArgument();
        args.push(null);
      } else {
        args.push(arg);
      }
      if (!this.acceptPunct(',')) {
        break;
      }
    }
  } finally {
    this._templateArgDepth--;
  }
  this._closeAngle(open);
  if (args.indexOf(null) !== -1) {
    return null;
  }
  return args;
};

/**
 * Groups trailing arguments into the parameter pack and fills defaults by
 * replaying their tokens with the previous parameters bound.
 *
 * @returns {?Array.<Object>}
 */
Parser.prototype.completeTemplateArguments = function (tmpl, args, range, deduced) {
  var params = tmpl.params;
  var out = [];
  var i;
  var state;
  var arg;
  var start;
  if (!deduced && !this.sema.checkTemplateArguments(tmpl, args.concat(params.slice(args.length)
    .filter(function (p) { return p.defaultTokens; }).map(function (p) {
      return { kind: p.kind };
    })), range)) {
    return null;
  }
  for (i = 0; i < params.length; i++) {
    if (params[i].isPack) {
      out.push(deduced && args[i] && args[i].kind === 'pack' ? args[i] :
        { kind: 'pack', elements: args.slice(i).filter(function (a) { return a; }) });
      break;
    }
    if (i < args.length && args[i]) {
      out.push(args[i]);
      continue;
    }
    if (!params[i].defaultTokens) {
      return null;
    }
    // Default argument: re-parse its tokens with earlier parameters bound.
    state = this._saveState();
    try {
      this._pos = params[i].defaultTokens.start;
      this.sema.scope = this.sema.bindTemplateParameters({ params: params.slice(0, i),
        scope: tmpl.scope }, out);
      start = this.peek();
      this._templateArgDepth = 1;
      if (params[i].kind === 'type') {
        arg = { kind: 'type', type: this.parseTypeId() };
      } else {
        arg = this.sema.nonTypeArgument(params[i], this.parseConditionalExpression(),
          this.rangeFrom(start));
      }
    } finally {
      this._restoreState(state);
    }
    if (!arg) {
      return null;
    }
    out.push(arg);
  }
  return out;
};

/**
 * Instantiates a class template with complete arguments (cached).
 *
 * @returns {Object} The record type of the specialization.
 */
Parser.prototype.instantiateClassTemplate = function (tmpl, args, range) {
  var key = this.sema.instantiationKey(args);
  var cached = tmpl.instantiations[key];
  var state;
  var spec;
  var record;
  var partial;
  if (cached) {
    return this.sema.types.record(cached);
  }
  // A partial specialization may be defined while the primary is not.
  partial = this.sema.selectPartialSpecialization(tmpl, args, range);
  if (!tmpl.isDefinition && !partial) {
    record = this.sema.startClassInstantiation({ template: tmpl, args: args, key: key }, 'class',
      range);
    return this.sema.types.record(record);
  }
  state = this._saveState();
  this._resetForInstantiation();
  this._classInstantiations = (this._classInstantiations || 0) + 1;
  try {
    if (partial) {
      // Replay the partial specialization with its own parameters.
      this._pos = partial.spec.tokenStart;
      this.sema.scope = this.sema.bindTemplateParameters({ params: partial.spec.params,
        scope: tmpl.scope }, partial.args);
    } else {
      this._pos = tmpl.tokenStart;
      this.sema.scope = this.sema.bindTemplateParameters(tmpl, args);
    }
    this.sema._classInstantiationTarget = { template: tmpl, args: args, key: key };
    spec = this._emptySpec();
    this.withRecovery(function () {
      this.parseClassSpecifier(spec);
    });
  } finally {
    this._classInstantiations--;
    this.sema._classInstantiationTarget = null;
    this._restoreState(state);
  }
  record = tmpl.instantiations[key];
  this.sema.finishClassInstantiation(record);
  return this.sema.types.record(record);
};

/** decl-specifiers with nothing set. */
Parser.prototype._emptySpec = function () {
  return { builtins: [], namedType: null, isConst: false, isVolatile: false, isAuto: false,
    isTypedef: false, storage: '', isInline: false, isVirtual: false, isExplicit: false,
    isConstexpr: false, isThreadLocal: false, isFriend: false, range: null, tagDecl: null };
};

/**
 * Parses `Name<args>` at the current position (the name is the current
 * token) and returns the named type or template. Results are cached by
 * position, so a tentative parse during name scanning and the real one
 * agree and report errors once.
 *
 * @returns {{end: number, type: ?Object, template: Object, args: ?Array}}
 */
Parser.prototype.parseTemplateIdAt = function (index, tmpl) {
  var cache = this._templateIdCache = this._templateIdCache || Object.create(null);
  var key = index + ':' + (this.sema.scope.templateArgs ? this._instantiationKeyOf() : '');
  var state;
  var result;
  var nameTok;
  var args;
  if (cache[key]) {
    return cache[key];
  }
  state = this._saveState();
  try {
    this._pos = index;
    nameTok = this.next();
    args = this.parseTemplateArguments(tmpl);
    result = { end: this._pos, template: tmpl, args: null, type: null };
    if (args) {
      result.args = this.completeTemplateArguments(tmpl, args, this.rangeFrom(nameTok));
    }
    if (result.args && tmpl.templateKind === 'class' &&
        this.sema.isDependentArgumentList(result.args)) {
      result.type = this.sema.dependentSpecialization(tmpl, result.args);
    } else if (result.args && tmpl.templateKind === 'class') {
      result.type = this.instantiateClassTemplate(tmpl, result.args, this.rangeFrom(nameTok));
    } else if (result.args && tmpl.templateKind === 'alias') {
      result.type = this.instantiateAliasTemplate(tmpl, result.args);
    }
    result.splitGreater = this._splitGreater;
  } finally {
    this._restoreState(state);
  }
  cache[key] = result;
  return result;
};

/** Distinguishes template-ids re-parsed inside different instantiations. */
Parser.prototype._instantiationKeyOf = function () {
  var scope = this.sema.scope;
  var keys = [];
  while (scope) {
    if (scope.templateArgs) {
      keys.push(scope.template.id + '=' + this.sema.instantiationKey(scope.templateArgs));
    }
    scope = scope.parent;
  }
  return keys.join(';');
};

/**
 * `template <params> using A = type-id;`: `A<args>` is the type-id with
 * the parameters bound (14.5.7). Aliases are transparent, so with
 * dependent arguments the result is a dependent type that deduction sees
 * through.
 *
 * @returns {Object} The aliased type.
 */
Parser.prototype.instantiateAliasTemplate = function (tmpl, args) {
  var dependent = this.sema.isDependentArgumentList(args);
  var key = dependent ? null : this.sema.instantiationKey(args);
  var state;
  var type;
  if (key !== null && tmpl.instantiations[key]) {
    return tmpl.instantiations[key];
  }
  state = this._saveState();
  this._resetForInstantiation();
  try {
    this._pos = tmpl.tokenStart;
    this.sema.scope = this.sema.bindTemplateParameters(tmpl, args);
    this.next();
    this.next();
    this.expectPunct('=');
    type = this.parseTypeId();
  } finally {
    this._restoreState(state);
  }
  if (key !== null) {
    tmpl.instantiations[key] = type;
  }
  return type;
};

// ---------------------------------------------------------------------------
// Lazy bodies.

/** Instantiates the queued member function bodies (end of the unit). */
Parser.prototype.processPendingInstantiations = function () {
  var queue = this.sema.pendingInstantiations || [];
  var decl;
  var state;
  var self = this;
  var guard = 0;
  while (queue.length && guard++ < 10000) {
    decl = queue.shift();
    state = this._saveState();
    this._resetForInstantiation();
    try {
      this._pos = decl.pendingBody.pos;
      this.sema.scope = decl.pendingBody.scope;
      this.withRecovery(function () {
        self.parseFunctionBody(decl);
      });
    } finally {
      this._restoreState(state);
    }
    if (decl.templateOf && this.sema.translationUnit.instantiations.indexOf(decl) === -1) {
      this.sema.translationUnit.instantiations.push(decl);
    }
    queue = this.sema.pendingInstantiations;
  }
};

/**
 * Inside a class template instantiation, member function bodies are
 * instantiated only when used: the body's position is recorded instead
 * of parsing it with the other delayed bodies.
 *
 * @returns {boolean} Whether the body was deferred.
 */
Parser.prototype._deferTemplateBody = function (decl, scope) {
  if (!this._classInstantiations || !decl) {
    return false;
  }
  decl.pendingBody = { pos: this._pos, scope: scope };
  if (decl.isVirtual || decl.methodKind === 'destructor') {
    // Virtual functions and destructors are needed by any object.
    this.sema.requireDefinition(decl);
  }
  return true;
};

// ---------------------------------------------------------------------------
// Function template instantiation.

/**
 * Instantiates the declaration of a function template specialization.
 * With `sfinae`, errors make the instantiation fail silently (C++11
 * 14.8.2/8); the body is instantiated later, when the function is used.
 *
 * @returns {?Object} FunctionDecl, or null on substitution failure.
 */
Parser.prototype.instantiateFunctionTemplate = function (tmpl, args, sfinae) {
  var key;
  var cached;
  var state;
  var saved;
  var decls = null;
  var decl;
  var self = this;
  var failed;
  var bound;
  args = this.completeTemplateArguments(tmpl, args, tmpl.range, true);
  if (!args) {
    return null;
  }
  key = this.sema.instantiationKey(args);
  cached = tmpl.instantiations[key];
  if (cached !== undefined) {
    return cached;
  }
  state = this._saveState();
  this._resetForInstantiation();
  saved = sfinae ? this._swapDiagnostics() : null;
  try {
    this._pos = tmpl.tokenStart;
    bound = this.sema.bindTemplateParameters(tmpl, args);
    this.sema.scope = bound;
    this._functionInstantiation = (this._functionInstantiation || 0) + 1;
    decls = this.withRecovery(function () {
      return self.parseSimpleDeclaration();
    });
    // The specialization is not a name of its own: in its body, the name
    // still denotes the template (and its overloads).
    bound.forget(tmpl.name);
  } finally {
    this._functionInstantiation--;
    failed = !!saved && this.diagnostics.hasErrors();
    if (saved) {
      this._swapDiagnostics(saved);
    }
    this._restoreState(state);
  }
  decl = decls && decls[0] && decls[0].kind === 'FunctionDecl' && !failed ? decls[0] : null;
  if (decl) {
    decl.templateOf = tmpl;
    decl.templateArgs = args;
    decl.qualifiedName = (tmpl.qualifiedName || tmpl.name) + this.sema.argumentsToString(args);
  }
  tmpl.instantiations[key] = decl;
  return decl;
};

/**
 * In a function template instantiation, the body is recorded instead of
 * parsed (it is instantiated when the function is used).
 *
 * @returns {boolean}
 */
Parser.prototype._deferFunctionTemplateBody = function (decl) {
  if (!this._functionInstantiation || !decl || decl.kind !== 'FunctionDecl') {
    return false;
  }
  decl.pendingBody = { pos: this._pos, scope: this.sema.scope };
  this._skipBraces();
  return true;
};

// ---------------------------------------------------------------------------
// Pack expansions (C++11 14.5.3/4).

/**
 * If the element starting at the current token is a pack expansion
 * (ends with `...`), returns the position of the `...`, else -1.
 *
 * @param {boolean} inAngles The element is a template argument.
 */
Parser.prototype._findExpansionEnd = function (inAngles) {
  var i = this._pos;
  var depth = 0;
  var tok;
  var prev = null;
  for (;;) {
    tok = this._tokens[i];
    if (!tok || tok.kind === TokenKind.EOF) {
      return -1;
    }
    if (tok.kind === TokenKind.PUNCT) {
      if (tok.value === '(' || tok.value === '[' || tok.value === '{') {
        depth++;
      } else if (tok.value === ')' || tok.value === ']' || tok.value === '}') {
        if (depth === 0) {
          break;
        }
        depth--;
      } else if (depth === 0 && (tok.value === ',' || tok.value === ';' ||
          (inAngles && (tok.value === '>' || tok.value === '>>')))) {
        break;
      } else if (inAngles && tok.value === '<' && prev && prev.kind === TokenKind.IDENTIFIER &&
          this.sema.classifyName(prev.value).kind === 'template') {
        depth++;
        prev = tok;
        i++;
        while (depth > 0 && this._tokens[i] && this._tokens[i].kind !== TokenKind.EOF) {
          if (this._tokens[i].value === '<') {
            depth++;
          } else if (this._tokens[i].value === '>') {
            depth--;
          } else if (this._tokens[i].value === '>>') {
            depth -= 2;
          }
          i++;
        }
        if (depth < 0) {
          return -1;
        }
        depth = 0;
        prev = this._tokens[i - 1];
        continue;
      }
    }
    prev = tok;
    i++;
  }
  return prev && prev.kind === TokenKind.PUNCT && prev.value === '...' ? i - 1 : -1;
};

/** Parameter packs named between two token positions. */
Parser.prototype._packsIn = function (start, end) {
  var packs = [];
  var i;
  var decl;
  for (i = start; i < end; i++) {
    if (this._tokens[i].kind === TokenKind.IDENTIFIER) {
      decl = require('../semantic/scope').lookupUnqualified(this.sema.scope,
        this._tokens[i].value).decls[0];
      if (this.sema.packElements(decl) && this.sema.packIndex(decl) === undefined &&
          packs.indexOf(decl) === -1) {
        packs.push(decl);
      }
    }
  }
  return packs;
};

/**
 * Re-parses the pattern between the current position and `dots` once per
 * pack element, each time with the packs naming that element.
 *
 * @param {function(number): *} parseOne Parses one instance.
 * @returns {Array} The parsed instances.
 */
Parser.prototype._expand = function (dots, parseOne) {
  var start = this._pos;
  var packs = this._packsIn(start, dots);
  var length;
  var out = [];
  var saved = this.sema.packIndices;
  var savedDots = this._expansionDots;
  var i;
  var self = this;
  if (!packs.length) {
    this.fail('pattern of pack expansion contains no unexpanded parameter packs',
      this._tokens[dots]);
  }
  length = this.sema.packElements(packs[0]).length;
  packs.forEach(function (p) {
    if (self.sema.packElements(p).length !== length) {
      self.fail('pack expansion contains parameter packs \'' + packs[0].name + '\' and \'' +
        p.name + '\' that have different lengths (' + length + ' vs. ' +
        self.sema.packElements(p).length + ')', self._tokens[dots]);
    }
  });
  try {
    // The `...` ends the pattern: declarators must not take it.
    this._expansionDots = dots;
    for (i = 0; i < length; i++) {
      this.sema.packIndices = Object.create(saved || null);
      packs.forEach(function (p) {
        self.sema.packIndices[p.id] = i;
      });
      this._pos = start;
      out.push(parseOne.call(this, i));
      if (this._pos !== dots) {
        this.fail('expected \'...\'');
      }
    }
  } finally {
    this.sema.packIndices = saved;
    this._expansionDots = savedDots;
  }
  this._pos = dots + 1;
  return out;
};

/** A pack expansion inside a template argument list. */
Parser.prototype._expandTemplateArgument = function (tmpl, position, dots) {
  var params = tmpl.params;
  var self = this;
  var pattern = !!this._patternMode;
  var packs = this._packsIn(this._pos, dots);
  var args = this._expand(dots, function () {
    var param = params[Math.min(position, params.length - 1)];
    var start = self.peek();
    var expr;
    if (param && param.kind === 'value') {
      expr = self.parseConditionalExpression();
      return expr ? self.sema.nonTypeArgument(param, expr, self.rangeFrom(start)) : null;
    }
    return { kind: 'type', type: self.parseTypeId(), range: self.rangeFrom(start) };
  });
  if (pattern && packs.length && this.sema.packElements(packs[0]).length === 1 &&
      this.sema.packElements(packs[0])[0].packElement && args[0]) {
    // In a pattern, `T...` stands for any number of arguments.
    args[0].packExpansion = true;
    args[0].packParam = packs[0].templateParamIndex;
  }
  return args;
};

