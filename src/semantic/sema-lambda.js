'use strict';

/**
 * Lambda expressions (C++11 5.1.2), extends Sema.prototype, D-057.
 *
 * Each lambda gets a unique closure class with an `operator()` (const
 * unless `mutable`) and, when it captures nothing, a conversion to a
 * function pointer. Variables of enclosing functions used in the body are
 * captured explicitly or through the capture default; the capture is
 * recorded on every lambda between the use and the variable.
 */

var ast = require('../ast/nodes');
var T = require('./types');
var scopes = require('./scope');
var Sema = require('./sema').Sema;

var Scope = scopes.Scope;
var ScopeKind = scopes.ScopeKind;

/**
 * Starts a lambda: creates the closure class and its call operator, opens
 * the function scope of the body and declares the parameters.
 *
 * @param {Object} intro `{captureDefault, captures: [{name, byReference,
 *   isThis, range}], range}` from the lambda-introducer.
 * @param {Object} suffix Parsed function suffix (may be synthesized for
 *   `[]{}`), with `isMutable`.
 * @returns {Object} Lambda context, to pass to actOnFinishLambda.
 */
Sema.prototype.actOnStartLambda = function (intro, suffix, range) {
  var loc = range.source.getPresumedLocation(range.start);
  var record = this.createDecl('RecordDecl', range, { tag: 'class', name: '', complete: false,
    parent: this.currentContext(), bases: [], members: [] });
  var op;
  var info;
  var enclosing = this.currentFunction();
  record.qualifiedName = '(lambda at ' + loc.path + ':' + loc.line + ':' + loc.column + ')';
  record.isLambda = true;
  record.isDefined = true;
  record.scope = new Scope(ScopeKind.CLASS, this.scope, record);
  op = this.createDecl('FunctionDecl', range, {
    name: 'operator()',
    type: this.types.func(suffix.trailingReturn || this.types.builtin('void'),
      suffix.params.map(function (p) { return this.types.adjustParameter(p.type); }, this),
      { variadic: suffix.variadic, methodConst: !suffix.isMutable }),
    storage: '',
    isInline: true,
    parent: record,
    isMethod: true,
    isStatic: false,
    access: 'public',
    params: []
  });
  op.params = this._createParams(suffix.params);
  op.overloadedOperator = '()';
  info = {
    record: record,
    op: op,
    enclosing: enclosing,
    captureDefault: intro.captureDefault,
    explicit: Object.create(null),
    captures: [],
    thisCapture: null,
    isMutable: !!suffix.isMutable,
    deduceReturn: !suffix.trailingReturn,
    returnType: null,
    range: range
  };
  op.lambda = info;
  this._checkCaptureList(info, intro.captures);
  this.actOnStartFunctionBody(op);
  return info;
};

/** Validates the explicit captures of a lambda-introducer. */
Sema.prototype._checkCaptureList = function (info, captures) {
  var self = this;
  captures.forEach(function (c) {
    var result;
    var decl;
    if (c.isThis) {
      if (info.thisCapture) {
        self.error('\'this\' can appear only once in a capture list', c.range);
      } else if (!self._enclosingThisMethod()) {
        self.error('invalid use of \'this\' outside of a non-static member function', c.range);
      } else {
        info.thisCapture = c;
      }
      return;
    }
    if (info.explicit[c.name]) {
      self.error('\'' + c.name + '\' can appear only once in a capture list', c.range);
      return;
    }
    if (info.captureDefault === '=' && !c.byReference) {
      self.error('\'&\' must precede a capture when the capture default is \'=\'', c.range);
      return;
    }
    if (info.captureDefault === '&' && c.byReference) {
      self.error('\'&\' cannot precede a capture when the capture default is \'&\'', c.range);
      return;
    }
    result = scopes.lookupUnqualified(self.scope, c.name);
    decl = result.decls[0];
    if (!decl) {
      self.error('use of undeclared identifier \'' + c.name + '\'', c.range);
      return;
    }
    if ((decl.kind !== 'VarDecl' && decl.kind !== 'ParamDecl') || !decl.ownerFunction) {
      self.error('\'' + c.name + '\' cannot be captured because it does not have automatic ' +
        'storage duration', c.range);
      return;
    }
    info.explicit[c.name] = { decl: decl, byReference: c.byReference, range: c.range };
    self._recordCapture(info, decl, c.byReference, c.range);
  });
};

Sema.prototype._recordCapture = function (info, decl, byReference, range) {
  var i;
  for (i = 0; i < info.captures.length; i++) {
    if (info.captures[i].variable === decl) {
      return info.captures[i];
    }
  }
  info.captures.push(ast.createNode('LambdaCapture', range, { variable: decl,
    byReference: byReference, isThis: false }));
  return info.captures[info.captures.length - 1];
};

/** Lambdas enclosing the current point, outermost first. */
Sema.prototype._lambdaChain = function () {
  var chain = [];
  var scope = this.scope;
  while (scope) {
    if (scope.kind === ScopeKind.FUNCTION && scope.entity && scope.entity.lambda) {
      chain.unshift(scope.entity.lambda);
    }
    scope = scope.parent;
  }
  return chain;
};

/**
 * Use of a local variable of an enclosing function inside a lambda: every
 * lambda between the use and the variable must capture it.
 *
 * @returns {?Object} DeclRefExpr typed as seen through the captures.
 */
Sema.prototype.captureVariable = function (decl, range) {
  var chain = this._lambdaChain();
  var i;
  var info;
  var byReference = true;
  var explicit;
  var diag;
  var type;
  var node;
  var constCopy = false;
  // Only the lambdas nested inside the variable's function capture it: if
  // the variable belongs to a lambda body, start after that lambda.
  for (i = 0; i < chain.length; i++) {
    if (chain[i].op === decl.ownerFunction) {
      break;
    }
  }
  i = i < chain.length ? i + 1 : 0;
  for (; i < chain.length; i++) {
    info = chain[i];
    explicit = info.explicit[decl.name];
    if (explicit && explicit.decl === decl) {
      byReference = explicit.byReference;
    } else if (info.captureDefault) {
      byReference = info.captureDefault === '&';
      this._recordCapture(info, decl, byReference, range);
    } else {
      diag = this.error('variable \'' + decl.name + '\' cannot be implicitly captured in a ' +
        'lambda with no capture-default specified', range);
      this.note(diag, '\'' + decl.name + '\' declared here', decl.range);
      this.note(diag, 'lambda expression begins here', info.range);
      return null;
    }
    // A copy made by a non-mutable lambda is const inside it.
    constCopy = !byReference && !info.isMutable;
  }
  type = T.removeReference(decl.type);
  if (constCopy) {
    type = this.types.addQualifiers(type, true, false);
  }
  node = this._expr('DeclRefExpr', range, { decl: decl }, type, 'lvalue');
  node.isCapture = true;
  node.capturedByCopy = !byReference;
  return node;
};

/** The non-static member function enclosing the current lambdas, if any. */
Sema.prototype._enclosingThisMethod = function () {
  var fn = this.currentFunction();
  while (fn && fn.lambda) {
    fn = fn.lambda.enclosing;
  }
  return fn && fn.isMethod && !fn.isStatic && !fn.lambda ? fn : null;
};

/**
 * `this` inside a lambda refers to the enclosing member function's object,
 * which must be captured ([this], or implicitly by [=] / [&]).
 */
Sema.prototype.lambdaThis = function (range, implicit) {
  var chain = this._lambdaChain();
  var method = this._enclosingThisMethod();
  var i;
  if (!method) {
    if (!implicit) {
      this.error('invalid use of \'this\' outside of a non-static member function', range);
    }
    return null;
  }
  for (i = 0; i < chain.length; i++) {
    if (!chain[i].thisCapture && !chain[i].captureDefault) {
      this.note(this.error('\'this\' cannot be implicitly captured in this context', range),
        'lambda expression begins here', chain[i].range);
      return null;
    }
    chain[i].capturesThis = true;
  }
  return this._expr('ThisExpr', range, { isImplicit: !!implicit },
    this.types.pointer(this.types.qualified(this.types.record(method.parent),
      method.type.methodConst, method.type.methodVolatile)), 'prvalue');
};

/**
 * A `return` inside a lambda without an explicit return type: every
 * return must have the same (decayed) type, which becomes the return
 * type (C++11 5.1.2/4, with the C++14 multi-return rule GCC and Clang
 * also apply in C++11 mode).
 *
 * @returns {Object} ReturnStmt.
 */
Sema.prototype.lambdaReturn = function (info, value, range) {
  var operand = value ? this.rvalue(value) : null;
  var type = operand ? (T.isRecord(operand.type) ? operand.type.unqualified :
    operand.type) : this.types.builtin('void');
  if (value && value.kind === 'InitListExpr') {
    this.error('cannot deduce lambda return type from initializer list', range);
    return ast.createNode('ReturnStmt', range, { value: null });
  }
  if (info.returnType && info.returnType !== type) {
    this.error('return type ' + this.quote(type) + ' must match previous return type ' +
      this.quote(info.returnType) + ' when lambda expression has unspecified explicit return ' +
      'type', range);
  } else {
    info.returnType = type;
  }
  if (operand && T.isRecord(value.type) && value.valueCategory !== 'prvalue') {
    operand = this.copyObject(value, value.type);
  }
  return ast.createNode('ReturnStmt', range, { value: operand });
};

/**
 * Ends a lambda: fixes the call operator's type, lays out the closure
 * (one member per capture) and builds the LambdaExpr.
 */
Sema.prototype.actOnFinishLambda = function (info, body, range) {
  var record = info.record;
  var op = info.op;
  var self = this;
  var closureType = this.types.record(record);
  var node;
  var fnPtr;
  var conv;
  this.actOnFinishFunctionBody(op, body);
  if (info.deduceReturn) {
    // After an error in a returned value, `int` avoids further errors.
    op.type = this.types.func(info.returnType || this.types.builtin(info.returnFailed ? 'int' :
      'void'),
      op.type.params, { variadic: op.type.variadic, methodConst: op.type.methodConst });
  }
  record.members.push(op);
  record.scope.declare('operator()', op);
  // One member per capture (references take a pointer's size).
  info.captures.forEach(function (c, index) {
    var field = self.createDecl('FieldDecl', c.range, { name: '__capture' + index,
      type: c.byReference ? self.types.lvalueReference(T.removeReference(c.variable.type)) :
        T.removeReference(c.variable.type).unqualified,
      access: 'private', parent: record, index: index });
    field.width = null;
    record.members.push(field);
  });
  if (info.capturesThis || info.thisCapture) {
    record.members.push(this.createDecl('FieldDecl', range, { name: '__this', type:
      this.types.pointer(this.types.record(this._enclosingThisMethod().parent)),
      access: 'private', parent: record }));
  }
  this._layout(record);
  record.complete = true;
  this.declareImplicitMembers(record);
  // Without captures the closure converts to a function pointer (5.1.2/6).
  if (!info.captures.length && !info.capturesThis && !info.thisCapture) {
    fnPtr = this.types.pointer(this.types.func(op.type.returnType, op.type.params,
      { variadic: op.type.variadic }));
    conv = this.createDecl('FunctionDecl', range, { name: 'operator ' + T.typeToString(fnPtr),
      type: this.types.func(fnPtr, [], { methodConst: true }), storage: '', parent: record,
      isMethod: true, isStatic: false, access: 'public', params: [] });
    conv.methodKind = 'conversion';
    conv.conversionType = fnPtr;
    conv.isImplicit = true;
    record.members.push(conv);
  }
  // Default construction and assignment of closures are deleted (5.1.2/19).
  (record.constructors || []).forEach(function (c) {
    if (c.special === 'default') {
      c.isDeleted = true;
    }
  });
  record.scope.lookupLocal('operator=').forEach(function (a) {
    a.isDeleted = true;
  });
  node = this._expr('LambdaExpr', range, {
    captures: info.captures,
    params: op.params,
    body: body,
    captureDefault: info.captureDefault,
    isMutable: info.isMutable,
    returnType: op.type.returnType,
    closure: record
  }, closureType, 'prvalue');
  node.capturesThis = !!(info.capturesThis || info.thisCapture);
  return node;
};

module.exports = {};
