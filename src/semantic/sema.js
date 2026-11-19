'use strict';

/**
 * Semantic analysis driven by the parser (D-035, D-042).
 *
 * The parser calls `Sema` to classify names and to turn what it parsed into
 * declarations, types and typed expressions. Sema owns the scopes, the type
 * context and the translation unit node.
 */

var ast = require('../ast/nodes');
var T = require('./types');
var scopes = require('./scope');
var I = require('../util/int64');

var Scope = scopes.Scope;
var ScopeKind = scopes.ScopeKind;
var TypeKind = T.TypeKind;

/**
 * Canonical fundamental type for each valid combination of simple type
 * specifiers (C++11 7.1.6.2, table 10). Keys are sorted specifier lists.
 */
var BUILTIN_COMBINATIONS = (function () {
  var table = {};
  var rows = [
    ['void', 'void'], ['bool', 'bool'], ['char', 'char'], ['signed char', 'signed char'],
    ['unsigned char', 'unsigned char'], ['char16_t', 'char16_t'], ['char32_t', 'char32_t'],
    ['wchar_t', 'wchar_t'], ['float', 'float'], ['double', 'double'],
    ['long double', 'long double'],
    ['short', 'short'], ['short int', 'short'], ['signed short', 'short'],
    ['signed short int', 'short'], ['unsigned short', 'unsigned short'],
    ['unsigned short int', 'unsigned short'],
    ['int', 'int'], ['signed', 'int'], ['signed int', 'int'], ['unsigned', 'unsigned int'],
    ['unsigned int', 'unsigned int'],
    ['long', 'long'], ['long int', 'long'], ['signed long', 'long'],
    ['signed long int', 'long'], ['unsigned long', 'unsigned long'],
    ['unsigned long int', 'unsigned long'],
    ['long long', 'long long'], ['long long int', 'long long'],
    ['signed long long', 'long long'], ['signed long long int', 'long long'],
    ['unsigned long long', 'unsigned long long'],
    ['unsigned long long int', 'unsigned long long']
  ];
  var i;
  for (i = 0; i < rows.length; i++) {
    table[rows[i][0].split(' ').sort().join(' ')] = rows[i][1];
  }
  return table;
}());

/**
 * @constructor
 * @param {DiagnosticBag} diagnostics
 * @param {SourceFile} source Main file of the translation unit.
 */
function Sema(diagnostics, source, options) {
  this.diagnostics = diagnostics;
  this.options = options || {};
  this.types = new T.TypeContext();
  this._nextDeclId = 0;
  this.globalNamespace = this.createDecl('NamespaceDecl', null, { name: '' });
  this.globalNamespace.scope = new Scope(ScopeKind.NAMESPACE, null, this.globalNamespace);
  this.scope = this.globalNamespace.scope;
  this.translationUnit = ast.createNode('TranslationUnit', null, { decls: [],
    source: source });
}

// ---------------------------------------------------------------------------
// Infrastructure.

/**
 * Creates a declaration node with a unique `id` (needed by record and enum
 * types, D-039).
 */
Sema.prototype.createDecl = function (kind, range, fields) {
  var decl = ast.createNode(kind, range, fields);
  decl.id = this._nextDeclId++;
  return decl;
};

Sema.prototype.error = function (message, range) {
  return this.diagnostics.error(message, range);
};

Sema.prototype.warning = function (message, range) {
  return this.diagnostics.warning(message, range);
};

Sema.prototype.note = function (diag, message, range) {
  if (diag && range) {
    diag.addNote(message, range);
  }
};

/**
 * Enters a new scope.
 *
 * @param {string} kind A ScopeKind.
 * @param {?Object} [entity]
 * @returns {Scope}
 */
Sema.prototype.pushScope = function (kind, entity) {
  this.scope = new Scope(kind, this.scope, entity || null);
  return this.scope;
};

Sema.prototype.popScope = function () {
  this.scope = this.scope.parent;
};

/** Declaration owning the innermost namespace, class or function scope. */
Sema.prototype.currentContext = function () {
  var scope = this.scope;
  while (scope && !scope.entity) {
    scope = scope.parent;
  }
  return scope ? scope.entity : null;
};

Sema.prototype._quoted = function (type) {
  return '\'' + T.typeToString(type) + '\'';
};

// ---------------------------------------------------------------------------
// Name classification for the parser (D-035).

/**
 * Tells the parser what an unqualified name denotes at the current point.
 *
 * @param {string} name
 * @returns {{kind: string, decls: Array.<Object>, type: (Object|undefined)}}
 *   `kind` is 'type', 'namespace', 'value' or 'unknown'.
 */
Sema.prototype.classifyName = function (name) {
  return this._classify(scopes.lookupUnqualified(this.scope, name));
};

/**
 * Like `classifyName`, for `qualifier::name`.
 */
Sema.prototype.classifyQualifiedName = function (qualifier, name) {
  return this._classify(scopes.lookupQualified(qualifier, name));
};

Sema.prototype._classify = function (result) {
  var decl = result.decls[0];
  if (!decl) {
    return { kind: 'unknown', decls: [] };
  }
  if (result.ambiguous) {
    return { kind: 'value', decls: result.decls, ambiguous: true };
  }
  if (decl.kind === 'TypedefDecl') {
    return { kind: 'type', decls: result.decls, type: decl.type };
  }
  if (decl.kind === 'RecordDecl') {
    return { kind: 'type', decls: result.decls, type: this.types.record(decl) };
  }
  if (decl.kind === 'EnumDecl') {
    return { kind: 'type', decls: result.decls, type: this.types.enumeration(decl) };
  }
  if (decl.kind === 'NamespaceDecl' || decl.kind === 'NamespaceAliasDecl') {
    return { kind: 'namespace', decls: result.decls };
  }
  return { kind: 'value', decls: result.decls };
};

// ---------------------------------------------------------------------------
// Types from specifiers and declarators.

/**
 * Builds the type named by the type specifiers of a decl-specifier-seq.
 *
 * @param {Object} spec Parsed specifiers: `builtins` (list of `{word,
 *   range}`), `namedType` (type or null), `isConst`, `isVolatile`,
 *   `isAuto`, `range`.
 * @returns {Object} The type (`int` after an error, for recovery).
 */
Sema.prototype.typeFromSpecifiers = function (spec) {
  var words;
  var key;
  var name;
  var type;
  if (spec.namedType) {
    type = spec.namedType;
  } else if (spec.isAuto) {
    type = null;
  } else if (!spec.builtins.length) {
    this.error('C++ requires a type specifier for all declarations', spec.range);
    type = this.types.builtin('int');
  } else {
    words = spec.builtins.map(function (b) { return b.word; });
    key = words.slice().sort().join(' ');
    name = BUILTIN_COMBINATIONS[key];
    if (!name) {
      this.error(words.filter(function (w) { return w === 'long'; }).length > 2 ?
        '\'long long long\' is too long' :
        'cannot combine type specifiers \'' + words.join(' ') + '\'', spec.builtins[0].range);
      name = 'int';
    }
    type = this.types.builtin(name);
  }
  if (type && (spec.isConst || spec.isVolatile)) {
    type = this.types.addQualifiers(type, spec.isConst, spec.isVolatile);
  }
  return type;
};

/**
 * Applies a declarator to a base type (C++11 8.3): pointer operators bind
 * left to right, array and function suffixes right to left, and a
 * parenthesized declarator applies last.
 *
 * @param {Object} base
 * @param {Object} declarator `{ptrOps, name, nested, suffixes, range}`.
 * @returns {Object} The declared type.
 */
Sema.prototype.typeFromDeclarator = function (base, declarator) {
  var type = base;
  var i;
  var op;
  var suffix;
  var label = declarator.name ? '\'' + declarator.name + '\'' : 'type name';
  for (i = 0; i < declarator.ptrOps.length; i++) {
    op = declarator.ptrOps[i];
    if (T.isReference(type) && op.kind === 'pointer') {
      this.error(label + ' declared as a pointer to a reference of type ' +
        this._quoted(type), op.range);
      type = type.referee;
    }
    if (op.kind === 'pointer') {
      type = this.types.qualified(this.types.pointer(type), op.isConst, op.isVolatile);
    } else {
      if (T.isReference(type)) {
        this.error(label + ' declared as a reference to a reference', op.range);
        type = type.referee;
      }
      if (T.isVoid(type)) {
        this.error('cannot form a reference to \'void\'', op.range);
        type = this.types.builtin('int');
      }
      type = op.kind === 'lvalue-ref' ? this.types.lvalueReference(type) :
        this.types.rvalueReference(type);
    }
  }
  for (i = declarator.suffixes.length - 1; i >= 0; i--) {
    suffix = declarator.suffixes[i];
    if (suffix.kind === 'array') {
      type = this._arrayType(type, suffix, label);
    } else {
      type = this._functionType(type, suffix, label);
    }
  }
  if (declarator.nested) {
    return this.typeFromDeclarator(type, declarator.nested);
  }
  return type;
};

Sema.prototype._arrayType = function (element, suffix, label) {
  var size = null;
  if (T.isReference(element)) {
    this.error(label + ' declared as array of references of type ' + this._quoted(element),
      suffix.range);
    element = element.referee;
  }
  if (T.isFunction(element)) {
    this.error(label + ' declared as array of functions of type ' + this._quoted(element),
      suffix.range);
    element = this.types.pointer(element);
  }
  if (T.isVoid(element)) {
    this.error('array has incomplete element type \'void\'', suffix.range);
    element = this.types.builtin('int');
  }
  if (suffix.size) {
    size = this.evaluateArraySize(suffix.size);
  }
  return this.types.array(element, size);
};

Sema.prototype._functionType = function (returnType, suffix, label) {
  var params = [];
  var i;
  if (suffix.trailingReturn) {
    if (returnType !== null) {
      this.error('function with trailing return type must specify return type \'auto\', ' +
        'not ' + this._quoted(returnType), suffix.range);
    }
    returnType = suffix.trailingReturn;
  } else if (returnType === null) {
    this.error(label + ' declared with \'auto\' type but no trailing return type',
      suffix.range);
    returnType = this.types.builtin('int');
  }
  if (T.isArray(returnType)) {
    this.error('function cannot return array type ' + this._quoted(returnType), suffix.range);
    returnType = this.types.pointer(returnType.element);
  } else if (T.isFunction(returnType)) {
    this.error('function cannot return function type ' + this._quoted(returnType),
      suffix.range);
    returnType = this.types.pointer(returnType);
  }
  for (i = 0; i < suffix.params.length; i++) {
    params.push(this.types.adjustParameter(suffix.params[i].type));
  }
  return this.types.func(returnType, params, {
    variadic: suffix.variadic,
    methodConst: suffix.isConst,
    methodVolatile: suffix.isVolatile,
    refQualifier: suffix.refQualifier
  });
};

/**
 * Evaluates an array bound: an integral constant expression greater than
 * zero.
 *
 * @returns {?number}
 */
Sema.prototype.evaluateArraySize = function (expr) {
  var value;
  // After an error the size is 1, so that no cascade of errors follows.
  if (!expr) {
    return 1;
  }
  if (!(T.isIntegral(expr.type) || (T.isEnum(expr.type) && !T.isScopedEnum(expr.type)))) {
    this.error('size of array has non-integer type ' + this._quoted(expr.type), expr.range);
    return 1;
  }
  value = this.evaluateConstant(expr);
  if (value === null) {
    this.error('array size is not an integral constant expression', expr.range);
    return 1;
  }
  if (value < 0) {
    this.error('array size is negative', expr.range);
    return 1;
  }
  if (value === 0) {
    this.error('zero size arrays are not allowed', expr.range);
    return 1;
  }
  return value;
};

// ---------------------------------------------------------------------------
// Declarations.

/**
 * Handles a declarator of a simple declaration: creates (or merges into a
 * previous declaration) a variable, function or typedef.
 *
 * @param {Object} spec Parsed decl-specifiers (see typeFromSpecifiers),
 *   plus `storage`, `isTypedef`, `isInline`, `isConstexpr`, ...
 * @param {Object} declarator Parsed declarator.
 * @returns {?Object} The declaration.
 */
Sema.prototype.actOnDeclarator = function (spec, declarator) {
  var base = this.typeFromSpecifiers(spec);
  var type = this.typeFromDeclarator(base, declarator);
  if (!declarator.name) {
    this.error('declaration does not declare anything', declarator.range || spec.range);
    return null;
  }
  if (spec.isTypedef) {
    return this.declareTypedef(declarator.name, type, declarator.range, false);
  }
  if (T.isFunction(type)) {
    return this.declareFunction(spec, declarator, type);
  }
  return this.declareVariable(spec, declarator, type);
};

/**
 * Declares a typedef name or an alias declaration (`using X = T;`).
 * Redeclaring a typedef with the same type is allowed (C++11 7.1.3/3).
 */
Sema.prototype.declareTypedef = function (name, type, range, isAlias) {
  var previous = this.scope.lookupLocal(name);
  var decl = this.createDecl('TypedefDecl', range, { name: name, type: type,
    isAlias: isAlias });
  var diag;
  if (previous.length) {
    if (previous[0].kind === 'TypedefDecl' && previous[0].type === type) {
      return previous[0];
    }
    diag = previous[0].kind === 'TypedefDecl' ?
      this.error('typedef redefinition with different types (' + this._quoted(type) +
        ' vs ' + this._quoted(previous[0].type) + ')', range) :
      this.error('redefinition of \'' + name + '\' as different kind of symbol', range);
    this.note(diag, 'previous definition is here', previous[0].range);
    return decl;
  }
  this.scope.declare(name, decl);
  return decl;
};

/**
 * Declares a variable (or merges an `extern` redeclaration).
 */
Sema.prototype.declareVariable = function (spec, declarator, type) {
  var name = declarator.name;
  var range = declarator.range;
  var previous = this.scope.lookupLocal(name);
  var decl;
  var diag;
  var i;
  if (T.isVoid(type)) {
    this.error('variable has incomplete type \'void\'', range);
    type = this.types.builtin('int');
  } else if ((T.isRecord(type) || T.isEnum(type)) && !T.isComplete(type) &&
      spec.storage !== 'extern') {
    this.error('variable has incomplete type ' + this._quoted(type), range);
    type = this.types.builtin('int');
  }
  decl = this.createDecl('VarDecl', range, {
    name: name,
    type: type,
    storage: spec.storage || '',
    isConstexpr: !!spec.isConstexpr,
    isThreadLocal: !!spec.isThreadLocal,
    parent: this.currentContext(),
    linkage: spec.linkage || null
  });
  for (i = 0; i < previous.length; i++) {
    if (previous[i].kind === 'ParamDecl') {
      diag = this.error('redefinition of \'' + name + '\'', range);
      this.note(diag, 'previous definition is here', previous[i].range);
      return decl;
    }
    if (previous[i].kind === 'VarDecl') {
      if (previous[i].type !== type) {
        diag = this.error('redefinition of \'' + name + '\' with a different type: ' +
          this._quoted(type) + ' vs ' + this._quoted(previous[i].type), range);
        this.note(diag, 'previous definition is here', previous[i].range);
        return decl;
      }
      // Only `extern` declarations may be repeated at namespace scope; local
      // variables can never be redeclared.
      if (this.scope.kind !== ScopeKind.NAMESPACE ||
          (decl.storage !== 'extern' && previous[i].storage !== 'extern')) {
        diag = this.error('redefinition of \'' + name + '\'', range);
        this.note(diag, 'previous definition is here', previous[i].range);
        return decl;
      }
      decl.previous = previous[i];
    } else if (!scopes.isTag(previous[i])) {
      diag = this.error('redefinition of \'' + name + '\' as different kind of symbol', range);
      this.note(diag, 'previous definition is here', previous[i].range);
      return decl;
    }
  }
  this.scope.declare(name, decl);
  return decl;
};

/**
 * Two function types have the same parameter-type-list (C++11 8.3.5/5)
 * when their parameters, variadic flag and method qualifiers match.
 */
function sameSignature(a, b) {
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

/**
 * Declares a function, resolving redeclarations and overloads.
 */
Sema.prototype.declareFunction = function (spec, declarator, type) {
  var name = declarator.name;
  var range = declarator.range;
  var suffix = innermostFunction(declarator);
  var previous = this.scope.lookupLocal(name);
  var decl;
  var diag;
  var i;
  decl = this.createDecl('FunctionDecl', range, {
    name: name,
    type: type,
    storage: spec.storage || '',
    isInline: !!spec.isInline,
    isConstexpr: !!spec.isConstexpr,
    parent: this.currentContext(),
    linkage: spec.linkage || null,
    params: [],
    isMethod: false
  });
  decl.params = this._createParams(suffix ? suffix.params : []);
  if (this.scope.kind !== ScopeKind.NAMESPACE && this.scope.kind !== ScopeKind.CLASS) {
    // Block-scope function declarations are allowed but rare.
    decl.storage = decl.storage || 'extern';
  }
  if (suffix && (suffix.isConst || suffix.isVolatile || suffix.refQualifier) &&
      this.scope.kind !== ScopeKind.CLASS) {
    this.error('non-member function cannot have \'' +
      (suffix.isConst ? 'const' : suffix.isVolatile ? 'volatile' : suffix.refQualifier) +
      '\' qualifier', suffix.range);
  }
  if (name === 'main' && this.scope === this.globalNamespace.scope) {
    this._checkMain(decl, spec);
  }
  // The most recent matching declaration becomes `previous`.
  for (i = previous.length - 1; i >= 0; i--) {
    if (previous[i].kind !== 'FunctionDecl') {
      if (!scopes.isTag(previous[i])) {
        diag = this.error('redefinition of \'' + name + '\' as different kind of symbol',
          range);
        this.note(diag, 'previous definition is here', previous[i].range);
        return decl;
      }
      continue;
    }
    if (!sameSignature(previous[i].type, type)) {
      if (decl.linkage === 'C' && previous[i].linkage === 'C') {
        // C functions cannot be overloaded (D-014).
        diag = this.error('conflicting types for \'' + name + '\'', range);
        this.note(diag, 'previous declaration is here', previous[i].range);
        return decl;
      }
      continue;
    }
    if (previous[i].type.returnType !== type.returnType) {
      diag = this.error('functions that differ only in their return type cannot be ' +
        'overloaded', range);
      this.note(diag, 'previous declaration is here', previous[i].range);
      return decl;
    }
    if (previous[i].linkage !== decl.linkage && decl.linkage !== null) {
      diag = this.error('declaration of \'' + name + '\' has a different language linkage',
        range);
      this.note(diag, 'previous declaration is here', previous[i].range);
    }
    decl.previous = previous[i];
    decl.linkage = previous[i].linkage;
    this._mergeDefaultArguments(decl, previous[i]);
    break;
  }
  this.scope.declare(name, decl);
  return decl;
};

/** The function suffix that gives a function declarator its parameters. */
function innermostFunction(declarator) {
  var nested = declarator;
  var found = null;
  while (nested) {
    if (nested.suffixes.length && nested.suffixes[0].kind === 'function') {
      found = nested.suffixes[0];
    }
    if (nested.ptrOps.length) {
      // `int (*f)(int)` declares a pointer, not a function.
      break;
    }
    nested = nested.nested;
  }
  return found;
}

Sema.prototype._createParams = function (params) {
  var out = [];
  var seen = Object.create(null);
  var diag;
  var i;
  for (i = 0; i < params.length; i++) {
    if (params[i].name && seen[params[i].name]) {
      diag = this.error('redefinition of parameter \'' + params[i].name + '\'',
        params[i].range);
      this.note(diag, 'previous declaration is here', seen[params[i].name]);
    } else if (params[i].name) {
      seen[params[i].name] = params[i].range;
    }
    // The parameter variable keeps its cv-qualifiers; only the function
    // type drops them (C++11 8.3.5/5).
    out.push(this.createDecl('ParamDecl', params[i].range, {
      name: params[i].name,
      type: T.isArray(params[i].type) || T.isFunction(params[i].type) ?
        this.types.adjustParameter(params[i].type) : params[i].type,
      defaultArg: params[i].defaultArg ? this.convertDefaultArgument(params[i].defaultArg,
        this.types.adjustParameter(params[i].type)) : null,
      index: i
    }));
  }
  return out;
};

/**
 * Default arguments accumulate over redeclarations but cannot be given
 * twice for the same parameter (C++11 8.3.6/4).
 */
Sema.prototype._mergeDefaultArguments = function (decl, previous) {
  var i;
  var diag;
  for (i = 0; i < decl.params.length; i++) {
    if (decl.params[i].defaultArg && previous.params[i].defaultArg) {
      diag = this.error('redefinition of default argument', decl.params[i].range);
      this.note(diag, 'previous definition is here', previous.params[i].range);
    } else if (!decl.params[i].defaultArg) {
      decl.params[i].defaultArg = previous.params[i].defaultArg;
    }
  }
};

Sema.prototype._checkMain = function (decl, spec) {
  if (decl.type.returnType !== this.types.builtin('int')) {
    this.error('\'main\' must return \'int\'', decl.range);
  }
  if (spec.isInline) {
    this.error('\'main\' is not allowed to be declared inline', decl.range);
  }
  if (spec.storage === 'static') {
    this.error('\'main\' is not allowed to be declared static', decl.range);
  }
};

/**
 * Starts a function definition: checks for redefinition and opens the
 * parameter scope. The caller parses the body, then calls
 * `actOnFinishFunctionBody`.
 */
Sema.prototype.actOnStartFunctionBody = function (decl) {
  var prev = decl.previous;
  var diag;
  var i;
  var params;
  while (prev) {
    if (prev.body) {
      diag = this.error('redefinition of \'' + decl.name + '\'', decl.range);
      this.note(diag, 'previous definition is here', prev.range);
      break;
    }
    prev = prev.previous;
  }
  this.pushScope(ScopeKind.FUNCTION, decl);
  params = decl.params;
  for (i = 0; i < params.length; i++) {
    if (!params[i].name) {
      continue;
    }
    // Duplicates were reported when the parameters were created.
    if (!this.scope.lookupLocal(params[i].name).length) {
      this.scope.declare(params[i].name, params[i]);
    }
  }
};

Sema.prototype.actOnFinishFunctionBody = function (decl, body) {
  decl.body = body;
  this.popScope();
};

// ---------------------------------------------------------------------------
// Namespaces, using, linkage (Phase 5 step 2).

/** The namespace a NamespaceDecl or NamespaceAliasDecl denotes. */
Sema.prototype.resolveNamespace = function (decl) {
  return decl.kind === 'NamespaceAliasDecl' ? decl.target : decl;
};

/**
 * Opens `namespace name {` (or an anonymous or inline namespace). A
 * namespace may be reopened: every occurrence gets its own AST node, all
 * sharing the scope of the first one (`previous`).
 *
 * @returns {Object} The NamespaceDecl node of this occurrence.
 */
Sema.prototype.actOnStartNamespace = function (name, isInline, range, jsModule) {
  var parent = this.scope;
  var previous = name ? parent.lookupLocal(name) : [];
  var original = null;
  var decl;
  var diag;
  if (parent.kind !== ScopeKind.NAMESPACE) {
    this.error('namespaces can only be defined in global or namespace scope', range);
  }
  if (previous.length) {
    if (previous[0].kind === 'NamespaceDecl') {
      original = previous[0];
    } else {
      diag = this.error('redefinition of \'' + name + '\' as different kind of symbol', range);
      this.note(diag, 'previous definition is here', previous[0].range);
    }
  }
  decl = this.createDecl('NamespaceDecl', range, {
    name: name || '',
    isInline: isInline || (original ? original.isInline : false),
    parent: parent.entity,
    decls: []
  });
  decl.jsModule = jsModule || (original ? original.jsModule : null);
  if (original) {
    decl.previous = original;
    decl.scope = original.scope;
    if (isInline && !original.isInline) {
      this.error('non-inline namespace cannot be reopened as inline', range);
    }
  } else {
    decl.scope = new Scope(ScopeKind.NAMESPACE, parent, decl);
    if (name) {
      parent.declare(name, decl);
    } else {
      // An unnamed namespace behaves as if followed by a using-directive
      // (C++11 7.3.1.1).
      parent.declare('', decl);
      parent.addUsingDirective(decl);
    }
  }
  this.scope = decl.scope;
  return decl;
};

Sema.prototype.actOnFinishNamespace = function (decl, decls) {
  decl.decls = decls;
  this.scope = this.scope.parent;
};

/** `namespace alias = qualified-namespace;` */
Sema.prototype.actOnNamespaceAlias = function (name, target, range) {
  var previous = this.scope.lookupLocal(name);
  var decl = this.createDecl('NamespaceAliasDecl', range, { name: name, target: target });
  var diag;
  if (previous.length && !(previous[0].kind === 'NamespaceAliasDecl' &&
      previous[0].target === target)) {
    diag = this.error('redefinition of \'' + name + '\'', range);
    this.note(diag, 'previous definition is here', previous[0].range);
    return decl;
  }
  if (!previous.length) {
    this.scope.declare(name, decl);
  }
  return decl;
};

/** `using namespace N;` */
Sema.prototype.actOnUsingDirective = function (namespaceDecl, range) {
  if (this.scope.kind === ScopeKind.CLASS) {
    this.error('\'using namespace\' is not allowed in classes', range);
  } else {
    this.scope.addUsingDirective(namespaceDecl);
  }
  return this.createDecl('UsingDirectiveDecl', range, { namespace: namespaceDecl });
};

/** `using N::name;` (C++11 7.3.3). */
Sema.prototype.actOnUsingDeclaration = function (qualifier, name, range) {
  var result = scopes.lookupQualified(qualifier, name);
  var decl;
  if (!result.decls.length) {
    this.error('no member named \'' + name + '\' in ' + this.describeQualifier(qualifier),
      range);
    return null;
  }
  if (result.decls[0].kind === 'NamespaceDecl') {
    this.error('using declaration cannot refer to a namespace', range);
    return null;
  }
  decl = this.createDecl('UsingDecl', range, { name: name, targets: result.decls });
  this.scope.declare(name, decl);
  return decl;
};

/** `namespace 'std'`, `class 'A'`, `the global namespace`, for messages. */
Sema.prototype.describeQualifier = function (qualifier) {
  if (qualifier.kind === 'NamespaceDecl') {
    return qualifier.name ? 'namespace \'' + this.qualifiedName(qualifier) + '\'' :
      'the global namespace';
  }
  if (qualifier.kind === 'EnumDecl') {
    return 'enum \'' + this.qualifiedName(qualifier) + '\'';
  }
  return (qualifier.tag || 'class') + ' \'' + this.qualifiedName(qualifier) + '\'';
};

/** Fully qualified name of a declaration, without the leading `::`. */
Sema.prototype.qualifiedName = function (decl) {
  var parts = [];
  var current = decl;
  while (current && current !== this.globalNamespace) {
    parts.unshift(current.name || '(anonymous namespace)');
    current = current.parent;
  }
  return parts.join('::');
};

/** Whether namespace `outer` encloses (or is) namespace `inner`. */
Sema.prototype.encloses = function (outer, inner) {
  var current = inner;
  while (current) {
    if (current === outer) {
      return true;
    }
    current = current.parent;
  }
  return false;
};

/**
 * Starts a declaration whose declarator-id is qualified (`int ns::x = 1;`,
 * `void ns::f() {}`): it must redeclare a member of `qualifier`, and the
 * current namespace must enclose it (C++11 7.3.1.2/2). Until
 * `actOnFinishQualifiedDeclaration`, lookup happens in the scope of the
 * qualifier, as names in such definitions are looked up there first.
 *
 * @returns {?Scope} The scope to restore afterwards, or null after an error.
 */
Sema.prototype.actOnStartQualifiedDeclaration = function (qualifier, name, range) {
  var saved = this.scope;
  var current = this.scope.entity;
  if (qualifier.kind !== 'NamespaceDecl') {
    // Out-of-line class members come with classes (step 5).
    this.error('qualified declarations of class members are not supported yet', range);
    return null;
  }
  if (this.scope.kind !== ScopeKind.NAMESPACE || !this.encloses(current, qualifier)) {
    this.error('cannot define or redeclare \'' + name + '\' here because namespace \'' +
      this.qualifiedName(current) + '\' does not enclose namespace \'' +
      this.qualifiedName(qualifier) + '\'', range);
    return null;
  }
  if (!qualifier.scope.lookupLocal(name).length) {
    this.error('out-of-line definition of \'' + name + '\' does not match any declaration in ' +
      this.describeQualifier(qualifier), range);
    return null;
  }
  this.scope = qualifier.scope;
  return saved;
};

Sema.prototype.actOnFinishQualifiedDeclaration = function (saved) {
  this.scope = saved;
};

/**
 * Checks a declaration made under a linkage specification.
 *
 * @param {Object} decl
 * @param {string} linkage 'C', 'C++' or 'JS'.
 * @param {boolean} isDefinition Function with a body, or variable defined.
 */
Sema.prototype.checkLinkage = function (decl, linkage, isDefinition) {
  if (linkage !== 'JS' || !decl) {
    return;
  }
  if (isDefinition && decl.kind === 'FunctionDecl') {
    this.error('function \'' + decl.name + '\' with \'JS\' linkage cannot be defined: it is ' +
      'provided by JavaScript', decl.range);
  } else if (isDefinition && decl.kind === 'VarDecl') {
    this.error('variable \'' + decl.name + '\' with \'JS\' linkage cannot be initialized: it ' +
      'is provided by JavaScript', decl.range);
  }
};

/** Records a top-level declaration in the translation unit. */
Sema.prototype.addTopLevel = function (decl) {
  if (decl) {
    this.translationUnit.decls.push(decl);
  }
};

// ---------------------------------------------------------------------------
// Expressions (step 1: literals and names; extended in step 3).

Sema.prototype._expr = function (kind, range, fields, type, valueCategory) {
  var node = ast.createNode(kind, range, fields);
  node.type = type;
  node.valueCategory = valueCategory;
  return node;
};

/**
 * Integer literal typing (C++11 2.14.2, table 6) with the ILP32 sizes of
 * D-036: the first type of the list that can represent the value.
 */
Sema.prototype.actOnIntegerLiteral = function (token, range) {
  var lit = token.value;
  var decimal = lit.radix === 10;
  var candidates;
  var i;
  var type = null;
  if (lit.longs === 2) {
    candidates = lit.unsigned ? ['unsigned long long'] :
      decimal ? ['long long'] : ['long long', 'unsigned long long'];
  } else if (lit.longs === 1) {
    candidates = lit.unsigned ? ['unsigned long', 'unsigned long long'] :
      decimal ? ['long', 'long long'] :
        ['long', 'unsigned long', 'long long', 'unsigned long long'];
  } else {
    candidates = lit.unsigned ? ['unsigned int', 'unsigned long', 'unsigned long long'] :
      decimal ? ['int', 'long', 'long long'] :
        ['int', 'unsigned int', 'long', 'unsigned long', 'long long', 'unsigned long long'];
  }
  for (i = 0; i < candidates.length; i++) {
    if (fitsIn(lit.value, candidates[i])) {
      type = this.types.builtin(candidates[i]);
      break;
    }
  }
  if (!type) {
    this.warning('integer literal is too large to be represented in a signed integer type, ' +
      'interpreting as unsigned', range);
    type = this.types.builtin('unsigned long long');
  }
  if (lit.udSuffix) {
    this.error('user-defined literals are not supported yet', range);
  }
  return this._expr('IntegerLiteral', range, { value: lit.value }, type, 'prvalue');
};

function fitsIn(value, typeName) {
  var size = typeName.indexOf('long long') !== -1 ? 8 : 4;
  var unsigned = typeName.indexOf('unsigned') === 0;
  if (size === 8) {
    return unsigned || !I.isNegative(value);
  }
  if (value.hi !== 0) {
    return false;
  }
  return unsigned || value.lo <= 0x7fffffff;
}

Sema.prototype.actOnFloatLiteral = function (token, range) {
  var lit = token.value;
  var type = this.types.builtin(lit.suffix === 'f' ? 'float' :
    lit.suffix === 'l' ? 'long double' : 'double');
  if (lit.udSuffix) {
    this.error('user-defined literals are not supported yet', range);
  }
  return this._expr('FloatLiteral', range, { value: lit.value }, type, 'prvalue');
};

Sema.prototype.actOnCharLiteral = function (token, range) {
  var lit = token.value;
  var names = { '': lit.multi ? 'int' : 'char', 'u': 'char16_t', 'U': 'char32_t',
    'L': 'wchar_t' };
  return this._expr('CharLiteral', range, { value: lit.value },
    this.types.builtin(names[lit.encoding]), 'prvalue');
};

/**
 * A string literal is an lvalue of type "array of N const char" (or
 * char16_t / char32_t / wchar_t), including the terminating NUL.
 */
Sema.prototype.actOnStringLiteral = function (token, range) {
  var lit = token.value;
  var names = { '': 'char', 'u8': 'char', 'u': 'char16_t', 'U': 'char32_t', 'L': 'wchar_t' };
  var element = this.types.qualified(this.types.builtin(names[lit.encoding]), true, false);
  if (lit.udSuffix) {
    this.error('user-defined literals are not supported yet', range);
  }
  return this._expr('StringLiteral', range, { units: lit.units, encoding: lit.encoding },
    this.types.array(element, lit.units.length + 1), 'lvalue');
};

Sema.prototype.actOnBoolLiteral = function (value, range) {
  return this._expr('BoolLiteral', range, { value: value }, this.types.builtin('bool'),
    'prvalue');
};

Sema.prototype.actOnNullptr = function (range) {
  return this._expr('NullptrLiteral', range, {}, this.types.builtin('std::nullptr_t'),
    'prvalue');
};

Sema.prototype.actOnParenExpr = function (inner, range) {
  if (!inner) {
    return null;
  }
  return this._expr('ParenExpr', range, { expr: inner }, inner.type, inner.valueCategory);
};

/** The function whose body is being parsed, or null. */
Sema.prototype.currentFunction = function () {
  var scope = this.scope;
  while (scope && scope.kind !== ScopeKind.FUNCTION) {
    scope = scope.parent;
  }
  return scope ? scope.entity : null;
};

Sema.prototype.actOnInitList = function (inits, range) {
  return this._expr('InitListExpr', range, { inits: inits }, null, 'prvalue');
};

module.exports = {
  Sema: Sema,
  BUILTIN_COMBINATIONS: BUILTIN_COMBINATIONS
};

require('./sema-expr');
require('./overload');
require('./sema-stmt');
require('./sema-tag');
require('./sema-class');
