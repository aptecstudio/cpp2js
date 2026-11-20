'use strict';

/**
 * Semantic analysis of statements (extends Sema.prototype), C++11 clause 6,
 * D-048.
 *
 * Per function body Sema keeps the labels, the pending gotos and a stack of
 * the enclosing loops and switches. Jumps (goto, case and default labels)
 * may not bypass the declaration of a variable that has an initializer or
 * a non-scalar type (C++11 6.7/3): each jump source and target records the
 * variables in scope at that point, and the difference is checked.
 */

var ast = require('../ast/nodes');
var T = require('./types');
var I = require('../util/int64');
var ScopeKind = require('./scope').ScopeKind;
var constant = require('./constant');
var Sema = require('./sema').Sema;

/**
 * Per-function statement state.
 */
function FunctionState(decl) {
  this.decl = decl;
  this.labels = Object.create(null);
  this.gotos = [];
  this.jumpTargets = [];
  this.hasReturn = false;
}

var originalStart = Sema.prototype.actOnStartFunctionBody;
var originalFinish = Sema.prototype.actOnFinishFunctionBody;

Sema.prototype.actOnStartFunctionBody = function (decl) {
  this._functionStates = this._functionStates || [];
  this._functionStates.push(new FunctionState(decl));
  originalStart.call(this, decl);
};

Sema.prototype.actOnFinishFunctionBody = function (decl, body) {
  var state = this._functionStates.pop();
  if (state && body) {
    this._resolveGotos(state);
    this._checkFallOffEnd(decl, body);
    this._warnUninitialized(body);
  }
  originalFinish.call(this, decl, body);
};

Sema.prototype._state = function () {
  var states = this._functionStates;
  return states && states.length ? states[states.length - 1] : null;
};

// ---------------------------------------------------------------------------
// Scope snapshots for jump checks.

/**
 * Variables declared so far in the block scopes of the current function,
 * innermost scope last.
 */
Sema.prototype._liveVariables = function () {
  var out = [];
  var scope = this.scope;
  var chain = [];
  var i;
  var j;
  while (scope && scope.kind !== ScopeKind.NAMESPACE && scope.kind !== ScopeKind.CLASS) {
    chain.unshift(scope);
    if (scope.kind === ScopeKind.FUNCTION) {
      break;
    }
    scope = scope.parent;
  }
  for (i = 0; i < chain.length; i++) {
    for (j = 0; j < chain[i].decls.length; j++) {
      if (chain[i].decls[j].kind === 'VarDecl' && chain[i].decls[j].storage !== 'extern' &&
          chain[i].decls[j].storage !== 'static') {
        out.push(chain[i].decls[j]);
      }
    }
  }
  return out;
};

/**
 * A variable can be jumped over only if it has scalar type and no
 * initializer (C++11 6.7/3).
 */
function isBypassable(decl) {
  return !decl.init && (T.isScalar(decl.type) || (T.isArray(decl.type) &&
    T.isScalar(innermostElement(decl.type))));
}

function innermostElement(type) {
  while (T.isArray(type)) {
    type = type.element;
  }
  return type;
}

/**
 * Checks a jump between two points; reports the first bypassed
 * initialization.
 *
 * @returns {boolean} Whether the jump is valid.
 */
Sema.prototype._checkJump = function (from, to, message, range) {
  var i;
  var diag;
  for (i = 0; i < to.length; i++) {
    if (from.indexOf(to[i]) === -1 && !isBypassable(to[i])) {
      diag = this.error(message, range);
      this.note(diag, 'jump bypasses variable initialization', to[i].range);
      return false;
    }
  }
  return true;
};

// ---------------------------------------------------------------------------
// Conditions.

/**
 * Condition of `if`, `while`, `for`: an expression contextually converted
 * to bool, with Clang's warning for `if (x = 1)`.
 */
Sema.prototype.actOnCondition = function (expr) {
  if (!expr) {
    return null;
  }
  if (expr.kind === 'BinaryExpr' && expr.operator === '=') {
    this.note(this.warning('using the result of an assignment as a condition without ' +
      'parentheses', expr.range), 'place parentheses around the assignment to silence this ' +
      'warning', expr.range);
  }
  return this.contextualBool(expr);
};

/**
 * Condition declared as a variable (`if (int x = f())`): the variable's
 * value, converted to bool.
 */
Sema.prototype.actOnConditionVariable = function (decl) {
  var ref;
  if (!decl || decl.kind !== 'VarDecl') {
    return null;
  }
  if (!decl.init) {
    this.error('variable declaration in condition must have an initializer', decl.range);
    return null;
  }
  ref = this._expr('DeclRefExpr', decl.range, { decl: decl }, T.removeReference(decl.type),
    'lvalue');
  return this.contextualBool(ref);
};

// ---------------------------------------------------------------------------
// Loops and switch.

/** Stack of enclosing loops and switches (`{kind, node}`). */
Sema.prototype._breakables = function () {
  this._breakableStack = this._breakableStack || [];
  return this._breakableStack;
};

Sema.prototype.pushBreakable = function (kind, node) {
  this._breakables().push({ kind: kind, node: node, cases: [], hasDefault: null,
    conditionType: null, live: this._liveVariables() });
};

Sema.prototype.popBreakable = function () {
  return this._breakables().pop();
};

Sema.prototype.actOnBreak = function (range) {
  var stack = this._breakables();
  if (!stack.length) {
    this.error('\'break\' statement not in loop or switch statement', range);
  }
  return ast.createNode('BreakStmt', range, { target: stack.length ?
    stack[stack.length - 1].node : null });
};

Sema.prototype.actOnContinue = function (range) {
  var stack = this._breakables();
  var i;
  for (i = stack.length - 1; i >= 0; i--) {
    if (stack[i].kind === 'loop') {
      return ast.createNode('ContinueStmt', range, { target: stack[i].node });
    }
  }
  this.error('\'continue\' statement not in loop statement', range);
  return ast.createNode('ContinueStmt', range, {});
};

/**
 * Condition of a switch: integral or enumeration type, promoted
 * (C++11 6.4.2/2).
 *
 * @returns {?Object} The converted condition.
 */
Sema.prototype.actOnSwitchCondition = function (expr, range) {
  var operand = this.rvalue(expr);
  if (!operand) {
    return null;
  }
  if (!(T.isIntegral(operand.type) || T.isEnum(operand.type))) {
    this.error('statement requires expression of integer type (' + this.quote(operand.type) +
      ' invalid)', range || expr.range);
    return null;
  }
  // Kept for -Wswitch, checked when the switch ends.
  this._lastSwitchEnum = T.isEnum(operand.type) ? operand.type : null;
  return T.isScopedEnum(operand.type) ? operand : this._promoted(operand);
};

/** Switch the next `case`/`default` labels belong to. */
Sema.prototype._currentSwitch = function () {
  var stack = this._breakables();
  var i;
  for (i = stack.length - 1; i >= 0; i--) {
    if (stack[i].kind === 'switch') {
      return stack[i];
    }
  }
  return null;
};

Sema.prototype.setSwitchConditionType = function (type) {
  var sw = this._currentSwitch();
  if (sw) {
    sw.conditionType = type;
    sw.enumType = type ? this._lastSwitchEnum : null;
  }
};

/**
 * `case constant-expression:` — the value is converted to the promoted
 * type of the condition and must be unique.
 *
 * @returns {Object} CaseStmt (body filled by the caller).
 */
Sema.prototype.actOnCase = function (value, range) {
  var sw = this._currentSwitch();
  var node = ast.createNode('CaseStmt', range, { value: value });
  var converted;
  var v;
  var i;
  var diag;
  if (!sw) {
    this.error('\'case\' statement not in switch statement', range);
    return node;
  }
  if (!value || !sw.conditionType) {
    return node;
  }
  converted = this.convertTo(value, sw.conditionType, 'variable');
  v = converted ? constant.evaluate(this, converted) : null;
  if (converted && v === null) {
    this.error('expression is not an integral constant expression', value.range);
    return node;
  }
  if (v === null) {
    return node;
  }
  node.value = converted;
  node.constant = v;
  for (i = 0; i < sw.cases.length; i++) {
    if (I.eq(sw.cases[i].constant, v)) {
      diag = this.error('duplicate case value \'' + I.toString(v,
        !T.isUnsigned(sw.conditionType)) + '\'', value.range);
      this.note(diag, 'previous case defined here', sw.cases[i].value.range);
      return node;
    }
  }
  sw.cases.push(node);
  this._checkJump(sw.live, this._liveVariables(), 'cannot jump from switch statement to ' +
    'this case label', range);
  return node;
};

Sema.prototype.actOnDefault = function (range) {
  var sw = this._currentSwitch();
  var node = ast.createNode('DefaultStmt', range, {});
  var diag;
  if (!sw) {
    this.error('\'default\' statement not in switch statement', range);
    return node;
  }
  if (sw.hasDefault) {
    diag = this.error('multiple default labels in one switch', range);
    this.note(diag, 'previous case defined here', sw.hasDefault.range);
    return node;
  }
  sw.hasDefault = node;
  this._checkJump(sw.live, this._liveVariables(), 'cannot jump from switch statement to ' +
    'this case label', range);
  return node;
};

Sema.prototype.finishSwitch = function (node) {
  var sw = this.popBreakable();
  node.cases = sw.cases.concat(sw.hasDefault ? [sw.hasDefault] : []);
  this._warnSwitchEnum(sw, node);
};

// ---------------------------------------------------------------------------
// goto and labels.

Sema.prototype.actOnLabel = function (name, range) {
  var state = this._state();
  var node = ast.createNode('LabelStmt', range, { name: name });
  var diag;
  if (!state) {
    return node;
  }
  if (state.labels[name]) {
    diag = this.error('redefinition of label \'' + name + '\'', range);
    this.note(diag, 'previous definition is here', state.labels[name].node.range);
    return node;
  }
  state.labels[name] = { node: node, live: this._liveVariables() };
  return node;
};

Sema.prototype.actOnGoto = function (name, range) {
  var state = this._state();
  var node = ast.createNode('GotoStmt', range, { label: name });
  if (state) {
    state.gotos.push({ node: node, live: this._liveVariables() });
  }
  return node;
};

/** Binds gotos to their labels at the end of the function. */
Sema.prototype._resolveGotos = function (state) {
  var i;
  var jump;
  var label;
  for (i = 0; i < state.gotos.length; i++) {
    jump = state.gotos[i];
    label = state.labels[jump.node.label];
    if (!label) {
      this.error('use of undeclared label \'' + jump.node.label + '\'', jump.node.range);
      continue;
    }
    jump.node.target = label.node;
    this._checkJump(jump.live, label.live, 'cannot jump from this goto statement to its label',
      jump.node.range);
  }
};

// ---------------------------------------------------------------------------
// Falling off the end of a non-void function (-Wreturn-type).

/**
 * Whether control can reach the end of a statement. Conservative: loops
 * with a constant true condition and no `break` do not complete; gotos
 * are assumed to complete.
 */
Sema.prototype._canComplete = function (stmt) {
  var i;
  if (!stmt) {
    return true;
  }
  switch (stmt.kind) {
    case 'ReturnStmt':
      return false;
    case 'CompoundStmt':
      for (i = 0; i < stmt.stmts.length; i++) {
        if (!this._canComplete(stmt.stmts[i])) {
          return this._hasLabelAfter(stmt.stmts, i);
        }
      }
      return true;
    case 'IfStmt':
      return !stmt.otherwise || this._canComplete(stmt.then) ||
        this._canComplete(stmt.otherwise);
    case 'WhileStmt':
    case 'ForStmt':
      return !this._isConstantTrue(stmt.condition, stmt.kind === 'ForStmt') ||
        this._containsBreak(stmt.body, stmt);
    case 'DoStmt':
      return (this._canComplete(stmt.body) && !this._isConstantTrue(stmt.condition, false)) ||
        this._containsBreak(stmt.body, stmt);
    case 'SwitchStmt':
      return true;
    case 'LabelStmt':
    case 'CaseStmt':
    case 'DefaultStmt':
      return this._canComplete(stmt.body);
    case 'ExprStmt':
      // A call to a function returning nothing may still never return;
      // without [[noreturn]] tracking, assume it returns.
      return true;
  }
  return true;
};

/** A label after a terminating statement may make the rest reachable. */
Sema.prototype._hasLabelAfter = function (stmts, index) {
  var i;
  for (i = index + 1; i < stmts.length; i++) {
    if (stmts[i].kind === 'LabelStmt') {
      return this._canComplete({ kind: 'CompoundStmt', stmts: stmts.slice(i) });
    }
  }
  return false;
};

Sema.prototype._isConstantTrue = function (condition, missingIsTrue) {
  var v;
  if (!condition) {
    return missingIsTrue;
  }
  v = constant.evaluate(this, condition);
  return v !== null && !I.isZero(v);
};

/** Whether `body` contains a `break` that exits `loop`. */
Sema.prototype._containsBreak = function (body, loop) {
  var found = false;
  if (!body) {
    return false;
  }
  ast.walk(body, function (node) {
    if (node.kind === 'BreakStmt' && node.target === loop) {
      found = true;
    }
    return !found;
  });
  return found;
};

Sema.prototype._checkFallOffEnd = function (decl, body) {
  var hasReturn = false;
  if (T.isVoid(decl.type.returnType) || (decl.name === 'main' &&
      decl.parent === this.globalNamespace)) {
    // main returns 0 implicitly (C++11 3.6.1/5).
    return;
  }
  if (!this._canComplete(body)) {
    return;
  }
  if (decl.errorsBeforeBody !== undefined && this.diagnostics.errorCount > decl.errorsBeforeBody) {
    // Statements dropped by error recovery may have returned.
    return;
  }
  ast.walk(body, function (node) {
    if (node.kind === 'ReturnStmt') {
      hasReturn = true;
    }
    return !hasReturn;
  });
  this.warning('non-void function does not return a value' + (hasReturn ?
    ' in all control paths' : ''), endOfBody(body));
};

/** Range of the closing brace of a compound statement. */
function endOfBody(body) {
  return { source: body.range.source, start: body.range.end - 1, end: body.range.end };
}

module.exports = {};
