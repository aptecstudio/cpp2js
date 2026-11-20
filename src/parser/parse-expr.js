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
var T = require('../semantic/types');

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
  var dots;
  do {
    dots = this._findExpansionEnd(false);
    if (dots >= 0) {
      // `f(args...)`, `g(h(args)...)`: one argument per pack element.
      list = list.concat(this._expand(dots, function () {
        return this.isPunct('{') ? this.parseBracedInitList() :
          this.parseAssignmentExpression();
      }));
      continue;
    }
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
    // Inside a template argument list `>` and `>>` close it (14.2/3).
    if (this._templateArgDepth && (tok.value === '>' || tok.value === '>>')) {
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
      tok.value === 'volatile' || tok.value === 'auto' || tok.value === 'enum' ||
      tok.value === 'decltype' || tok.value === 'typename' ||
      tok.value === 'class' || tok.value === 'struct' || tok.value === 'union');
  }
  if (tok.kind === TokenKind.IDENTIFIER || (tok.kind === TokenKind.PUNCT && tok.value === '::')) {
    scan = this._scanQualifiedName(offset);
    return !!scan && !scan.error && (scan.info.kind === 'type' || scan.info.kind === 'error');
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
  if (this.acceptPunct('...')) {
    open = this.expectPunct('(', 'after \'sizeof...\'');
    if (this.peek().kind !== TokenKind.IDENTIFIER) {
      this.fail('expected the name of a parameter pack');
    }
    type = this.next();
    this.expectPunct(')', '', open);
    return this.sema.actOnSizeofPack(type.value, this.rangeFrom(keyword));
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
  var name;
  var savedDepth;
  var disambiguated;
  var explicit;
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
        savedDepth = this._templateArgDepth;
        this._templateArgDepth = 0;
        try {
          args = this.isPunct(')') ? [] : this.parseExpressionList();
        } finally {
          this._templateArgDepth = savedDepth;
        }
        this.expectPunct(')', '', open);
        expr = this.sema.actOnCall(expr, args, this.rangeFrom(start));
        break;
      case '.':
      case '->':
        this.next();
        // `obj.template f<T>()` (14.2/4).
        disambiguated = !!this.acceptKeyword('template');
        name = this.peek();
        if (name.kind !== TokenKind.IDENTIFIER) {
          this.fail(name.kind === TokenKind.PUNCT && name.value === '~' ?
            'destructors are not supported yet' : 'expected unqualified-id');
        }
        this.next();
        expr = this.sema.actOnMemberAccess(expr, name.value, tok.value === '->',
          this.rangeFrom(start), this.rangeOf(name));
        if (expr && this.isPunct('<') && expr.templateCandidates &&
            expr.templateCandidates.length) {
          // `obj.f<int>(x)`: explicit template arguments of a member template.
          explicit = this.parseTemplateArguments(expr.templateCandidates[0]);
          if (explicit) {
            expr.explicitTemplateArgs = explicit;
          }
        } else if (expr && disambiguated && !(expr.templateCandidates &&
            expr.templateCandidates.length)) {
          this.fail('\'' + name.value + '\' following the \'template\' keyword does not ' +
            'refer to a template', name);
        }
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
  var expr = this.sema.actOnIdExpression(name.name, this.rangeFrom(first), name.qualifier);
  var explicit;
  if (expr && this.isPunct('<') && expr.templateCandidates && expr.templateCandidates.length) {
    // `N::f<int>(x)`, `S::make<T>()`: explicit template arguments.
    explicit = this.parseTemplateArguments(expr.templateCandidates[0]);
    if (explicit) {
      expr.explicitTemplateArgs = explicit;
    }
  }
  return expr;
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
    if (T.isRecord(type)) {
      return this.sema.construct(type.unqualified, args.inits, 'list', range);
    }
    if (!args.inits.length) {
      return this.sema.actOnValueInit(type, range);
    }
    return this.sema._scalarListInit(args, type);
  }
  open = this.expectPunct('(', 'for function-style cast or type construction');
  args = this.isPunct(')') ? [] : this.parseExpressionList();
  this.expectPunct(')', '', open);
  range = this.rangeFrom(start);
  if (T.isRecord(type)) {
    return this.sema.construct(type.unqualified, args, 'direct', range);
  }
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
  var savedDepth;
  var info;
  var explicit;
  var expr;
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
      info = this.sema.classifyName(tok.value);
      if (info.kind === 'template' && info.decls[0].templateKind === 'function' &&
          this.isPunct('<', 1)) {
        // `f<int>(x)`: explicit template arguments.
        this.next();
        explicit = this.parseTemplateArguments(info.decls[0]);
        expr = this.sema.actOnIdExpression(tok.value, this.rangeFrom(tok));
        if (expr && explicit) {
          expr.explicitTemplateArgs = explicit;
        }
        return expr;
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
        this.next();
        return this.sema.actOnThis(this.rangeOf(tok), false);
      }
      if (tok.value === '__js__') {
        return this.parseJsExpression();
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
        // Parentheses make `>` an operator again inside template arguments.
        savedDepth = this._templateArgDepth;
        this._templateArgDepth = 0;
        try {
          inner = this.parseExpression();
        } finally {
          this._templateArgDepth = savedDepth;
        }
        this.expectPunct(')', '', tok);
        return this.sema.actOnParenExpr(inner, this.rangeFrom(tok));
      }
      if (tok.value === '[') {
        return this.parseLambdaExpression();
      }
      break;
  }
  this.fail('expected expression');
  return null;
};

/**
 * lambda-expression (C++11 5.1.2):
 * `[captures] (params) mutable noexcept -> R { body }`.
 */
Parser.prototype.parseLambdaExpression = function () {
  var open = this.next();
  var intro = { captureDefault: null, captures: [] };
  var suffix;
  var info;
  var body = null;
  var savedBreakables;
  var tok;
  var byReference;
  if ((this.isPunct('=') || this.isPunct('&')) && (this.isPunct(',', 1) ||
      this.isPunct(']', 1))) {
    intro.captureDefault = this.next().value;
    this.acceptPunct(',');
  }
  while (!this.isPunct(']')) {
    tok = this.peek();
    byReference = !!this.acceptPunct('&');
    if (this.acceptKeyword('this')) {
      intro.captures.push({ isThis: true, range: this.rangeOf(tok) });
    } else if (this.peek().kind === TokenKind.IDENTIFIER) {
      intro.captures.push({ name: this.next().value, byReference: byReference,
        range: this.rangeFrom(tok) });
    } else {
      this.fail('expected variable name or \'this\' in lambda capture list');
    }
    if (!this.acceptPunct(',')) {
      break;
    }
  }
  this.expectPunct(']', '', open);
  if (this.isPunct('(')) {
    suffix = this.parseFunctionSuffix(true);
  } else {
    suffix = { kind: 'function', params: [], variadic: false, isConst: false,
      isVolatile: false, refQualifier: '', trailingReturn: null, range: this.rangeOf(open) };
    if (this.isKeyword('mutable') || this.isPunct('->')) {
      this.fail('lambda requires \'()\' before \'' + this.peek().value + '\'');
    }
  }
  if (!this.isPunct('{')) {
    this.fail('expected body of lambda expression');
  }
  info = this.sema.actOnStartLambda(intro, suffix, this.rangeOf(open));
  // break and continue cannot leave a lambda body.
  savedBreakables = this.sema._breakableStack;
  this.sema._breakableStack = [];
  try {
    body = this.parseCompoundStatement(false);
  } finally {
    this.sema._breakableStack = savedBreakables;
  }
  return this.sema.actOnFinishLambda(info, body, this.rangeFrom(open));
};

/** `__js__ < type-id > ( "expression" [: inputs] )` (D-026) */
Parser.prototype.parseJsExpression = function () {
  var keyword = this.next();
  var type;
  var open;
  var literal;
  var inputs = [];
  if (!this.isPunct('<')) {
    this.fail(this.isPunct('(') ? 'inline JavaScript used as an expression needs a result ' +
      'type: __js__<T>("...")' : 'expected \'<\' after \'__js__\'');
  }
  this.next();
  type = this.parseTypeId();
  this.expectPunct('>');
  open = this.expectPunct('(');
  literal = this._jsCodeLiteral();
  if (this.acceptPunct(':')) {
    inputs = this._jsOperands(false);
  }
  this.expectPunct(')', '', open);
  return this.sema.actOnJsExpression(type, literal, inputs.map(function (i) {
    return i.expr;
  }), this.rangeFrom(keyword));
};

