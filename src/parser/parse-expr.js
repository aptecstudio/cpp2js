'use strict';

/**
 * Expression parsing (extends Parser.prototype), C++11 clause 5, D-047.
 *
 * Precedence climbing over the binary operators, with the C++
 * disambiguations that depend on names: `(T)e` is a cast only if `T` names
 * a type, `sizeof(x)` takes a type-id when `x` is a type, and
 * `T(args)` / `T{args}` with a type `T` is a functional cast.
 */

var Parser = require('./parser').Parser;
var TokenKind = require('../lexer/lexer').TokenKind;

/** Binary operators by precedence, lowest first (C++11 5.6-5.15). */
var BINARY_LEVELS = [
  ['||'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='], ['<', '>', '<=', '>='], ['<<', '>>'],
  ['+', '-'], ['*', '/', '%']
];

var ASSIGNMENT_OPS = { '=': true, '*=': true, '/=': true, '%=': true, '+=': true, '-=': true,
  '>>=': true, '<<=': true, '&=': true, '^=': true, '|=': true };

var CAST_KEYWORDS = { 'static_cast': 'static', 'const_cast': 'const',
  'reinterpret_cast': 'reinterpret', 'dynamic_cast': 'dynamic' };

var SIMPLE_TYPE_KEYWORDS = { 'void': true, 'bool': true, 'char': true, 'char16_t': true,
  'char32_t': true, 'wchar_t': true, 'short': true, 'int': true, 'long': true, 'signed': true,
  'unsigned': true, 'float': true, 'double': true };

/** expression: assignment-expressions separated by commas. */
Parser.prototype.parseExpression = function () {
  var left = this.parseAssignmentExpression();
  var op;
  var right;
  while (this.isPunct(',')) {
    op = this.next();
    right = this.parseAssignmentExpression();
    left = this.sema.actOnBinaryOperator(',', left, right, this._span(left, right, op));
  }
  return left;
};

/** assignment-expression (C++11 5.17). */
Parser.prototype.parseAssignmentExpression = function () {
  var start = this.peek();
  var left;
  var op;
  var right;
  if (this.isKeyword('throw')) {
    this.fail('exceptions are not supported yet');
  }
  left = this.parseConditionalExpression();
  if (this.peek().kind === TokenKind.PUNCT && ASSIGNMENT_OPS[this.peek().value]) {
    op = this.next();
    right = this.isPunct('{') ? this.parseBracedInitList() : this.parseAssignmentExpression();
    return this.sema.actOnBinaryOperator(op.value, left, right, this.rangeFrom(start));
  }
  return left;
};

/** constant-expression: a conditional-expression (C++11 5.19). */
Parser.prototype.parseConstantExpression = function () {
  return this.parseConditionalExpression();
};

/** expression-list: initializer-clauses separated by commas. */
Parser.prototype.parseExpressionList = function () {
  var list = [];
  do {
    list.push(this.isPunct('{') ? this.parseBracedInitList() : this.parseAssignmentExpression());
  } while (this.acceptPunct(','));
  return list;
};

Parser.prototype.parseConditionalExpression = function () {
  var start = this.peek();
  var condition = this.parseBinaryExpression(0);
  var question;
  var then;
  var otherwise;
  if (!this.isPunct('?')) {
    return condition;
  }
  question = this.next();
  then = this.parseExpression();
  this.expectPunct(':', '', question);
  otherwise = this.parseAssignmentExpression();
  return this.sema.actOnConditional(condition, then, otherwise, this.rangeFrom(start));
};

Parser.prototype.parseBinaryExpression = function (level) {
  var start = this.peek();
  var left;
  var tok;
  var right;
  if (level >= BINARY_LEVELS.length) {
    return this.parseCastExpression();
  }
  left = this.parseBinaryExpression(level + 1);
  for (;;) {
    tok = this.peek();
    if (tok.kind !== TokenKind.PUNCT || BINARY_LEVELS[level].indexOf(tok.value) === -1) {
      return left;
    }
    this.next();
    right = this.parseBinaryExpression(level + 1);
    left = this.sema.actOnBinaryOperator(tok.value, left, right, this.rangeFrom(start));
  }
};

/** Range covering two expressions. */
Parser.prototype._span = function (left, right, fallback) {
  if (left && right && left.range && right.range && left.range.source === right.range.source) {
    return { source: left.range.source, start: left.range.start, end: right.range.end };
  }
  return this.rangeOf(fallback);
};

/**
 * Whether a type-id starts at `offset`: a type specifier (builtin type,
 * cv-qualifier, `auto`) or a name that denotes a type.
 */
Parser.prototype.startsTypeId = function (offset) {
  var tok = this.peek(offset);
  var scan;
  if (tok.kind === TokenKind.KEYWORD) {
    return !!(SIMPLE_TYPE_KEYWORDS[tok.value] || tok.value === 'const' ||
      tok.value === 'volatile' || tok.value === 'auto' || tok.value === 'enum');
  }
  if (tok.kind === TokenKind.IDENTIFIER || (tok.kind === TokenKind.PUNCT && tok.value === '::')) {
    scan = this._scanQualifiedName(offset);
    return !!scan && !scan.error && scan.info.kind === 'type';
  }
  return false;
};

/** cast-expression: `( type-id ) cast-expression` or a unary expression. */
Parser.prototype.parseCastExpression = function () {
  var open;
  var type;
  var operand;
  if (this.isPunct('(') && this.startsTypeId(1)) {
    open = this.next();
    type = this.parseTypeId();
    this.expectPunct(')', '', open);
    if (this.isPunct('{')) {
      this.fail('compound literals are not supported in C++');
    }
    operand = this.parseCastExpression();
    return this.sema.actOnCast('c-style', type, operand, this.rangeFrom(open));
  }
  return this.parseUnaryExpression();
};

Parser.prototype.parseUnaryExpression = function () {
  var tok = this.peek();
  var operand;
  if (tok.kind === TokenKind.PUNCT) {
    switch (tok.value) {
      case '++':
      case '--':
      case '*':
      case '&':
      case '+':
      case '-':
      case '!':
      case '~':
        this.next();
        operand = this.parseCastExpression();
        return this.sema.actOnUnaryOperator(tok.value, operand, this.rangeFrom(tok));
      case '::':
        if (this.isKeyword('new', 1) || this.isKeyword('delete', 1)) {
          this.next();
          return this.parseUnaryExpression();
        }
        break;
    }
  }
  if (tok.kind === TokenKind.KEYWORD) {
    switch (tok.value) {
      case 'sizeof':
      case 'alignof':
        return this.parseSizeof();
      case 'noexcept':
        return this.parseNoexceptExpression();
      case 'new':
        return this.parseNewExpression();
      case 'delete':
        return this.parseDeleteExpression();
    }
  }
  return this.parsePostfixExpression();
};

/** `sizeof unary-expression`, `sizeof ( type-id )`, `alignof ( type-id )`. */
Parser.prototype.parseSizeof = function () {
  var keyword = this.next();
  var isAlignof = keyword.value === 'alignof';
  var open;
  var type;
  var operand;
  if (this.isPunct('...')) {
    this.fail('\'sizeof...\' requires variadic templates, which are not supported yet');
  }
  if (this.isPunct('(') && this.startsTypeId(1)) {
    open = this.next();
    type = this.parseTypeId();
    this.expectPunct(')', '', open);
    return this.sema.actOnSizeof(type, null, isAlignof, this.rangeFrom(keyword));
  }
  if (isAlignof) {
    this.fail('expected \'(\' and a type after \'alignof\'');
  }
  operand = this.parseUnaryExpression();
  return this.sema.actOnSizeof(null, operand, false, this.rangeFrom(keyword));
};

/** `noexcept ( expression )`: true unless the operand may throw. */
Parser.prototype.parseNoexceptExpression = function () {
  var keyword = this.next();
  var open = this.expectPunct('(');
  this.parseExpression();
  this.expectPunct(')', '', open);
  // Exceptions are not supported yet, so no expression can throw.
  return this.sema.actOnBoolLiteral(true, this.rangeFrom(keyword));
};

/**
 * new-expression (C++11 5.3.4) without placement: `new T`, `new T(args)`,
 * `new T{args}`, `new T[n]`, `new T[n][3]`, `new (T)`.
 */
Parser.prototype.parseNewExpression = function () {
  var keyword = this.next();
  var open;
  var type;
  var spec;
  var arraySize = null;
  var dims = [];
  var dim;
  var args = null;
  var style = null;
  var qualifier;
  var i;
  if (this.isPunct('(') && !this.startsTypeId(1)) {
    this.fail('placement new is not supported');
  }
  if (this.isPunct('(')) {
    open = this.next();
    type = this.parseTypeId();
    this.expectPunct(')', '', open);
  } else {
    spec = this.parseDeclSpecifiers();
    type = this.sema.typeFromSpecifiers(spec) || this.sema.types.builtin('int');
    while (this.isPunct('*')) {
      this.next();
      type = this.sema.types.pointer(type);
      while (this.isKeyword('const') || this.isKeyword('volatile')) {
        qualifier = this.next().value;
        type = this.sema.types.addQualifiers(type, qualifier === 'const',
          qualifier === 'volatile');
      }
    }
    while (this.isPunct('[')) {
      open = this.next();
      dim = dims.length === 0 ? this.parseExpression() : this.parseConstantExpression();
      this.expectPunct(']', '', open);
      dims.push(dim);
    }
    if (dims.length) {
      arraySize = dims[0];
      for (i = dims.length - 1; i >= 1; i--) {
        type = this.sema.types.array(type, this.sema.evaluateArraySize(dims[i]));
      }
    }
  }
  if (this.isPunct('(')) {
    open = this.next();
    args = this.isPunct(')') ? [] : this.parseExpressionList();
    this.expectPunct(')', '', open);
    style = 'direct';
  } else if (this.isPunct('{')) {
    args = this.parseBracedInitList().inits;
    style = 'list';
  }
  return this.sema.actOnNew(type, arraySize, args, style, this.rangeFrom(keyword));
};

/** `delete cast-expression`, `delete [] cast-expression`. */
Parser.prototype.parseDeleteExpression = function () {
  var keyword = this.next();
  var isArray = false;
  var operand;
  if (this.isPunct('[') && this.isPunct(']', 1)) {
    this.next();
    this.next();
    isArray = true;
  }
  operand = this.parseCastExpression();
  return this.sema.actOnDelete(operand, isArray, this.rangeFrom(keyword));
};

Parser.prototype.parsePostfixExpression = function () {
  var start = this.peek();
  var expr = this.parsePrimaryExpression();
  var tok;
  var open;
  var args;
  var index;
  for (;;) {
    tok = this.peek();
    if (tok.kind !== TokenKind.PUNCT) {
      return expr;
    }
    switch (tok.value) {
      case '[':
        open = this.next();
        index = this.isPunct('{') ? this.parseBracedInitList() : this.parseExpression();
        this.expectPunct(']', '', open);
        expr = this.sema.actOnSubscript(expr, index, this.rangeFrom(start));
        break;
      case '(':
        open = this.next();
        args = this.isPunct(')') ? [] : this.parseExpressionList();
        this.expectPunct(')', '', open);
        expr = this.sema.actOnCall(expr, args, this.rangeFrom(start));
        break;
      case '.':
      case '->':
        this.next();
        this.fail('member access requires classes, which are not supported yet');
        break;
      case '++':
      case '--':
        this.next();
        expr = this.sema.actOnPostfixIncDec(tok.value, expr, this.rangeFrom(start));
        break;
      default:
        return expr;
    }
    if (!expr) {
      // An error was reported: skip the rest of the postfix chain.
      this._skipPostfix();
      return null;
    }
  }
};

/** Skips postfix operators after an erroneous operand. */
Parser.prototype._skipPostfix = function () {
  var open;
  for (;;) {
    if (this.isPunct('(') || this.isPunct('[')) {
      open = this.next();
      this._skipBalanced();
    } else if (this.isPunct('++') || this.isPunct('--')) {
      this.next();
    } else {
      return;
    }
  }
};

/** Skips to the matching closing bracket (consumed). */
Parser.prototype._skipBalanced = function () {
  var depth = 1;
  var tok;
  while (depth > 0 && this.peek().kind !== TokenKind.EOF) {
    tok = this.next();
    if (tok.kind === TokenKind.PUNCT) {
      if (tok.value === '(' || tok.value === '[' || tok.value === '{') {
        depth++;
      } else if (tok.value === ')' || tok.value === ']' || tok.value === '}') {
        depth--;
      }
    }
  }
};

/** `ns::name`, `::name` as an expression. */
Parser.prototype.parseQualifiedIdExpression = function () {
  var first = this.peek();
  var name = this.parseQualifiedName();
  return this.sema.actOnIdExpression(name.name, this.rangeFrom(first), name.qualifier);
};

/**
 * `T(args)` and `T{args}` for a simple type specifier or type name `T`
 * (C++11 5.2.3).
 */
Parser.prototype.parseFunctionalCast = function () {
  var start = this.peek();
  var spec = this.parseDeclSpecifiers();
  var type = this.sema.typeFromSpecifiers(spec) || this.sema.types.builtin('int');
  var open;
  var args;
  var range;
  if (this.isPunct('{')) {
    args = this.parseBracedInitList();
    range = this.rangeFrom(start);
    if (!args.inits.length) {
      return this.sema.actOnValueInit(type, range);
    }
    return this.sema._scalarListInit(args, type);
  }
  open = this.expectPunct('(', 'for function-style cast or type construction');
  args = this.isPunct(')') ? [] : this.parseExpressionList();
  this.expectPunct(')', '', open);
  range = this.rangeFrom(start);
  if (!args.length) {
    return this.sema.actOnValueInit(type, range);
  }
  if (args.length > 1) {
    this.diagnostics.error('excess elements in scalar initializer', args[1].range);
    return null;
  }
  return this.sema.actOnCast('functional', type, args[0], range);
};

/** `static_cast<T>(e)` and the other named casts. */
Parser.prototype.parseNamedCast = function () {
  var keyword = this.next();
  var open;
  var type;
  var operand;
  this.expectPunct('<', 'after \'' + keyword.value + '\'');
  type = this.parseTypeId();
  if (this.isPunct('>>')) {
    this.fail('expected \'>\'');
  }
  this.expectPunct('>');
  open = this.expectPunct('(');
  operand = this.parseExpression();
  this.expectPunct(')', '', open);
  return this.sema.actOnCast(CAST_KEYWORDS[keyword.value], type, operand,
    this.rangeFrom(keyword));
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
      if (this.startsTypeId(0)) {
        return this.parseFunctionalCast();
      }
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
      if (CAST_KEYWORDS[tok.value]) {
        return this.parseNamedCast();
      }
      if (SIMPLE_TYPE_KEYWORDS[tok.value]) {
        return this.parseFunctionalCast();
      }
      if (tok.value === 'this') {
        this.fail('invalid use of \'this\' outside of a non-static member function');
      }
      break;
    case TokenKind.PUNCT:
      if (tok.value === '::') {
        if (this.startsTypeId(0)) {
          return this.parseFunctionalCast();
        }
        return this.parseQualifiedIdExpression();
      }
      if (tok.value === '(') {
        this.next();
        inner = this.parseExpression();
        this.expectPunct(')', '', tok);
        return this.sema.actOnParenExpr(inner, this.rangeFrom(tok));
      }
      if (tok.value === '[') {
        this.fail('lambda expressions are not supported yet');
      }
      break;
  }
  this.fail('expected expression');
  return null;
};
