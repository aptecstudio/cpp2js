'use strict';

/**
 * Statement parsing (extends Parser.prototype), C++11 clause 6, D-048.
 *
 * Every substatement of a selection or iteration statement gets its own
 * block scope, and so does a condition that declares a variable (6.4/1,
 * 6.5/2). Range-based for comes with the C++11 step.
 */

var Parser = require('./parser').Parser;
var TokenKind = require('../lexer/lexer').TokenKind;
var ast = require('../ast/nodes');
var T = require('../semantic/types');
var ScopeKind = require('../semantic/scope').ScopeKind;

/**
 * `{ statement-seq }`
 *
 * @param {boolean} newScope False for a function body, whose outermost
 *   block shares the scope of the parameters (C++11 3.3.3/2).
 * @returns {Object} CompoundStmt.
 */
Parser.prototype.parseCompoundStatement = function (newScope) {
  var open = this.expectPunct('{');
  var self = this;
  var stmts = [];
  var stmt;
  var node;
  if (newScope) {
    this.sema.pushScope(ScopeKind.BLOCK, null);
  }
  try {
    while (!this.isPunct('}') && this.peek().kind !== TokenKind.EOF) {
      stmt = this.withRecovery(function () {
        return self.parseStatement();
      });
      if (stmt) {
        stmts.push(stmt);
      }
    }
    this.expectPunct('}', '', open);
  } finally {
    node = ast.createNode('CompoundStmt', this.rangeFrom(open), { stmts: stmts,
      scope: this.sema.scope });
    if (newScope) {
      this.sema.popScope();
    }
  }
  return node;
};

/** Parses a substatement in its own block scope. */
Parser.prototype.parseScopedStatement = function () {
  var stmt;
  this.sema.pushScope(ScopeKind.BLOCK, null);
  try {
    stmt = this.parseStatement();
  } finally {
    this.sema.popScope();
  }
  return stmt;
};

Parser.prototype.parseStatement = function () {
  var tok = this.peek();
  var value;
  var hadValue;
  if (this.isPunct('{')) {
    return this.parseCompoundStatement(true);
  }
  if (this.acceptPunct(';')) {
    return ast.createNode('NullStmt', this.rangeOf(tok), {});
  }
  if (tok.kind === TokenKind.IDENTIFIER && this.isPunct(':', 1)) {
    return this.parseLabeledStatement();
  }
  if (tok.kind === TokenKind.KEYWORD) {
    switch (tok.value) {
      case 'if':
        return this.parseIfStatement();
      case 'switch':
        return this.parseSwitchStatement();
      case 'while':
        return this.parseWhileStatement();
      case 'do':
        return this.parseDoStatement();
      case 'for':
        return this.parseForStatement();
      case 'case':
        return this.parseCaseStatement();
      case 'default':
        return this.parseDefaultStatement();
      case 'break':
        this.next();
        this.expectPunct(';', 'after break statement');
        return this.sema.actOnBreak(this.rangeOf(tok));
      case 'continue':
        this.next();
        this.expectPunct(';', 'after continue statement');
        return this.sema.actOnContinue(this.rangeOf(tok));
      case 'goto':
        return this.parseGotoStatement();
      case 'return':
        this.next();
        hadValue = !this.isPunct(';');
        value = !hadValue ? null :
          this.isPunct('{') ? this.parseBracedInitList() : this.parseExpression();
        this.expectPunct(';', 'after return statement');
        return this.sema.actOnReturnStatement(value, this.rangeFrom(tok), hadValue);
      case 'try':
      case 'catch':
        this.fail('exceptions are not supported yet');
        break;
      case 'else':
        this.fail('expected expression');
        break;
    }
  }
  if (this.startsDeclSpecifier(0) || this.isKeyword('using') || this.isKeyword('namespace') ||
      this.isKeyword('static_assert') ||
      (this.isPunct('[') && this.isPunct('[', 1))) {
    return ast.createNode('DeclStmt', this.rangeOf(tok), { decls: this.parseDeclaration() });
  }
  value = this.parseExpression();
  this.expectPunct(';', 'after expression');
  return value ? this.sema.actOnExpressionStatement(value, this.rangeFrom(tok)) :
    ast.createNode('NullStmt', this.rangeFrom(tok), {});
};

/**
 * condition: an expression, or a declaration with an initializer
 * (`int x = f()`, `int x{f()}`).
 *
 * @param {boolean} isSwitch The condition of a switch (integral, not bool).
 * @returns {{variable: ?Object, condition: ?Object}}
 */
Parser.prototype.parseCondition = function (isSwitch) {
  var spec;
  var declarator;
  var decl;
  var init = null;
  var style = null;
  var expr;
  if (!this.startsDeclSpecifier(0)) {
    expr = this.parseExpression();
    return { variable: null, condition: isSwitch ? this.sema.actOnSwitchCondition(expr) :
      this.sema.actOnCondition(expr) };
  }
  spec = this.parseDeclSpecifiers();
  declarator = this.parseDeclarator(false);
  decl = this.sema.actOnDeclarator(spec, declarator);
  if (this.acceptPunct('=')) {
    style = 'copy';
    init = this.isPunct('{') ? this.parseBracedInitList() : this.parseAssignmentExpression();
  } else if (this.isPunct('{')) {
    style = 'list';
    init = this.parseBracedInitList();
  }
  this.sema.actOnVariableInit(decl, init, style);
  if (!decl || decl.kind !== 'VarDecl') {
    return { variable: null, condition: null };
  }
  if (!isSwitch) {
    return { variable: decl, condition: this.sema.actOnConditionVariable(decl) };
  }
  if (!decl.init) {
    this.diagnostics.error('variable declaration in condition must have an initializer',
      decl.range);
    return { variable: decl, condition: null };
  }
  return { variable: decl, condition: this.sema.actOnSwitchCondition(
    this.sema._expr('DeclRefExpr', decl.range, { decl: decl }, T.removeReference(decl.type),
      'lvalue')) };
};

/** `( condition )` */
Parser.prototype._parenCondition = function (keyword, isSwitch) {
  var open = this.expectPunct('(', 'after \'' + keyword.value + '\'');
  var result = this.parseCondition(isSwitch);
  this.expectPunct(')', '', open);
  return result;
};

/** Warns about `if (x);` with the `;` on the same line (-Wempty-body). */
Parser.prototype._checkEmptyBody = function (what) {
  var semi = this.peek();
  if (this.isPunct(';') && !semi.lineStart) {
    this.diagnostics.warning(what + ' has empty body', this.rangeOf(semi))
      .addNote('put the semicolon on a separate line to silence this warning',
        this.rangeOf(semi));
  }
};

Parser.prototype.parseIfStatement = function () {
  var keyword = this.next();
  var cond;
  var then;
  var otherwise = null;
  this.sema.pushScope(ScopeKind.BLOCK, null);
  try {
    cond = this._parenCondition(keyword, false);
    this._checkEmptyBody('if statement');
    then = this.parseScopedStatement();
    if (this.acceptKeyword('else')) {
      otherwise = this.parseScopedStatement();
    }
  } finally {
    this.sema.popScope();
  }
  return ast.createNode('IfStmt', this.rangeFrom(keyword), { conditionVar: cond.variable,
    condition: cond.condition, then: then, otherwise: otherwise });
};

Parser.prototype.parseSwitchStatement = function () {
  var keyword = this.next();
  var node = ast.createNode('SwitchStmt', null, {});
  var cond;
  this.sema.pushScope(ScopeKind.BLOCK, null);
  try {
    cond = this._parenCondition(keyword, true);
    node.conditionVar = cond.variable;
    node.condition = cond.condition;
    this.sema.pushBreakable('switch', node);
    try {
      this.sema.setSwitchConditionType(cond.condition ? cond.condition.type : null);
      node.body = this.parseScopedStatement();
    } finally {
      this.sema.finishSwitch(node);
    }
  } finally {
    this.sema.popScope();
  }
  node.range = this.rangeFrom(keyword);
  return node;
};

Parser.prototype.parseCaseStatement = function () {
  var keyword = this.next();
  var value = this.parseConstantExpression();
  var node;
  if (this.isPunct('...')) {
    this.fail('case ranges are a GNU extension and are not supported');
  }
  this.expectPunct(':', 'after \'case\'');
  node = this.sema.actOnCase(value, this.rangeFrom(keyword));
  node.body = this._labelBody();
  return node;
};

Parser.prototype.parseDefaultStatement = function () {
  var keyword = this.next();
  var node;
  this.expectPunct(':', 'after \'default\'');
  node = this.sema.actOnDefault(this.rangeOf(keyword));
  node.body = this._labelBody();
  return node;
};

/** The statement after a label; C++11 requires one. */
Parser.prototype._labelBody = function () {
  if (this.isPunct('}')) {
    this.fail('label at end of compound statement: expected statement');
  }
  return this.parseStatement();
};

Parser.prototype.parseLabeledStatement = function () {
  var name = this.next();
  var node;
  this.next();
  node = this.sema.actOnLabel(name.value, this.rangeOf(name));
  node.body = this._labelBody();
  return node;
};

Parser.prototype.parseGotoStatement = function () {
  var keyword = this.next();
  var name = this.peek();
  if (name.kind !== TokenKind.IDENTIFIER) {
    this.fail(this.isPunct('*') ? 'computed goto is a GNU extension and is not supported' :
      'expected identifier');
  }
  this.next();
  this.expectPunct(';', 'after goto statement');
  return this.sema.actOnGoto(name.value, this.rangeFrom(keyword));
};

Parser.prototype.parseWhileStatement = function () {
  var keyword = this.next();
  var node = ast.createNode('WhileStmt', null, {});
  var cond;
  this.sema.pushScope(ScopeKind.BLOCK, null);
  try {
    cond = this._parenCondition(keyword, false);
    node.conditionVar = cond.variable;
    node.condition = cond.condition;
    this._checkEmptyBody('while loop');
    this.sema.pushBreakable('loop', node);
    try {
      node.body = this.parseScopedStatement();
    } finally {
      this.sema.popBreakable();
    }
  } finally {
    this.sema.popScope();
  }
  node.range = this.rangeFrom(keyword);
  return node;
};

Parser.prototype.parseDoStatement = function () {
  var keyword = this.next();
  var node = ast.createNode('DoStmt', null, {});
  var open;
  this.sema.pushBreakable('loop', node);
  try {
    node.body = this.parseScopedStatement();
  } finally {
    this.sema.popBreakable();
  }
  if (!this.acceptKeyword('while')) {
    this.fail('expected \'while\' in do/while loop');
  }
  open = this.expectPunct('(', 'after \'while\'');
  node.condition = this.sema.actOnCondition(this.parseExpression());
  this.expectPunct(')', '', open);
  this.expectPunct(';', 'after do/while statement');
  node.range = this.rangeFrom(keyword);
  return node;
};

Parser.prototype.parseForStatement = function () {
  var keyword = this.next();
  var node = ast.createNode('ForStmt', null, {});
  var open = this.expectPunct('(', 'after \'for\'');
  var cond;
  var start;
  this.sema.pushScope(ScopeKind.BLOCK, null);
  try {
    start = this.peek();
    if (this.isPunct(';')) {
      this.next();
    } else if (this.startsDeclSpecifier(0)) {
      node.init = ast.createNode('DeclStmt', this.rangeOf(start), {
        decls: this._parseForDeclaration() });
    } else {
      node.init = this.sema.actOnExpressionStatement(this.parseExpression(),
        this.rangeFrom(start));
      this.expectPunct(';', 'in \'for\' statement specifier');
    }
    if (!this.isPunct(';')) {
      cond = this.parseCondition(false);
      node.conditionVar = cond.variable;
      node.condition = cond.condition;
    }
    this.expectPunct(';', 'in \'for\' statement specifier');
    if (!this.isPunct(')')) {
      node.increment = this.parseExpression();
    }
    this.expectPunct(')', '', open);
    this._checkEmptyBody('for loop');
    this.sema.pushBreakable('loop', node);
    try {
      node.body = this.parseScopedStatement();
    } finally {
      this.sema.popBreakable();
    }
  } finally {
    this.sema.popScope();
  }
  node.range = this.rangeFrom(keyword);
  return node;
};

/**
 * The init-statement of `for` when it is a declaration; a `:` after the
 * first declarator is a range-based for (C++11 step).
 */
Parser.prototype._parseForDeclaration = function () {
  var spec = this.parseDeclSpecifiers();
  var decls = [];
  var declarator;
  var decl;
  for (;;) {
    declarator = this.parseDeclarator(false);
    if (this.isPunct(':') && !decls.length) {
      this.fail('range-based for loops are not supported yet');
    }
    decl = this.sema.actOnDeclarator(spec, declarator);
    this.parseInitializer(decl);
    if (decl) {
      decls.push(decl);
    }
    if (!this.acceptPunct(',')) {
      break;
    }
  }
  this.expectPunct(';', 'in \'for\' statement specifier');
  return decls;
};
