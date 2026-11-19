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
function Sema(diagnostics, source) {
  this.diagnostics = diagnostics;
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
  var value = this.evaluateConstant(expr);
  if (value === null) {
    this.error('array size is not an integral constant expression', expr.range);
    return null;
  }
  if (value < 0) {
    this.error('array size is negative', expr.range);
    return null;
  }
  if (value === 0) {
    this.error('zero size arrays are not allowed', expr.range);
    return null;
  }
  return value;
};

/**
 * Evaluates an integral constant expression. Currently: literals,
 * parentheses, unary `+`/`-`/`~`/`!` and enumerators; extended with the
 * expression parser (Phase 5, step 3).
 *
 * @returns {?number} The value, or null if not constant.
 */
Sema.prototype.evaluateConstant = function (expr) {
  var operand;
  if (!expr) {
    return null;
  }
  switch (expr.kind) {
    case 'IntegerLiteral':
      return I.toNumber(expr.value, !T.isUnsigned(expr.type));
    case 'CharLiteral':
      return expr.value;
    case 'BoolLiteral':
      return expr.value ? 1 : 0;
    case 'ParenExpr':
      return this.evaluateConstant(expr.expr);
    case 'DeclRefExpr':
      return expr.decl && expr.decl.kind === 'EnumeratorDecl' ? expr.decl.value : null;
    case 'UnaryExpr':
      operand = this.evaluateConstant(expr.operand);
      if (operand === null) {
        return null;
      }
      switch (expr.operator) {
        case '+': return operand;
        case '-': return -operand;
        case '~': return ~operand;
        case '!': return operand ? 0 : 1;
      }
      return null;
  }
  return null;
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
 * Attaches an initializer to a variable and checks the rules that do not
 * need expression typing (step 3 adds conversions).
 */
Sema.prototype.actOnVariableInit = function (decl, init, style) {
  if (!decl || decl.kind !== 'VarDecl') {
    return;
  }
  decl.init = init;
  decl.initStyle = init ? style : null;
  if (!init && decl.storage !== 'extern') {
    if (T.isReference(decl.type)) {
      this.error('declaration of reference variable \'' + decl.name +
        '\' requires an initializer', decl.range);
    } else if (decl.type.isConst && !T.isRecord(decl.type)) {
      this.error('default initialization of an object of const type ' +
        this._quoted(decl.type), decl.range);
    } else if (decl.isConstexpr) {
      this.error('constexpr variable \'' + decl.name + '\' must be initialized by a constant ' +
        'expression', decl.range);
    }
  }
  if (init && decl.storage === 'extern' && this.scope.kind !== ScopeKind.NAMESPACE) {
    this.error('\'extern\' variable cannot have an initializer', decl.range);
  }
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
    out.push(this.createDecl('ParamDecl', params[i].range, {
      name: params[i].name,
      type: this.types.adjustParameter(params[i].type),
      defaultArg: params[i].defaultArg || null,
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

/**
 * A name used as an expression.
 *
 * @param {string} name
 * @param {Object} range
 * @param {?Object} [lookup] A lookup result already computed by the parser.
 */
Sema.prototype.actOnIdExpression = function (name, range, lookup) {
  var result = lookup || scopes.lookupUnqualified(this.scope, name);
  var decl;
  var type;
  if (!result.decls.length) {
    this.error('use of undeclared identifier \'' + name + '\'', range);
    return null;
  }
  if (result.ambiguous) {
    this.error('reference to \'' + name + '\' is ambiguous', range);
    return null;
  }
  decl = result.decls[0];
  switch (decl.kind) {
    case 'VarDecl':
    case 'ParamDecl':
    case 'FieldDecl':
      type = T.removeReference(decl.type);
      return this._expr('DeclRefExpr', range, { decl: decl }, type, 'lvalue');
    case 'FunctionDecl':
      // An overload set stays unresolved until the call (step 3).
      return this._expr('DeclRefExpr', range, { decl: decl }, decl.type, 'lvalue');
    case 'EnumeratorDecl':
      return this._expr('DeclRefExpr', range, { decl: decl }, decl.type, 'prvalue');
  }
  this.error('\'' + name + '\' does not refer to a value', range);
  return null;
};

/**
 * Unary `+`, `-`, `~`, `!` on constant operands (enough for array bounds
 * in step 1; full typing in step 3).
 */
Sema.prototype.actOnUnaryOperator = function (op, operand, range) {
  var type;
  if (!operand) {
    return null;
  }
  type = op === '!' ? this.types.builtin('bool') : T.promote(this.types,
    operand.type.unqualified);
  return this._expr('UnaryExpr', range, { operator: op, operand: operand, isPostfix: false },
    type, 'prvalue');
};

/** The function whose body is being parsed, or null. */
Sema.prototype.currentFunction = function () {
  var scope = this.scope;
  while (scope && scope.kind !== ScopeKind.FUNCTION) {
    scope = scope.parent;
  }
  return scope ? scope.entity : null;
};

/**
 * `return expr;` — checks the presence of a value against the return type
 * (conversion of the value comes with expression typing, step 3).
 */
Sema.prototype.actOnReturnStatement = function (value, range) {
  var fn = this.currentFunction();
  var returnsVoid = fn && T.isVoid(fn.type.returnType);
  if (fn && value && returnsVoid && value.type && !T.isVoid(value.type)) {
    this.error('void function \'' + fn.name + '\' should not return a value', range);
  } else if (fn && !value && !returnsVoid) {
    this.error('non-void function \'' + fn.name + '\' should return a value', range);
  }
  return ast.createNode('ReturnStmt', range, { value: value });
};

Sema.prototype.actOnInitList = function (inits, range) {
  return this._expr('InitListExpr', range, { inits: inits }, null, 'prvalue');
};

module.exports = {
  Sema: Sema,
  BUILTIN_COMBINATIONS: BUILTIN_COMBINATIONS
};
