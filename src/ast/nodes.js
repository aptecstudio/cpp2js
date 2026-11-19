'use strict';

/**
 * AST node definitions and traversal (D-040).
 *
 * Nodes are plain objects `{kind, range, ...fields}`. Declarations are both
 * AST nodes and entries of the semantic scopes (D-035), as in Clang; every
 * expression gets `type` and `valueCategory` from semantic analysis.
 *
 * `NODE_KINDS` lists, for each kind, its fields: `children` are fields
 * holding a node or an array of nodes (visited by `walk`), `props` are
 * other data. `createNode` fills every listed field (null by default).
 *
 * `range` is `{source, start, end}`: the spelling range in the user's file
 * (outermost macro invocation for code coming from macros).
 */

var NODE_KINDS = {
  // Declarations -----------------------------------------------------------
  TranslationUnit: { children: ['decls'], props: ['source'] },
  NamespaceDecl: { children: ['decls'], props: ['name', 'isInline', 'parent', 'scope'] },
  NamespaceAliasDecl: { children: [], props: ['name', 'target'] },
  LinkageSpecDecl: { children: ['decls'], props: ['language', 'braced'] },
  UsingDirectiveDecl: { children: [], props: ['namespace'] },
  UsingDecl: { children: [], props: ['name', 'targets'] },
  TypedefDecl: { children: [], props: ['name', 'type', 'isAlias'] },
  VarDecl: {
    children: ['init'],
    props: ['name', 'type', 'storage', 'isConstexpr', 'isThreadLocal', 'linkage', 'parent',
      'initStyle']
  },
  ParamDecl: { children: ['defaultArg'], props: ['name', 'type', 'index'] },
  FunctionDecl: {
    children: ['params', 'body', 'ctorInits'],
    props: ['name', 'type', 'storage', 'isInline', 'isConstexpr', 'isDeleted',
      'isDefaulted', 'linkage', 'parent', 'previous', 'isMethod', 'isVirtual', 'isPure',
      'isOverride', 'isFinal', 'isExplicit', 'isStatic', 'access', 'methodKind',
      'jsModule']
  },
  CtorInitializer: { children: ['args'], props: ['member', 'base', 'isDelegating'] },
  FieldDecl: { children: ['init', 'bitWidth'], props: ['name', 'type', 'access', 'isMutable',
    'parent', 'index'] },
  RecordDecl: {
    children: ['bases', 'members'],
    props: ['tag', 'name', 'complete', 'size', 'align', 'parent', 'scope', 'isFinal',
      'isAbstract', 'isPolymorphic', 'previous', 'friends']
  },
  BaseSpecifier: { children: [], props: ['type', 'access', 'isVirtual'] },
  EnumDecl: {
    children: ['enumerators'],
    props: ['name', 'scoped', 'underlyingType', 'fixedUnderlying', 'complete', 'size',
      'parent', 'scope']
  },
  EnumeratorDecl: { children: ['init'], props: ['name', 'value', 'type', 'parent'] },
  StaticAssertDecl: { children: ['condition', 'message'], props: [] },
  FriendDecl: { children: [], props: ['target'] },
  EmptyDecl: { children: [], props: [] },

  // Statements -------------------------------------------------------------
  CompoundStmt: { children: ['stmts'], props: ['scope'] },
  DeclStmt: { children: ['decls'], props: [] },
  ExprStmt: { children: ['expr'], props: [] },
  NullStmt: { children: [], props: [] },
  IfStmt: { children: ['conditionVar', 'condition', 'then', 'otherwise'], props: [] },
  SwitchStmt: { children: ['conditionVar', 'condition', 'body'], props: ['cases'] },
  CaseStmt: { children: ['value', 'body'], props: ['constant'] },
  DefaultStmt: { children: ['body'], props: [] },
  WhileStmt: { children: ['conditionVar', 'condition', 'body'], props: [] },
  DoStmt: { children: ['body', 'condition'], props: [] },
  ForStmt: { children: ['init', 'conditionVar', 'condition', 'increment', 'body'],
    props: [] },
  RangeForStmt: { children: ['variable', 'rangeInit', 'body'], props: ['rangeKind'] },
  BreakStmt: { children: [], props: ['target'] },
  ContinueStmt: { children: [], props: ['target'] },
  ReturnStmt: { children: ['value'], props: [] },
  GotoStmt: { children: [], props: ['label', 'target'] },
  LabelStmt: { children: ['body'], props: ['name'] },
  JsStmt: { children: ['outputs', 'inputs'], props: ['code'] },

  // Expressions ------------------------------------------------------------
  IntegerLiteral: { children: [], props: ['value', 'type', 'valueCategory'] },
  FloatLiteral: { children: [], props: ['value', 'type', 'valueCategory'] },
  CharLiteral: { children: [], props: ['value', 'type', 'valueCategory'] },
  StringLiteral: { children: [], props: ['units', 'encoding', 'type', 'valueCategory'] },
  BoolLiteral: { children: [], props: ['value', 'type', 'valueCategory'] },
  NullptrLiteral: { children: [], props: ['type', 'valueCategory'] },
  ThisExpr: { children: [], props: ['isImplicit', 'type', 'valueCategory'] },
  DeclRefExpr: { children: [], props: ['decl', 'qualifier', 'candidates', 'type',
    'valueCategory'] },
  MemberExpr: { children: ['object'], props: ['member', 'isArrow', 'candidates', 'namingClass',
    'nameRange', 'type', 'valueCategory'] },
  CallExpr: { children: ['callee', 'args'], props: ['function', 'type', 'valueCategory'] },
  ConstructExpr: { children: ['args'], props: ['constructorDecl', 'type', 'valueCategory',
    'isListInit'] },
  NewExpr: { children: ['arraySize', 'args'], props: ['allocatedType', 'constructorDecl',
    'type', 'valueCategory', 'initStyle'] },
  DeleteExpr: { children: ['operand'], props: ['isArray', 'type', 'valueCategory'] },
  UnaryExpr: { children: ['operand'], props: ['operator', 'isPostfix', 'function',
    'candidates', 'type', 'valueCategory'] },
  BinaryExpr: { children: ['left', 'right'], props: ['operator', 'function', 'type',
    'valueCategory', 'computationType'] },
  ConditionalExpr: { children: ['condition', 'then', 'otherwise'], props: ['type',
    'valueCategory'] },
  CastExpr: { children: ['operand'], props: ['castKind', 'conversion', 'function', 'type',
    'valueCategory', 'written'] },
  SizeofExpr: { children: ['operand'], props: ['argumentType', 'isAlignof', 'value', 'type',
    'valueCategory'] },
  SubscriptExpr: { children: ['base', 'index'], props: ['function', 'type',
    'valueCategory'] },
  InitListExpr: { children: ['inits'], props: ['type', 'valueCategory'] },
  ParenExpr: { children: ['expr'], props: ['type', 'valueCategory'] },
  LambdaExpr: { children: ['captures', 'params', 'body'], props: ['captureDefault', 'isMutable',
    'returnType', 'closure', 'type', 'valueCategory'] },
  LambdaCapture: { children: ['init'], props: ['variable', 'byReference', 'isThis'] },
  DefaultArgExpr: { children: [], props: ['param', 'type', 'valueCategory'] },
  JsExpr: { children: ['inputs'], props: ['code', 'type', 'valueCategory'] }
};

/**
 * Creates a node, filling every field of its kind.
 *
 * @param {string} kind A key of NODE_KINDS.
 * @param {?{source: SourceFile, start: number, end: number}} range
 * @param {Object} [fields] Initial field values.
 * @returns {Object}
 * @throws {Error} If the kind or a field is unknown.
 */
function createNode(kind, range, fields) {
  var def = NODE_KINDS[kind];
  var node;
  var i;
  var key;
  if (!def) {
    throw new Error('Unknown node kind: ' + kind);
  }
  node = { kind: kind, range: range || null };
  for (i = 0; i < def.children.length; i++) {
    node[def.children[i]] = null;
  }
  for (i = 0; i < def.props.length; i++) {
    node[def.props[i]] = null;
  }
  if (fields) {
    for (key in fields) {
      if (fields.hasOwnProperty(key)) {
        if (!node.hasOwnProperty(key)) {
          throw new Error('Unknown field "' + key + '" for node kind ' + kind);
        }
        node[key] = fields[key];
      }
    }
  }
  return node;
}

/**
 * Returns the child nodes of a node, in field order.
 *
 * @param {Object} node
 * @returns {Array.<Object>}
 */
function childrenOf(node) {
  var def = NODE_KINDS[node.kind];
  var out = [];
  var i;
  var value;
  for (i = 0; i < def.children.length; i++) {
    value = node[def.children[i]];
    if (value === null || value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      out = out.concat(value.filter(function (child) { return child !== null; }));
    } else {
      out.push(value);
    }
  }
  return out;
}

/**
 * Depth-first traversal. `enter` may return false to skip a node's
 * children; `leave` is called after the children.
 *
 * @param {Object} node
 * @param {function(Object, ?Object): (boolean|undefined)} enter Called with
 *   (node, parent).
 * @param {function(Object, ?Object)} [leave]
 * @returns {void}
 */
function walk(node, enter, leave) {
  function visit(current, parent) {
    var children;
    var i;
    if (enter(current, parent) !== false) {
      children = childrenOf(current);
      for (i = 0; i < children.length; i++) {
        visit(children[i], current);
      }
    }
    if (leave) {
      leave(current, parent);
    }
  }
  visit(node, null);
}

/**
 * Whether a node kind is an expression (it has a `type` and a
 * `valueCategory`).
 *
 * @param {string} kind
 * @returns {boolean}
 */
function isExpression(kind) {
  var def = NODE_KINDS[kind];
  return !!def && def.props.indexOf('valueCategory') !== -1;
}

module.exports = {
  NODE_KINDS: NODE_KINDS,
  createNode: createNode,
  childrenOf: childrenOf,
  walk: walk,
  isExpression: isExpression
};
