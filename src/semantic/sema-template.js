'use strict';

/**
 * Templates (C++11 clause 14), extends Sema.prototype, D-059.
 *
 * A template keeps the token range of its declaration. Instantiating it
 * re-parses those tokens in a scope where every template parameter is
 * bound to its argument (types as typedefs, values as constants), so the
 * instantiated code is fully checked with concrete types. Instantiations
 * are cached by their arguments. Member function bodies of class
 * templates are instantiated only when used (14.7.1), at the end of the
 * translation unit.
 */

var ast = require('../ast/nodes');
var T = require('./types');
var I = require('../util/int64');
var scopes = require('./scope');
var Sema = require('./sema').Sema;

var Scope = scopes.Scope;
var ScopeKind = scopes.ScopeKind;

/**
 * Declares a template (or completes a forward-declared class template).
 *
 * @param {Object} info `{name, params, templateKind ('class'|'function'|
 *   'alias'), tokenStart, tokenEnd, isDefinition, range}`.
 * @returns {Object} TemplateDecl.
 */
Sema.prototype.actOnTemplateDecl = function (info, options) {
  var noDeclare = !!(options && options.noDeclare);
  var previous = noDeclare ? [] : this.scope.lookupLocal(info.name).filter(function (d) {
    // Function templates merge only with the same signature.
    return d.kind === 'TemplateDecl' && (info.templateKind !== 'function' ||
      (d.templateKind === 'function' && d.pattern && info.pattern &&
        d.pattern.key === info.pattern.key));
  });
  var decl;
  var diag;
  var other;
  if (previous.length) {
    decl = previous[0];
    if (decl.templateKind !== info.templateKind) {
      diag = this.error('redefinition of \'' + info.name + '\' as different kind of symbol',
        info.range);
      this.note(diag, 'previous definition is here', decl.range);
      return decl;
    }
    if (info.isDefinition && decl.isDefinition) {
      diag = this.error('redefinition of \'' + info.name + '\'', info.range);
      this.note(diag, 'previous definition is here', decl.range);
      return decl;
    }
    if (info.params.length !== decl.params.length) {
      this.error('template parameter list does not match the previous declaration',
        info.range);
    }
    if (info.isDefinition) {
      decl.tokenStart = info.tokenStart;
      decl.tokenEnd = info.tokenEnd;
      decl.isDefinition = true;
      decl.params = mergeDefaults(decl.params, info.params);
      decl.range = info.range;
      decl.pattern = info.pattern || decl.pattern;
    }
    return decl;
  }
  other = this.scope.lookupLocal(info.name).filter(function (d) {
    return d.kind !== 'TemplateDecl' && d.kind !== 'FunctionDecl';
  });
  if (other.length && info.templateKind !== 'function' && !noDeclare) {
    diag = this.error('redefinition of \'' + info.name + '\' as different kind of symbol',
      info.range);
    this.note(diag, 'previous definition is here', other[0].range);
  }
  decl = this.createDecl('TemplateDecl', info.range, {
    name: info.name,
    params: info.params,
    templateKind: info.templateKind,
    parent: this.currentContext()
  });
  decl.tokenStart = info.tokenStart;
  decl.tokenEnd = info.tokenEnd;
  decl.isDefinition = info.isDefinition;
  decl.pattern = info.pattern || null;
  decl.scope = this.scope;
  decl.instantiations = Object.create(null);
  decl.specializations = [];
  decl.qualifiedName = this.qualifiedName(decl);
  if (!noDeclare) {
    this.scope.declare(info.name, decl);
  }
  return decl;
};

function mergeDefaults(oldParams, newParams) {
  return newParams.map(function (p, i) {
    if (!p.defaultTokens && oldParams[i] && oldParams[i].defaultTokens) {
      p.defaultTokens = oldParams[i].defaultTokens;
    }
    return p;
  });
}

/** Canonical key of a template argument list (types by id, values exactly). */
/** Whether an expression mentions a dependent value (signature patterns). */
function containsDependentValue(node) {
  var def;
  if (!node || typeof node !== 'object') {
    return false;
  }
  if (Array.isArray(node)) {
    return node.some(containsDependentValue);
  }
  if (node.kind === 'DependentExpr' || (node.kind === 'DeclRefExpr' && node.decl &&
      node.decl.dependentIndex !== undefined)) {
    return true;
  }
  def = ast.NODE_KINDS[node.kind];
  return !!def && def.children.some(function (child) {
    return containsDependentValue(node[child]);
  });
}

function argumentKey(args) {
  return args.map(function (a) {
    if (a.kind === 'type') {
      return 't' + a.type.id;
    }
    if (a.kind === 'pack') {
      return 'p(' + argumentKey(a.elements) + ')';
    }
    if (a.value === null && a.nonDeduced) {
      return 'e(' + a.spelling + ')';
    }
    if (a.value === null) {
      return 'd' + a.dependentIndex;
    }
    return 'v' + I.toString(a.value, true) + ':' + a.type.id;
  }).join(',');
}

/** Spells an argument list like Clang: `<int, 3>`. */
Sema.prototype.argumentsToString = function (args) {
  var self = this;
  return '<' + args.map(function (a) {
    if (a.kind === 'type') {
      return T.typeToString(a.type);
    }
    if (a.kind === 'pack') {
      return self.argumentsToString(a.elements).slice(1, -1);
    }
    if (T.isBool(a.type)) {
      return I.isZero(a.value) ? 'false' : 'true';
    }
    return I.toString(a.value, !T.isUnsigned(a.type));
  }).join(', ') + '>';
};

/**
 * Checks the arity of an argument list (filling defaults is done by the
 * parser, which replays their tokens) and the kind of each argument.
 *
 * @returns {boolean}
 */
Sema.prototype.checkTemplateArguments = function (tmpl, args, range) {
  var params = tmpl.params;
  var variadic = params.length && params[params.length - 1].isPack;
  var i;
  var diag;
  if ((!variadic && args.length > params.length) ||
      args.length < params.filter(function (p) { return !p.isPack; }).length) {
    diag = this.error('too ' + (args.length > params.length ? 'many' : 'few') +
      ' template arguments for ' + (tmpl.templateKind === 'class' ? 'class' :
        tmpl.templateKind === 'alias' ? 'alias' : 'function') + ' template \'' + tmpl.name + '\'',
      range);
    this.note(diag, 'template is declared here', tmpl.range);
    return false;
  }
  for (i = 0; i < args.length && i < params.length; i++) {
    if (params[i].isPack) {
      break;
    }
    if (params[i].kind === 'type' && args[i].kind !== 'type') {
      diag = this.error('template argument for template type parameter must be a type',
        args[i].range || range);
      this.note(diag, 'template parameter is declared here', params[i].range);
      return false;
    }
    if (params[i].kind === 'value' && args[i].kind !== 'value') {
      diag = this.error('template argument for non-type template parameter must be an ' +
        'expression', args[i].range || range);
      this.note(diag, 'template parameter is declared here', params[i].range);
      return false;
    }
  }
  return true;
};

/**
 * Converts a parsed non-type argument expression to the parameter's type
 * and evaluates it.
 *
 * @returns {?Object} `{kind: 'value', value, type}`.
 */
Sema.prototype.nonTypeArgument = function (param, expr, range) {
  var converted;
  var value;
  var raw;
  var rawValue;
  if (expr.kind === 'DeclRefExpr' && expr.decl.dependentIndex !== undefined) {
    return { kind: 'value', value: null, type: param.type.unqualified,
      dependentIndex: expr.decl.dependentIndex, range: range };
  }
  if (containsDependentValue(expr)) {
    // A value computed from template parameters: not deducible (14.8.2.5/5).
    return { kind: 'value', value: null, type: param.type.unqualified, nonDeduced: true,
      spelling: range && range.source ? range.source.text.slice(range.start, range.end)
        .replace(/\s+/g, '') : '?', range: range };
  }
  if (T.isFloating(expr.type)) {
    this.error('conversion from ' + this.quote(expr.type) + ' to ' + this.quote(param.type) +
      ' is not allowed in a converted constant expression', expr.range);
    return null;
  }
  converted = this.convertTo(expr, param.type, 'variable', true);
  value = converted ? this.evaluateConstantInt64(converted) : null;
  // A converted constant expression may not narrow (14.3.2/5).
  raw = value !== null && T.isIntegral(expr.type) ? this.rvalue(expr) : null;
  rawValue = raw ? this.evaluateConstantInt64(raw) : null;
  if (rawValue !== null && I.toString(rawValue, !T.isUnsigned(raw.type)) !==
      I.toString(value, !T.isUnsigned(param.type))) {
    this.error('non-type template argument evaluates to ' + I.toString(rawValue,
      !T.isUnsigned(raw.type)) + ', which cannot be narrowed to type ' +
      this.quote(param.type), expr.range);
    return null;
  }
  if (converted && value === null) {
    this.error('non-type template argument is not a constant expression', expr.range);
  }
  return value === null ? null : { kind: 'value', value: value, type: param.type.unqualified,
    range: range };
};

/**
 * Opens the scope where template parameters are bound to arguments.
 *
 * @param {Object} tmpl TemplateDecl.
 * @param {Array.<Object>} args Complete argument list (packs grouped).
 * @returns {Scope} The binding scope (child of the template's scope).
 */
Sema.prototype.bindTemplateParameters = function (tmpl, args) {
  var scope = new Scope(ScopeKind.TEMPLATE, tmpl.scope, null);
  var self = this;
  tmpl.params.forEach(function (param, i) {
    var arg = args[i];
    var decl;
    if (!param.name || !arg) {
      return;
    }
    if (param.isPack) {
      decl = self.createDecl('TypedefDecl', param.range, { name: param.name, type: null });
      decl.pack = arg.elements;
      decl.packKind = param.kind;
      decl.isTemplateParam = true;
      decl.templateParamIndex = i;
      scope.declare(param.name, decl);
      return;
    }
    if (arg.kind === 'type') {
      decl = self.createDecl('TypedefDecl', param.range, { name: param.name, type: arg.type });
    } else {
      decl = self.createDecl('EnumeratorDecl', param.range, { name: param.name,
        value: arg.value, type: arg.type });
      // A value parameter of a signature pattern has no value yet.
      decl.dependentIndex = arg.dependentIndex;
    }
    decl.isTemplateParam = true;
    scope.declare(param.name, decl);
  });
  scope.templateArgs = args;
  scope.template = tmpl;
  return scope;
};

/** Key of an instantiation in the template's cache. */
Sema.prototype.instantiationKey = function (args) {
  return argumentKey(args);
};

/**
 * Called by the parser when a class template instantiation's head is
 * parsed: creates the record named `X<args>`, caches it before its body is
 * parsed (so the class may refer to itself) and declares the
 * injected-class-name.
 */
Sema.prototype.startClassInstantiation = function (target, tag, range) {
  var tmpl = target.template;
  var injected;
  var record = this.createDecl('RecordDecl', range, {
    tag: tag,
    name: tmpl.name,
    complete: false,
    parent: tmpl.parent,
    bases: [],
    members: []
  });
  record.isDefined = false;
  record.scope = new Scope(ScopeKind.CLASS, this.scope, record);
  record.templateOf = tmpl;
  record.templateArgs = target.args;
  record.qualifiedName = (tmpl.qualifiedName || tmpl.name) + this.argumentsToString(target.args);
  tmpl.instantiations[target.key] = record;
  // Inside the class, `X` alone names this instantiation (14.6.1).
  injected = this.createDecl('TypedefDecl', range, { name: tmpl.name,
    type: this.types.record(record) });
  // Followed by `<`, the injected name names the template itself.
  injected.injectedTemplate = tmpl;
  record.scope.declare(tmpl.name, injected);
  return record;
};

// ---------------------------------------------------------------------------
// Lazy instantiation of member function bodies.

/**
 * Marks a function as used; a pending template body is queued for
 * instantiation at the end of the translation unit.
 */
Sema.prototype.requireDefinition = function (decl) {
  var root = decl && decl.pendingDefinition ? decl.pendingDefinition : decl;
  if (decl && !decl.pendingBody && !decl.pendingDefinition) {
    // An out-of-line definition seen later is instantiated then.
    decl.definitionRequired = true;
  }
  while (root && !root.pendingBody && root.previous) {
    root = root.previous;
  }
  if (root && root.pendingBody && !root.bodyQueued) {
    root.bodyQueued = true;
    this.pendingInstantiations = this.pendingInstantiations || [];
    this.pendingInstantiations.push(root);
  }
};

/** Placeholder type of a template parameter inside a parameter list. */
Sema.prototype.dependentType = function (name) {
  var decl = this.createDecl('RecordDecl', null, { tag: 'class', name: name, complete: true });
  decl.qualifiedName = name;
  decl.isDependent = true;
  decl.size = 0;
  return this.types.record(decl);
};

/** Registers a completed class instantiation for code generation. */
Sema.prototype.finishClassInstantiation = function (record) {
  if (record && this.translationUnit.instantiations.indexOf(record) === -1) {
    this.translationUnit.instantiations.push(record);
  }
};

module.exports = {
  argumentKey: argumentKey
};

// ---------------------------------------------------------------------------
// Function templates: deduction (C++11 14.8.2).

/** Whether a type mentions a template parameter placeholder. */
Sema.prototype.isDependentType = function (type) {
  var self = this;
  if (!type) {
    return false;
  }
  switch (type.kind) {
    case T.TypeKind.RECORD:
      return !!type.decl.isDependent;
    case T.TypeKind.POINTER:
      return this.isDependentType(type.pointee);
    case T.TypeKind.LVALUE_REF:
    case T.TypeKind.RVALUE_REF:
      return this.isDependentType(type.referee);
    case T.TypeKind.ARRAY:
      return typeof type.size === 'string' || this.isDependentType(type.element);
    case T.TypeKind.FUNCTION:
      return this.isDependentType(type.returnType) || type.params.some(function (p) {
        return self.isDependentType(p);
      });
  }
  return false;
};

/**
 * Placeholder arguments for analysing a function template's signature:
 * each type parameter is a distinct dependent class type, each value
 * parameter a constant without value.
 */
Sema.prototype.placeholderArguments = function (tmpl) {
  var self = this;
  return tmpl.params.map(function (p, index) {
    var type;
    if (p.kind === 'type') {
      type = self.dependentType(p.name || 'type-parameter-' + index);
      type.decl.templateParamIndex = index;
      type.decl.paramOf = tmpl;
      // A pack stands for one placeholder element in a pattern.
      return p.isPack ? { kind: 'pack', elements: [{ kind: 'type', type: type,
        packElement: true }], placeholder: true } : { kind: 'type', type: type };
    }
    return p.isPack ? { kind: 'pack', elements: [{ kind: 'value', value: null, type: p.type,
      dependentIndex: index, packElement: true }], placeholder: true } :
      { kind: 'value', value: null, type: p.type, dependentIndex: index };
  });
};

/**
 * Deduces template arguments from a call (14.8.2.1).
 *
 * @param {Object} tmpl Function TemplateDecl with `pattern` (the signature
 *   analysed with placeholders).
 * @param {Array.<Object>} explicitArgs Explicitly specified arguments.
 * @param {Array.<Object>} args Call arguments.
 * @returns {{args: ?Array.<Object>, reason: ?string}} Deduced arguments,
 *   or the reason deduction failed.
 */
Sema.prototype.deduceFromCall = function (tmpl, explicitArgs, args) {
  var pattern = tmpl.pattern;
  var deduced = [];
  var failure = null;
  var params;
  var i;
  if (!pattern) {
    return { args: null, reason: 'invalid declaration' };
  }
  params = pattern.type.params;
  for (i = 0; i < explicitArgs.length; i++) {
    // Explicitly specified parameters are not deduced (14.8.1/6).
    deduced[i] = { kind: explicitArgs[i].kind, type: explicitArgs[i].type,
      value: explicitArgs[i].value, explicit: true };
  }
  if (args.length < pattern.requiredArgs || (args.length > params.length &&
      !pattern.type.variadic && pattern.packAt === undefined)) {
    return { args: null, reason: 'requires ' + (args.length < pattern.requiredArgs ?
      (pattern.requiredArgs === params.length ? '' : 'at least ') + pattern.requiredArgs :
      (pattern.requiredArgs === params.length ? '' : 'at most ') + params.length) +
      ' argument' + ((args.length < pattern.requiredArgs ? pattern.requiredArgs :
        params.length) === 1 ? '' : 's') + ', but ' + args.length + ' ' +
      (args.length === 1 ? 'was' : 'were') + ' provided' };
  }
  for (i = 0; i < args.length && i < params.length && !failure; i++) {
    if (pattern.packAt !== undefined && i >= pattern.packAt) {
      break;
    }
    if (!this.isDependentType(params[i]) || !args[i].type) {
      continue;
    }
    failure = this._deduceArgument(params[i], args[i], deduced);
  }
  if (!failure && pattern.packAt !== undefined) {
    failure = this._deducePack(pattern, args, deduced);
  }
  if (failure) {
    return { args: null, reason: failure };
  }
  for (i = 0; i < tmpl.params.length; i++) {
    if (!deduced[i] && !tmpl.params[i].defaultTokens && !tmpl.params[i].isPack) {
      return { args: null, reason: 'couldn\'t infer template argument \'' +
        tmpl.params[i].name + '\'' };
    }
  }
  return { args: deduced, reason: null };
};

/**
 * Deduces a template parameter pack from the call arguments matching a
 * trailing function parameter pack (14.8.2.1/1).
 */
Sema.prototype._deducePack = function (pattern, args, deduced) {
  var elementPattern = pattern.type.params[pattern.packAt];
  var packIndex = pattern.packParam;
  var explicit = deduced[packIndex] && deduced[packIndex].kind === 'pack' ?
    deduced[packIndex].elements.slice() : [];
  var elements = [];
  var i;
  var one;
  var reason;
  for (i = pattern.packAt; i < args.length; i++) {
    one = deduced.slice();
    one[packIndex] = explicit[i - pattern.packAt] || undefined;
    reason = this._deduceArgument(elementPattern, args[i], one);
    if (reason) {
      return reason;
    }
    elements.push(one[packIndex] || { kind: 'type', type: args[i].type.unqualified });
    // Other parameters deduced through the pack must agree.
    one.forEach(function (d, k) {
      if (k !== packIndex && d && !deduced[k]) {
        deduced[k] = d;
      }
    });
  }
  deduced[packIndex] = { kind: 'pack', elements: elements };
  return null;
};

/** Deduces from one parameter/argument pair; returns a failure reason. */
Sema.prototype._deduceArgument = function (param, arg, deduced) {
  var argType = arg.type;
  var P = param;
  var A;
  if (T.isReference(P)) {
    if (P.kind === T.TypeKind.RVALUE_REF && this._isPlaceholder(P.referee) &&
        !P.referee.isConst && !P.referee.isVolatile && arg.valueCategory === 'lvalue') {
      // Forwarding reference: an lvalue deduces `A&` (14.8.2.1/3).
      return this._bind(P.referee, this.types.lvalueReference(argType), deduced);
    }
    P = P.referee;
    A = argType;
  } else {
    A = T.isArray(argType) ? this.types.pointer(argType.element) :
      T.isFunction(argType) ? this.types.pointer(argType) : argType.unqualified;
    P = P.unqualified;
  }
  return this._match(P, A, deduced, true);
};

/** Whether a type contains a deducible template parameter. */
Sema.prototype._containsPlaceholder = function (type) {
  var self = this;
  if (!type) {
    return false;
  }
  if (this._isPlaceholder(type)) {
    return true;
  }
  if (T.isPointer(type)) {
    return this._containsPlaceholder(type.pointee);
  }
  if (T.isReference(type)) {
    return this._containsPlaceholder(type.referee);
  }
  if (T.isArray(type)) {
    return typeof type.size === 'string' || this._containsPlaceholder(type.element);
  }
  if (T.isFunction(type)) {
    return this._containsPlaceholder(type.returnType) || type.params.some(function (p) {
      return self._containsPlaceholder(p);
    });
  }
  if (T.isRecord(type) && type.decl.templateArgs) {
    return type.decl.templateArgs.some(function (a) {
      return a.kind === 'type' ? self._containsPlaceholder(a.type) : a.dependentIndex !==
        undefined;
    });
  }
  return false;
};

Sema.prototype._isPlaceholder = function (type) {
  return T.isRecord(type) && type.decl.isDependent && type.decl.templateParamIndex !==
    undefined;
};

/** Binds a placeholder (with its cv) to a type; checks consistency. */
Sema.prototype._bind = function (placeholder, type, deduced) {
  var index = placeholder.decl.templateParamIndex;
  var value = T.isReference(type) ? type : this.types.qualified(type,
    type.isConst && !placeholder.isConst, type.isVolatile && !placeholder.isVolatile);
  var previous = deduced[index];
  if (previous && previous.explicit) {
    return null;
  }
  if (previous && previous.kind === 'type' && previous.type !== value) {
    return 'deduced conflicting types for parameter \'' + placeholder.decl.name + '\' (' +
      this.quote(previous.type) + ' vs. ' + this.quote(value) + ')';
  }
  deduced[index] = { kind: 'type', type: value };
  return null;
};

/**
 * Structural matching of a parameter pattern P against an argument type
 * A. Non-dependent parts are left to the conversion check.
 *
 * @returns {?string} Failure reason.
 */
Sema.prototype._match = function (P, A, deduced) {
  var i;
  var reason;
  var size;
  var index;
  if (this._isPlaceholder(P)) {
    // Extra cv in P is fine: a qualification conversion completes the
    // match (14.8.2.1/4); P's own cv is not part of the deduced type.
    return this._bind(P, A, deduced);
  }
  if (!this.isDependentType(P) || !this._containsPlaceholder(P)) {
    // Non-deduced contexts such as `typename T::type` (14.8.2.5/5).
    return null;
  }
  if (T.isPointer(P)) {
    if (!T.isPointer(A)) {
      return 'could not match ' + this.quote(P) + ' against ' + this.quote(A);
    }
    return this._match(P.pointee, A.pointee, deduced, false);
  }
  if (T.isArray(P)) {
    if (!T.isArray(A)) {
      return 'could not match ' + this.quote(P) + ' against ' + this.quote(A);
    }
    if (typeof P.size === 'string') {
      index = Number(P.size.slice(4));
      size = { kind: 'value', value: I.fromNumber(A.size), type: this.types.builtin('int') };
      if (deduced[index] && !I.eq(deduced[index].value, size.value)) {
        return 'deduced conflicting values for non-type template parameter';
      }
      deduced[index] = deduced[index] || size;
    }
    return this._match(P.element, A.element, deduced, false);
  }
  if (T.isFunction(P)) {
    if (!T.isFunction(A) || A.params.length !== P.params.length) {
      return 'could not match ' + this.quote(P) + ' against ' + this.quote(A);
    }
    reason = this._match(P.returnType, A.returnType, deduced, false);
    for (i = 0; i < P.params.length && !reason; i++) {
      reason = this._match(P.params[i], A.params[i], deduced, false);
    }
    return reason;
  }
  if (T.isRecord(P) && P.decl.templateOf) {
    return this._matchSpecialization(P, A, deduced);
  }
  return null;
};

/** `X<T, N>` against `X<int, 3>` (or a class derived from it, 14.8.2.1/4). */
Sema.prototype._matchSpecialization = function (P, A, deduced) {
  var record = T.isRecord(A) ? A.decl : null;
  var reason;
  var i;
  var pArg;
  var aArg;
  var self = this;
  while (record && record.templateOf !== P.decl.templateOf) {
    record = record.bases && record.bases.length ? record.bases[0].type.decl : null;
  }
  if (!record) {
    return 'could not match ' + this.quote(P) + ' against ' + this.quote(A);
  }
  for (i = 0; i < P.decl.templateArgs.length; i++) {
    pArg = P.decl.templateArgs[i];
    aArg = record.templateArgs[i];
    if (!aArg) {
      continue;
    }
    if (pArg.kind === 'type') {
      reason = self._match(pArg.type, aArg.type, deduced, false);
      if (!reason && !self.isDependentType(pArg.type) && pArg.type !== aArg.type) {
        reason = 'could not match ' + self.quote(P) + ' against ' + self.quote(A);
      }
    } else if (pArg.dependentIndex !== undefined) {
      if (deduced[pArg.dependentIndex] && !I.eq(deduced[pArg.dependentIndex].value,
          aArg.value)) {
        reason = 'deduced conflicting values for non-type template parameter';
      }
      deduced[pArg.dependentIndex] = deduced[pArg.dependentIndex] || aArg;
    }
    if (reason) {
      return reason;
    }
  }
  return null;
};

/**
 * Partial ordering (14.5.6.2), simplified: `a` is more specialized than
 * `b` if b's parameters can be deduced from a's pattern but not the
 * reverse.
 */
Sema.prototype.moreSpecializedTemplate = function (a, b) {
  return this._deducibleFrom(b, a) && !this._deducibleFrom(a, b);
};

Sema.prototype._deducibleFrom = function (target, source) {
  var deduced = [];
  var self = this;
  var tp = target.pattern;
  var sp = source.pattern;
  var i;
  if (!tp || !sp || tp.type.params.length !== sp.type.params.length) {
    return false;
  }
  for (i = 0; i < tp.type.params.length; i++) {
    if (self._match(T.removeReference(tp.type.params[i]).unqualified,
        T.removeReference(sp.type.params[i]).unqualified, deduced, true)) {
      return false;
    }
  }
  return true;
};

/** Whether an argument list mentions template parameter placeholders. */
Sema.prototype.isDependentArgumentList = function (args) {
  var self = this;
  return args.some(function (a) {
    return a.kind === 'type' ? self.isDependentType(a.type) : a.kind === 'pack' ?
      self.isDependentArgumentList(a.elements) : a.value === null;
  });
};

/** `X<T>` inside a signature pattern: a dependent, uninstantiated type. */
Sema.prototype.dependentSpecialization = function (tmpl, args) {
  var key = 'dep:' + argumentKey(args);
  var record = tmpl.instantiations[key];
  if (!record) {
    record = this.createDecl('RecordDecl', null, { tag: 'class', name: tmpl.name,
      complete: false });
    record.isDependent = true;
    record.templateOf = tmpl;
    record.templateArgs = args;
    record.qualifiedName = tmpl.name + this.argumentsToString(args.map(function (a) {
      return a.value === null && a.kind === 'value' ? { kind: 'type',
        type: { kind: 'builtin', name: a.nonDeduced ? a.spelling : 'N' } } : a;
    }));
    tmpl.instantiations[key] = record;
  }
  return this.types.record(record);
};

/**
 * Key identifying a function template signature independently of the
 * parameter names (for merging redeclarations).
 */
Sema.prototype.patternKey = function (type) {
  var swapped = [];
  var key;
  function collect(t) {
    if (!t) {
      return;
    }
    if (T.isRecord(t) && t.decl.templateParamIndex !== undefined) {
      if (swapped.indexOf(t.decl) === -1) {
        swapped.push(t.decl);
      }
    } else if (T.isPointer(t)) {
      collect(t.pointee);
    } else if (T.isReference(t)) {
      collect(t.referee);
    } else if (T.isArray(t)) {
      collect(t.element);
    } else if (T.isFunction(t)) {
      collect(t.returnType);
      t.params.forEach(collect);
    }
  }
  collect(type);
  swapped.forEach(function (d) {
    d.savedName = d.qualifiedName;
    d.qualifiedName = '$' + d.templateParamIndex;
  });
  key = T.typeToString(type);
  swapped.forEach(function (d) {
    d.qualifiedName = d.savedName;
  });
  return key;
};


// ---------------------------------------------------------------------------
// Specializations (C++11 14.7.3, 14.5.5).

/**
 * Exact matching of a pattern against a type for partial specializations
 * and explicit function specializations: placeholders bind, everything
 * else must be identical.
 *
 * @returns {boolean}
 */
Sema.prototype.matchExact = function (P, A, deduced) {
  var index;
  var bound;
  var i;
  var record;
  if (this._isPlaceholder(P)) {
    if ((P.isConst && !A.isConst) || (P.isVolatile && !A.isVolatile)) {
      return false;
    }
    bound = this.types.qualified(A, A.isConst && !P.isConst, A.isVolatile && !P.isVolatile);
    index = P.decl.templateParamIndex;
    if (deduced[index] && deduced[index].type !== bound) {
      return false;
    }
    deduced[index] = { kind: 'type', type: bound };
    return true;
  }
  if (!this.isDependentType(P)) {
    return P === A;
  }
  if (P.isConst !== A.isConst || P.isVolatile !== A.isVolatile) {
    return false;
  }
  if (T.isPointer(P)) {
    return T.isPointer(A) && this.matchExact(P.pointee, A.pointee, deduced);
  }
  if (T.isReference(P)) {
    return A.kind === P.kind && this.matchExact(P.referee, A.referee, deduced);
  }
  if (T.isArray(P)) {
    if (!T.isArray(A)) {
      return false;
    }
    if (typeof P.size === 'string') {
      index = Number(P.size.slice(4));
      if (deduced[index] && !I.eq(deduced[index].value, I.fromNumber(A.size))) {
        return false;
      }
      deduced[index] = { kind: 'value', value: I.fromNumber(A.size),
        type: this.types.builtin('int') };
    } else if (P.size !== A.size) {
      return false;
    }
    return this.matchExact(P.element, A.element, deduced);
  }
  if (T.isFunction(P)) {
    if (!T.isFunction(A) || A.params.length !== P.params.length ||
        A.variadic !== P.variadic || A.methodConst !== P.methodConst) {
      return false;
    }
    for (i = 0; i < P.params.length; i++) {
      if (!this.matchExact(P.params[i], A.params[i], deduced)) {
        return false;
      }
    }
    return this.matchExact(P.returnType, A.returnType, deduced);
  }
  if (T.isRecord(P) && P.decl.templateOf) {
    record = T.isRecord(A) ? A.decl : null;
    if (!record || record.templateOf !== P.decl.templateOf) {
      return false;
    }
    return this.matchArgumentLists(P.decl.templateArgs, record.templateArgs, deduced);
  }
  return false;
};

/** Matches a pattern argument list against concrete arguments. */
Sema.prototype.matchArgumentLists = function (patterns, args, deduced) {
  var i;
  var p;
  var a;
  var last = patterns[patterns.length - 1];
  var elements;
  var one;
  var k;
  if (args.length && args[args.length - 1].kind === 'pack') {
    args = args.slice(0, -1).concat(args[args.length - 1].elements);
  }
  if (last && last.packExpansion) {
    // `X<H, T...>`: the trailing pattern matches the remaining arguments.
    if (args.length < patterns.length - 1 ||
        !this.matchArgumentLists(patterns.slice(0, -1), args.slice(0, patterns.length - 1),
          deduced)) {
      return false;
    }
    elements = [];
    for (k = patterns.length - 1; k < args.length; k++) {
      one = [];
      if (!this.matchArgumentLists([Object.create(last, { packExpansion: { value: false } })],
          [args[k]], one)) {
        return false;
      }
      elements.push(one[last.packParam] || args[k]);
    }
    deduced[last.packParam] = { kind: 'pack', elements: elements };
    return true;
  }
  if (patterns.length !== args.length) {
    return false;
  }
  for (i = 0; i < patterns.length; i++) {
    p = patterns[i];
    a = args[i];
    if (p.kind !== a.kind) {
      return false;
    }
    if (p.kind === 'type') {
      if (!this.matchExact(p.type, a.type, deduced)) {
        return false;
      }
    } else if (p.kind === 'value') {
      if (p.value === null && p.nonDeduced) {
        // Checked when the deduced arguments are substituted.
        continue;
      } else if (p.value === null) {
        if (deduced[p.dependentIndex] && !I.eq(deduced[p.dependentIndex].value, a.value)) {
          return false;
        }
        deduced[p.dependentIndex] = a;
      } else if (!I.eq(p.value, a.value)) {
        return false;
      }
    }
  }
  return true;
};

/**
 * The partial specialization that applies to `args`, the most
 * specialized one if several match (14.5.5.1), with its deduced
 * arguments.
 *
 * @returns {?{spec: Object, args: Array.<Object>}}
 */
Sema.prototype.selectPartialSpecialization = function (tmpl, args, range) {
  var matches = [];
  var self = this;
  var best;
  var diag;
  tmpl.specializations.forEach(function (spec) {
    var deduced = [];
    if (self.matchArgumentLists(spec.patternArgs, args, deduced) &&
        spec.params.every(function (p, i) { return !!deduced[i] || p.isPack; })) {
      spec.params.forEach(function (p, i) {
        if (p.isPack && !deduced[i]) {
          deduced[i] = { kind: 'pack', elements: [] };
        }
      });
      matches.push({ spec: spec, args: deduced });
    }
  });
  if (matches.length <= 1) {
    return matches[0] || null;
  }
  best = matches.filter(function (m) {
    return matches.every(function (other) {
      return other === m || (self.matchArgumentLists(other.spec.patternArgs,
        m.spec.patternArgs, []) && !self.matchArgumentLists(m.spec.patternArgs,
        other.spec.patternArgs, []));
    });
  });
  if (best.length !== 1) {
    diag = this.error('ambiguous partial specializations of ' + this.quote(
      { kind: 'builtin', name: tmpl.name + this.argumentsToString(args) }), range);
    matches.forEach(function (m) {
      self.note(diag, 'partial specialization matches', m.spec.range);
    });
    return null;
  }
  return best[0];
};

// ---------------------------------------------------------------------------
// Variadic templates (C++11 14.5.3).

/** Elements of a parameter pack declaration, or null if not a pack. */
Sema.prototype.packElements = function (decl) {
  if (!decl) {
    return null;
  }
  if (decl.kind === 'TypedefDecl' && decl.pack) {
    return decl.pack;
  }
  if (decl.kind === 'ParamDecl' && decl.packElements) {
    return decl.packElements;
  }
  return null;
};

/** Current expansion index of a pack, or undefined outside an expansion. */
Sema.prototype.packIndex = function (decl) {
  return this.packIndices ? this.packIndices[decl.id] : undefined;
};

/**
 * Inside a pack expansion, a template parameter pack element: a type, or
 * a constant (as an enumerator-like declaration, cached per element).
 */
Sema.prototype.packElementDecl = function (decl) {
  var index = this.packIndex(decl);
  var element;
  if (index === undefined) {
    return null;
  }
  if (decl.kind === 'ParamDecl') {
    return decl.packElements[index];
  }
  element = decl.pack[index];
  decl.elementDecls = decl.elementDecls || [];
  if (!decl.elementDecls[index]) {
    decl.elementDecls[index] = element.kind === 'type' ?
      this.createDecl('TypedefDecl', decl.range, { name: decl.name, type: element.type }) :
      this.createDecl('EnumeratorDecl', decl.range, { name: decl.name, value: element.value,
        type: element.type });
    if (element.kind !== 'type') {
      decl.elementDecls[index].dependentIndex = element.dependentIndex;
    }
  }
  return decl.elementDecls[index];
};

/** `sizeof...(pack)` (14.5.3/7). */
Sema.prototype.actOnSizeofPack = function (name, range) {
  var decl = scopes.lookupUnqualified(this.scope, name).decls[0];
  var elements = this.packElements(decl);
  if (!elements) {
    this.error('\'' + name + '\' does not refer to the name of a parameter pack', range);
    return null;
  }
  return this._expr('IntegerLiteral', range, { value: I.fromNumber(elements.length) },
    this.types.builtin('unsigned int'), 'prvalue');
};
