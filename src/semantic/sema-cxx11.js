'use strict';

/**
 * C++11 features: `auto` deduction, `decltype`, `static_assert`
 * (extends Sema.prototype), D-055.
 */

var ast = require('../ast/nodes');
var T = require('./types');
var Sema = require('./sema').Sema;

/** Placeholder type standing for `auto` while a declarator is built. */
Sema.prototype.autoPlaceholder = function () {
  if (!this._autoRecord) {
    this._autoRecord = this.createDecl('RecordDecl', null, { tag: 'struct', name: 'auto',
      complete: true });
    this._autoRecord.qualifiedName = 'auto';
    this._autoRecord.isAutoPlaceholder = true;
    this._autoRecord.size = 0;
  }
  return this.types.record(this._autoRecord);
};

/** Whether a type contains the `auto` placeholder. */
Sema.prototype.containsAuto = function (type) {
  while (type) {
    if (T.isRecord(type) && type.decl.isAutoPlaceholder) {
      return true;
    }
    if (T.isPointer(type)) {
      type = type.pointee;
    } else if (T.isReference(type)) {
      type = type.referee;
    } else {
      return false;
    }
  }
  return false;
};

/**
 * Deduces the type of a variable declared with `auto` from its
 * initializer (C++11 7.1.6.4, as template argument deduction): `auto`
 * drops references and top-level cv and decays arrays and functions;
 * `auto &` keeps cv; `auto &&` is a forwarding reference.
 *
 * @param {Object} declared Declared type containing the placeholder.
 * @param {Object} init Initializer expression.
 * @returns {?Object} The deduced type, or null after an error.
 */
Sema.prototype.deduceAuto = function (declared, init, name, range) {
  var argType;
  var category;
  var deduced;
  var binding;
  if (init.kind === 'InitListExpr') {
    if (init.isBracedCopy) {
      this.error('deducing \'auto\' from a braced initializer list requires ' +
        'std::initializer_list, which is not supported yet', init.range);
      return null;
    }
    // N3922 (applied by GCC and Clang in C++11 mode): auto x{e} is e's type.
    if (init.inits.length !== 1) {
      this.error('initializer for variable \'' + name + '\' with type \'auto\' contains ' +
        'multiple expressions', init.range);
      return null;
    }
    init = init.inits[0];
  }
  if (!init.type || T.isVoid(init.type)) {
    this.error('variable \'' + name + '\' has incomplete type \'void\'', range);
    return null;
  }
  if (init.candidates && init.candidates.length > 1) {
    this.error('variable \'' + name + '\' with type \'auto\' has incompatible initializer of ' +
      'type \'<overloaded function type>\'', init.range);
    return null;
  }
  argType = init.type;
  category = init.valueCategory;
  binding = this._deduceBinding(declared, argType, category);
  if (!binding) {
    this.error('variable \'' + name + '\' with type ' + this.quote(declared) + ' has ' +
      'incompatible initializer of type ' + this.quote(argType), init.range);
    return null;
  }
  this._lastAutoBinding = binding;
  deduced = this._substituteAuto(declared, function () {
    return binding;
  }, category);
  return deduced;
};

/**
 * What `auto` stands for, matching the declared form against the
 * initializer type level by level (as template argument deduction,
 * C++11 14.8.2.1): plain `auto` decays and drops top-level cv; inside
 * pointers and references the cv of the argument not written in the
 * pattern stays in the deduced type.
 *
 * @returns {?Object} The deduced type for `auto`, or null if the forms
 *   do not match.
 */
Sema.prototype._deduceBinding = function (declared, argType, category) {
  var self = this;
  var binding = null;
  function isPlaceholder(t) {
    return T.isRecord(t) && t.decl.isAutoPlaceholder;
  }
  function withoutPatternCv(a, p) {
    return self.types.qualified(a, a.isConst && !p.isConst, a.isVolatile && !p.isVolatile);
  }
  function match(p, a) {
    if (isPlaceholder(p)) {
      binding = withoutPatternCv(a, p);
      return true;
    }
    if (T.isPointer(p)) {
      return T.isPointer(a) && match(p.pointee, a.pointee);
    }
    return false;
  }
  if (declared.kind === T.TypeKind.RVALUE_REF && isPlaceholder(declared.referee) &&
      !declared.referee.isConst && !declared.referee.isVolatile) {
    // Forwarding reference: binds anything; lvalues collapse to `A &`.
    return argType;
  }
  if (T.isReference(declared)) {
    if (declared.kind === T.TypeKind.RVALUE_REF && category === 'lvalue') {
      return null;
    }
    return match(declared.referee, argType) ? binding : null;
  }
  if (T.isArray(argType)) {
    argType = this.types.pointer(argType.element);
  } else if (T.isFunction(argType)) {
    argType = this.types.pointer(argType);
  } else {
    argType = argType.unqualified;
  }
  return match(declared, argType) ? binding : null;
};

/**
 * Rebuilds `declared` with the placeholder replaced; `pick(shape)` gives
 * the replacement for the innermost position.
 */
Sema.prototype._substituteAuto = function (declared, pick, category) {
  var self = this;
  function rebuild(type, shape) {
    var inner;
    if (T.isRecord(type) && type.decl.isAutoPlaceholder) {
      inner = pick(shape);
      return self.types.addQualifiers(inner, type.isConst, type.isVolatile);
    }
    if (T.isPointer(type)) {
      inner = rebuild(type.pointee, 'value');
      return inner && self.types.qualified(self.types.pointer(inner), type.isConst,
        type.isVolatile);
    }
    if (type.kind === T.TypeKind.LVALUE_REF) {
      inner = rebuild(type.referee, 'reference');
      return inner && self.types.lvalueReference(inner);
    }
    if (type.kind === T.TypeKind.RVALUE_REF) {
      inner = rebuild(type.referee, T.isRecord(type.referee) &&
        type.referee.decl.isAutoPlaceholder && !type.referee.isConst &&
        !type.referee.isVolatile ? 'forwarding' : 'reference');
      if (inner && T.isRecord(type.referee) && type.referee.decl.isAutoPlaceholder &&
          category === 'lvalue' && !type.referee.isConst) {
        return self.types.lvalueReference(inner);
      }
      return inner && self.types.rvalueReference(inner);
    }
    return type;
  }
  return rebuild(declared, 'value');
};

/**
 * `decltype(e)` (C++11 7.1.6.2/4): the declared type of an unparenthesized
 * name or member access; otherwise `T&` for lvalues, `T&&` for xvalues,
 * `T` for prvalues.
 */
Sema.prototype.actOnDecltype = function (expr, parenthesized) {
  if (!expr) {
    return this.types.builtin('int');
  }
  if (!parenthesized && expr.kind === 'DeclRefExpr' && expr.decl.type) {
    return expr.decl.type;
  }
  if (!parenthesized && expr.kind === 'MemberExpr' && expr.member.type) {
    return expr.member.type;
  }
  if (expr.valueCategory === 'lvalue') {
    return this.types.lvalueReference(expr.type);
  }
  if (expr.valueCategory === 'xvalue') {
    return this.types.rvalueReference(expr.type);
  }
  return expr.type;
};

/** `static_assert(constant-expression, "message");` */
Sema.prototype.actOnStaticAssert = function (condition, message, range) {
  var b;
  var value;
  var node = ast.createNode('StaticAssertDecl', range, { condition: condition,
    message: message });
  if (!condition) {
    return node;
  }
  b = this.contextualBool(condition);
  value = b ? this.evaluateConstant(b) : null;
  if (b && value === null) {
    this.error('static_assert expression is not an integral constant expression',
      condition.range);
  } else if (value === 0) {
    this.error('static assertion failed' + (message ? ': ' +
      String.fromCharCode.apply(null, message.units) : ''), condition.range);
  }
  return node;
};

module.exports = {};

// ---------------------------------------------------------------------------
// Range-based for (C++11 6.5.4).

/** A hidden variable of the range-for expansion (not visible by name). */
Sema.prototype._hiddenVariable = function (name, declared, init, range) {
  var decl = this.createDecl('VarDecl', range, { name: name, type: declared, storage: '',
    parent: this.currentContext() });
  var type;
  var result;
  decl.isImplicit = true;
  type = this.deduceAuto(declared, init, name, range);
  if (!type) {
    return null;
  }
  decl.type = type;
  result = this.initialize(type, init, 'copy', 'variable');
  if (!result) {
    return null;
  }
  decl.init = result.init;
  decl.initStyle = 'copy';
  return decl;
};

Sema.prototype._refTo = function (decl, range) {
  return this._expr('DeclRefExpr', range, { decl: decl }, T.removeReference(decl.type),
    'lvalue');
};

/**
 * Builds the hidden variables, condition and increment of
 * `for (decl : range)`, then declares and initializes the loop variable
 * with `*__begin`.
 *
 * @param {Object} node RangeForStmt being built.
 * @param {Object} spec decl-specifiers of the loop variable.
 * @param {Object} declarator Its declarator.
 * @param {Object} rangeExpr The range expression.
 * @returns {boolean} false after an error (the body is still parsed).
 */
Sema.prototype.actOnRangeForHeader = function (node, spec, declarator, rangeExpr, range) {
  var autoRef = this.types.rvalueReference(this.autoPlaceholder());
  var autoValue = this.autoPlaceholder();
  var rangeType;
  var beginExpr;
  var endExpr;
  var loopVar;
  var deref;
  node.variable = loopVar = this.actOnDeclarator(spec, declarator);
  if (!rangeExpr || !loopVar || loopVar.kind !== 'VarDecl') {
    return false;
  }
  if (rangeExpr.kind === 'InitListExpr') {
    this.error('iterating over a braced initializer list requires std::initializer_list, ' +
      'which is not supported yet', rangeExpr.range);
    return false;
  }
  node.rangeVar = this._hiddenVariable('__range', autoRef, rangeExpr, range);
  if (!node.rangeVar) {
    return false;
  }
  rangeType = T.removeReference(node.rangeVar.type);
  if (T.isArray(rangeType)) {
    if (rangeType.size === null) {
      this.error('cannot use incomplete type ' + this.quote(rangeType) + ' as a range',
        rangeExpr.range);
      return false;
    }
    node.rangeKind = 'array';
    beginExpr = this._refTo(node.rangeVar, range);
    endExpr = this.actOnBinaryOperator('+', this._refTo(node.rangeVar, range),
      this._expr('IntegerLiteral', range, { value: require('../util/int64').fromNumber(
        rangeType.size) }, this.types.builtin('int'), 'prvalue'), range);
  } else if (T.isRecord(rangeType) && this._hasBeginEndMembers(rangeType.decl)) {
    node.rangeKind = 'member';
    beginExpr = this.actOnCall(this.actOnMemberAccess(this._refTo(node.rangeVar, range),
      'begin', false, range, range), [], range);
    endExpr = this.actOnCall(this.actOnMemberAccess(this._refTo(node.rangeVar, range),
      'end', false, range, range), [], range);
  } else {
    node.rangeKind = 'adl';
    beginExpr = this._adlCall('begin', this._refTo(node.rangeVar, range), range);
    endExpr = beginExpr ? this._adlCall('end', this._refTo(node.rangeVar, range), range) : null;
    if (!beginExpr || !endExpr) {
      this.error('invalid range expression of type ' + this.quote(rangeType) + '; no viable ' +
        '\'' + (beginExpr ? 'end' : 'begin') + '\' function available', rangeExpr.range);
      return false;
    }
  }
  if (!beginExpr || !endExpr) {
    return false;
  }
  node.beginVar = this._hiddenVariable('__begin', autoValue, beginExpr, range);
  node.endVar = this._hiddenVariable('__end', autoValue, endExpr, range);
  if (!node.beginVar || !node.endVar) {
    return false;
  }
  node.condition = this.contextualBool(this.actOnBinaryOperator('!=',
    this._refTo(node.beginVar, range), this._refTo(node.endVar, range), range));
  node.increment = this.actOnUnaryOperator('++', this._refTo(node.beginVar, range), range);
  deref = this.actOnUnaryOperator('*', this._refTo(node.beginVar, range), range);
  if (!node.condition || !node.increment || !deref) {
    return false;
  }
  this.actOnVariableInit(loopVar, deref, 'copy');
  return true;
};

Sema.prototype._hasBeginEndMembers = function (record) {
  return require('./scope').lookupMember(record, 'begin').decls.length > 0 &&
    require('./scope').lookupMember(record, 'end').decls.length > 0;
};

/** `begin(range)` / `end(range)` found by argument-dependent lookup only. */
Sema.prototype._adlCall = function (name, arg, range) {
  var namespaces = this._associatedNamespaces([arg.type]);
  var candidates = [];
  var chosen;
  var errors = this.diagnostics.errorCount;
  namespaces.forEach(function (ns) {
    require('./scope').lookupInNamespace(ns, name).decls.forEach(function (d) {
      if (d.kind === 'FunctionDecl' && candidates.indexOf(d) === -1) {
        candidates.push(d);
      }
    });
  });
  if (!candidates.length) {
    return null;
  }
  chosen = this.resolveOverload(candidates, [arg], range, name);
  if (!chosen && this.diagnostics.errorCount > errors) {
    return null;
  }
  return chosen ? this._expr('CallExpr', range, {
    callee: this.rvalue(this.selectOverload(this._expr('DeclRefExpr', range,
      { decl: chosen.decl }, chosen.decl.type, 'lvalue'), chosen.decl)),
    args: chosen.args,
    'function': chosen.decl
  }, T.removeReference(chosen.decl.type.returnType), chosen.decl.type.returnType.kind ===
    T.TypeKind.LVALUE_REF ? 'lvalue' : 'prvalue') : null;
};
