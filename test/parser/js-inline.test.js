'use strict';

var assert = require('assert');
var test = require('../harness').test;
var helper = require('./parse-helper');

function inMain(body) {
  return helper.parse('int main() {\n' + body + '\nreturn 0;\n}');
}

function ok(body) {
  var r = inMain(body);
  assert.deepEqual(r.errors, [], body);
  return r;
}

function errorsOf(body) {
  return inMain(body).errors;
}

function jsNodes(r) {
  var out = [];
  require('../../src/ast/nodes').walk(r.unit, function (n) {
    if (n.kind === 'JsStmt' || n.kind === 'JsExpr') {
      out.push(n);
    }
  });
  return out;
}

test('parses __js__ statements with operands', function () {
  var r = ok('int r = 0, a = 3, b = 4;\n__js__("%0 = Math.max(%1, %2);" : "=" (r) : (a), (b));\n' +
    '__js__("debugger;");\n__js__("console.log(%0 % 2, \'%%\');" : : (r));\n' +
    '__js__("%0 += 1" : "+" (r));');
  var nodes = jsNodes(r);
  assert.deepEqual(nodes[0].code, [0, ' = Math.max(', 1, ', ', 2, ');']);
  assert.equal(nodes[0].outputs.length, 1);
  assert.equal(nodes[0].inputs.length, 2);
  assert.deepEqual(nodes[1].code, ['debugger;']);
  assert.deepEqual(nodes[2].code, ['console.log(', 0, ' % 2, \'%\');']);
  assert.deepEqual(nodes[3].constraints, ['+']);
});

test('types __js__ expressions', function () {
  var r = ok('int a = 2;\ndouble t = __js__<double>("Date.now()");\n' +
    'int s = __js__<int>("%0 * 2" : (a));\n__js__<void>("alert(1)");');
  var nodes = jsNodes(r);
  assert.ok(/JsExpr 'double' prvalue "Date.now\(\)"/.test(r.dump));
  assert.deepEqual(nodes[1].code, [0, ' * 2']);
});

test('decodes UTF-8 code', function () {
  var r = ok('__js__("var s = \'\\u00e8\';");');
  assert.equal(jsNodes(r)[0].code[0], 'var s = \'\u00e8\';');
});

test('checks __js__ operands', function () {
  assert.deepEqual(errorsOf('int a;\n__js__("%3;" : : (a));'),
    ['invalid operand number %3 in inline JavaScript: operands are %0 to %0']);
  assert.deepEqual(errorsOf('__js__("%0");'),
    ['invalid operand number %0 in inline JavaScript: there are no operands']);
  assert.deepEqual(errorsOf('const int c = 1;\n__js__("%0 = 1" : "=" (c));'),
    ['cannot assign to variable \'c\' with const-qualified type \'const int\'']);
  assert.deepEqual(errorsOf('int a;\n__js__("%0 = 1" : "x" (a));'),
    ['output constraint must be \'=\' or \'+\'']);
  assert.deepEqual(errorsOf('__js__(u"x");'), ['inline JavaScript must be a narrow string literal']);
  assert.deepEqual(errorsOf('int bad = __js__("1");'),
    ['inline JavaScript used as an expression needs a result type: __js__<T>("...")']);
  assert.deepEqual(errorsOf('int x;\nint &r = __js__<int &>("x");'),
    ['result type of inline JavaScript cannot be a reference']);
  assert.deepEqual(errorsOf('__js__(x);'), ['expected a string literal with JavaScript code']);
});
