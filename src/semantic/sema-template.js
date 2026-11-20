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
Sema.prototype.actOnTemplateDecl = function (info) {
  var previous = info.templateKind === 'function' ? [] :
    this.scope.lookupLocal(info.name).filter(function (d) {
      return d.kind === 'TemplateDecl';
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
    }
    return decl;
  }
  other = this.scope.lookupLocal(info.name).filter(function (d) {
    return d.kind !== 'TemplateDecl' && d.kind !== 'FunctionDecl';
  });
  if (other.length) {
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
  decl.scope = this.scope;
  decl.instantiations = Object.create(null);
  decl.specializations = [];
  decl.qualifiedName = this.qualifiedName(decl);
  this.scope.declare(info.name, decl);
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
function argumentKey(args) {
  return args.map(function (a) {
    if (a.kind === 'type') {
      return 't' + a.type.id;
    }
    if (a.kind === 'pack') {
      return 'p(' + argumentKey(a.elements) + ')';
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
      scope.declare(param.name, decl);
      return;
    }
    if (arg.kind === 'type') {
      decl = self.createDecl('TypedefDecl', param.range, { name: param.name, type: arg.type });
    } else {
      decl = self.createDecl('EnumeratorDecl', param.range, { name: param.name,
        value: arg.value, type: arg.type });
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
  var root = decl;
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
