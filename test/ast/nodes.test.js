'use strict';

var assert = require('assert');
var test = require('../harness').test;
var ast = require('../../src/ast/nodes');

test('creates nodes with every field', function () {
  var node = ast.createNode('ReturnStmt', null, {});
  assert.equal(node.kind, 'ReturnStmt');
  assert.equal(node.value, null);
  assert.equal(node.range, null);
  node = ast.createNode('BinaryExpr', { source: null, start: 1, end: 4 }, { operator: '+' });
  assert.equal(node.operator, '+');
  assert.equal(node.type, null);
  assert.equal(node.range.start, 1);
});

test('rejects unknown kinds and fields', function () {
  assert.throws(function () { ast.createNode('Bogus', null); }, /Unknown node kind/);
  assert.throws(function () { ast.createNode('ReturnStmt', null, { bogus: 1 }); },
    /Unknown field "bogus"/);
});

test('node definitions are consistent', function () {
  var kind;
  var def;
  var seen;
  var i;
  for (kind in ast.NODE_KINDS) {
    if (ast.NODE_KINDS.hasOwnProperty(kind)) {
      def = ast.NODE_KINDS[kind];
      seen = Object.create(null);
      for (i = 0; i < def.children.length + def.props.length; i++) {
        var field = i < def.children.length ? def.children[i] :
          def.props[i - def.children.length];
        assert.ok(!seen[field], kind + ': duplicate field ' + field);
        assert.ok(field !== 'kind' && field !== 'range', kind + ': reserved field ' + field);
        seen[field] = true;
      }
      if (/Expr$|Literal$/.test(kind) && kind !== 'LambdaCapture') {
        assert.ok(ast.isExpression(kind), kind + ' should be an expression');
      }
    }
  }
});

test('walks children in order and honours skipping', function () {
  var one = ast.createNode('IntegerLiteral', null, { value: 1 });
  var two = ast.createNode('IntegerLiteral', null, { value: 2 });
  var three = ast.createNode('IntegerLiteral', null, { value: 3 });
  var sum = ast.createNode('BinaryExpr', null, { operator: '+', left: one, right: two });
  var stmt = ast.createNode('CompoundStmt', null, { stmts: [
    ast.createNode('ExprStmt', null, { expr: sum }),
    ast.createNode('ReturnStmt', null, { value: three })
  ] });
  var entered = [];
  var left = [];
  ast.walk(stmt, function (node, parent) {
    entered.push(node.kind + (node.kind === 'IntegerLiteral' ? node.value : '') +
      (parent ? '<' + parent.kind : ''));
  }, function (node) {
    left.push(node.kind);
  });
  assert.deepEqual(entered, ['CompoundStmt', 'ExprStmt<CompoundStmt', 'BinaryExpr<ExprStmt',
    'IntegerLiteral1<BinaryExpr', 'IntegerLiteral2<BinaryExpr', 'ReturnStmt<CompoundStmt',
    'IntegerLiteral3<ReturnStmt']);
  assert.equal(left[left.length - 1], 'CompoundStmt');
  entered = [];
  ast.walk(stmt, function (node) {
    entered.push(node.kind);
    return node.kind !== 'ExprStmt';
  });
  assert.deepEqual(entered, ['CompoundStmt', 'ExprStmt', 'ReturnStmt', 'IntegerLiteral']);
});
