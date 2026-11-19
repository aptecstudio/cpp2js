'use strict';

/**
 * Expression parsing (extends Parser.prototype).
 *
 * Step 1 of Phase 5 (D-042) only needs what declarations use: literals,
 * names, parentheses and unary `+ - ~ !`. The full C++ precedence grammar
 * replaces this in step 3.
 */

var Parser = require('./parser').Parser;
var TokenKind = require('../lexer/lexer').TokenKind;

/** assignment-expression (step 1: unary expressions only). */
Parser.prototype.parseAssignmentExpression = function () {
  return this.parseUnaryExpression();
};

/** constant-expression: a conditional-expression (C++11 5.19). */
Parser.prototype.parseConstantExpression = function () {
  return this.parseAssignmentExpression();
};

/** expression-list: initializer-clauses separated by commas. */
Parser.prototype.parseExpressionList = function () {
  var list = [];
  do {
    list.push(this.isPunct('{') ? this.parseBracedInitList() : this.parseAssignmentExpression());
  } while (this.acceptPunct(','));
  return list;
};

Parser.prototype.parseUnaryExpression = function () {
  var tok = this.peek();
  var operand;
  if (tok.kind === TokenKind.PUNCT &&
      (tok.value === '+' || tok.value === '-' || tok.value === '~' || tok.value === '!')) {
    this.next();
    operand = this.parseUnaryExpression();
    return this.sema.actOnUnaryOperator(tok.value, operand, this.rangeFrom(tok));
  }
  return this.parsePrimaryExpression();
};

/** `ns::name`, `::name` as an expression. */
Parser.prototype.parseQualifiedIdExpression = function () {
  var first = this.peek();
  var name = this.parseQualifiedName();
  return this.sema.actOnIdExpression(name.name, this.rangeFrom(first), name.qualifier);
};

Parser.prototype.parsePrimaryExpression = function () {
  var tok = this.peek();
  var inner;
  switch (tok.kind) {
    case TokenKind.INTEGER:
      this.next();
      return this.sema.actOnIntegerLiteral(tok, this.rangeOf(tok));
    case TokenKind.FLOAT:
      this.next();
      return this.sema.actOnFloatLiteral(tok, this.rangeOf(tok));
    case TokenKind.CHAR:
      this.next();
      return this.sema.actOnCharLiteral(tok, this.rangeOf(tok));
    case TokenKind.STRING:
      this.next();
      return this.sema.actOnStringLiteral(tok, this.rangeOf(tok));
    case TokenKind.IDENTIFIER:
      if (this._startsQualifiedName(0)) {
        return this.parseQualifiedIdExpression();
      }
      this.next();
      return this.sema.actOnIdExpression(tok.value, this.rangeOf(tok));
    case TokenKind.KEYWORD:
      if (tok.value === 'true' || tok.value === 'false') {
        this.next();
        return this.sema.actOnBoolLiteral(tok.value === 'true', this.rangeOf(tok));
      }
      if (tok.value === 'nullptr') {
        this.next();
        return this.sema.actOnNullptr(this.rangeOf(tok));
      }
      break;
    case TokenKind.PUNCT:
      if (tok.value === '::') {
        return this.parseQualifiedIdExpression();
      }
      if (tok.value === '(') {
        this.next();
        inner = this.parseAssignmentExpression();
        this.expectPunct(')', '', tok);
        return this.sema.actOnParenExpr(inner, this.rangeFrom(tok));
      }
      break;
  }
  this.fail('expected expression');
  return null;
};
