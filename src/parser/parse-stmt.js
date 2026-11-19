'use strict';

/**
 * Statement parsing (extends Parser.prototype).
 *
 * Step 1 of Phase 5 (D-042) covers what function bodies need to hold
 * declarations: compound, declaration, expression, null and return
 * statements. Control flow comes in step 4.
 */

var Parser = require('./parser').Parser;
var TokenKind = require('../lexer/lexer').TokenKind;
var ast = require('../ast/nodes');
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

Parser.prototype.parseStatement = function () {
  var tok = this.peek();
  var value;
  if (this.isPunct('{')) {
    return this.parseCompoundStatement(true);
  }
  if (this.acceptPunct(';')) {
    return ast.createNode('NullStmt', this.rangeOf(tok), {});
  }
  if (this.acceptKeyword('return')) {
    value = this.isPunct(';') ? null :
      this.isPunct('{') ? this.parseBracedInitList() : this.parseAssignmentExpression();
    this.expectPunct(';', 'after return statement');
    return this.sema.actOnReturnStatement(value, this.rangeFrom(tok));
  }
  if (this.startsDeclSpecifier(0) || this.isKeyword('using') || this.isKeyword('namespace') ||
      (this.isPunct('[') && this.isPunct('[', 1))) {
    return ast.createNode('DeclStmt', this.rangeOf(tok), { decls: this.parseDeclaration() });
  }
  value = this.parseAssignmentExpression();
  this.expectPunct(';', 'after expression');
  return ast.createNode('ExprStmt', this.rangeFrom(tok), { expr: value });
};
