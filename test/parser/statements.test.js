'use strict';

var assert = require('assert');
var test = require('../harness').test;
var helper = require('./parse-helper');

var parse = helper.parse;

function body(decls, text, returnType) {
  return parse(decls + '\n' + (returnType || 'void') + ' fn(int x) {\n' + text + '\n}');
}

function errorsOf(decls, text) {
  return body(decls, text).errors;
}

function warningsOf(decls, text, returnType) {
  return body(decls, text, returnType).warnings;
}

function ok(decls, text) {
  var r = body(decls, text);
  assert.deepEqual(r.errors, [], text);
  assert.deepEqual(r.warnings, [], text);
  return r;
}

function kinds(r) {
  return r.dump.split('\n').map(function (l) { return l.trim().split(' ')[0]; })
    .filter(function (k) { return /Stmt$/.test(k); });
}

test('parses selection and iteration statements', function () {
  var r = ok('int f();', 'if (x) x = 1; else if (x > 2) x = 2; else {}\n' +
    'while (x) --x;\ndo x++; while (x < 3);\nfor (int i = 0, j = 1; i < j; ++i) x += i;\n' +
    'for (;;) break;\nswitch (x) { case 1: case 2: x = 0; break; default: ; }');
  assert.deepEqual(kinds(r), ['CompoundStmt', 'IfStmt', 'ExprStmt', 'IfStmt', 'ExprStmt',
    'CompoundStmt', 'WhileStmt', 'ExprStmt', 'DoStmt', 'ExprStmt', 'ForStmt', 'DeclStmt',
    'ExprStmt', 'ForStmt', 'BreakStmt', 'SwitchStmt', 'CompoundStmt', 'CaseStmt', 'CaseStmt',
    'ExprStmt', 'BreakStmt', 'DefaultStmt', 'NullStmt']);
});

test('scopes condition variables and substatements', function () {
  ok('int f();', 'if (int y = f()) x = y; else x = -y;');
  ok('int f();', 'while (int y = f()) x = y;');
  ok('int f();', 'for (int i = 0; int y = i; ) x = y;');
  ok('int f();', 'switch (int y = f()) { case 1: x = y; }');
  ok('', 'for (int i = 0; i < 2; ++i) {} for (int i = 0; i < 2; ++i) {}');
  ok('', 'if (x) int t = 1; else int t = 2;');
  assert.deepEqual(errorsOf('int f();', 'if (int y = f()) {} x = y;'),
    ['use of undeclared identifier \'y\'']);
  assert.deepEqual(errorsOf('int f();', 'if (int y = f()) { int y = 2; }'), []);
  assert.deepEqual(errorsOf('', 'for (int i = 0; ; ) { } i = 1;'),
    ['use of undeclared identifier \'i\'']);
});

test('converts conditions to bool', function () {
  var r = ok('int *p; double d;', 'if (p) {} while (d) {} for (; x; ) {}');
  assert.ok(/CastExpr 'bool' prvalue <PointerToBoolean>/.test(r.dump));
  assert.ok(/CastExpr 'bool' prvalue <FloatingToBoolean>/.test(r.dump));
  assert.ok(/CastExpr 'bool' prvalue <IntegralToBoolean>/.test(r.dump));
});

test('checks switch statements', function () {
  assert.deepEqual(errorsOf('', 'switch (1.5) {}'),
    ['statement requires expression of integer type (\'double\' invalid)']);
  assert.deepEqual(errorsOf('', 'switch (x) { case 1: case 1: ; }'),
    ['duplicate case value \'1\'']);
  assert.deepEqual(errorsOf('', 'switch (x) { case 1: case 2 - 1: ; }'),
    ['duplicate case value \'1\'']);
  assert.deepEqual(errorsOf('', 'switch (x) { default: default: ; }'),
    ['multiple default labels in one switch']);
  assert.deepEqual(errorsOf('', 'switch (x) { case x: ; }'),
    ['expression is not an integral constant expression']);
  assert.deepEqual(errorsOf('', 'case 1: ;'), ['\'case\' statement not in switch statement']);
  assert.deepEqual(errorsOf('', 'default: ;'),
    ['\'default\' statement not in switch statement']);
  ok('const int K = 3;', 'switch (x) { case K: case K + 1: case \'a\': ; }');
  ok('', 'switch (x) { case 1: { int v = 2; } case 2: ; }');
  ok('', 'switch (x) { case 1: int v; case 2: v = 1; }');
  assert.deepEqual(errorsOf('', 'switch (x) { case 1: int v = 2; case 2: ; }'),
    ['cannot jump from switch statement to this case label']);
});

test('checks break and continue', function () {
  assert.deepEqual(errorsOf('', 'break;'), ['\'break\' statement not in loop or switch ' +
    'statement']);
  assert.deepEqual(errorsOf('', 'continue;'), ['\'continue\' statement not in loop statement']);
  assert.deepEqual(errorsOf('', 'switch (x) { case 1: continue; }'),
    ['\'continue\' statement not in loop statement']);
  ok('', 'while (x) { switch (x) { case 1: continue; } break; }');
  var r = body('', 'while (x) { for (;;) { break; } continue; }');
  var loops = [];
  require('../../src/ast/nodes').walk(r.unit, function (n) {
    if (n.kind === 'WhileStmt' || n.kind === 'ForStmt') {
      loops.push(n);
    }
    if (n.kind === 'BreakStmt') {
      assert.strictEqual(n.target, loops[1]);
    }
    if (n.kind === 'ContinueStmt') {
      assert.strictEqual(n.target, loops[0]);
    }
  });
});

test('resolves goto and labels', function () {
  var r = ok('', 'again: if (x) goto done; x++; goto again; done: ;');
  var labels = {};
  require('../../src/ast/nodes').walk(r.unit, function (n) {
    if (n.kind === 'LabelStmt') {
      labels[n.name] = n;
    }
  });
  require('../../src/ast/nodes').walk(r.unit, function (n) {
    if (n.kind === 'GotoStmt') {
      assert.strictEqual(n.target, labels[n.label]);
    }
  });
  assert.deepEqual(errorsOf('', 'goto nowhere;'), ['use of undeclared label \'nowhere\'']);
  assert.deepEqual(errorsOf('', 'a: ; a: ;'), ['redefinition of label \'a\'']);
  assert.deepEqual(errorsOf('', '{ end: }'),
    ['label at end of compound statement: expected statement']);
  ok('', 'goto later; { later: ; }');
  ok('', 'goto skip; int plain; skip: plain = 1;');
  ok('', '{ int y = 1; goto out; } out: ;');
  ok('', 'int y = 1; back: y++; if (y < 3) goto back;');
});

test('rejects jumps that bypass initialization', function () {
  assert.deepEqual(errorsOf('', 'goto end; int z = 3; end: ;'),
    ['cannot jump from this goto statement to its label']);
  assert.deepEqual(errorsOf('', 'goto inside; { int z = 3; inside: ; }'),
    ['cannot jump from this goto statement to its label']);
  assert.deepEqual(errorsOf('', 'goto end; int &r = x; end: ;'),
    ['cannot jump from this goto statement to its label']);
  assert.deepEqual(body('', 'goto end; int z = 3; end: ;').bag.getAll()[0].notes[0].message,
    'jump bypasses variable initialization');
});

test('warns about suspicious statements', function () {
  assert.deepEqual(warningsOf('', 'if (x = 1) {}'),
    ['using the result of an assignment as a condition without parentheses']);
  assert.deepEqual(warningsOf('', 'if ((x = 1)) {}'), []);
  assert.deepEqual(warningsOf('', 'if (x);'), ['if statement has empty body']);
  assert.deepEqual(warningsOf('', 'if (x)\n  ;'), []);
  assert.deepEqual(warningsOf('', 'while (x);'), ['while loop has empty body']);
  assert.deepEqual(warningsOf('', 'for (;x;);'), ['for loop has empty body']);
});

test('checks that non-void functions return a value', function () {
  assert.deepEqual(warningsOf('', '', 'int'), ['non-void function does not return a value']);
  assert.deepEqual(warningsOf('', 'if (x) return 1;', 'int'),
    ['non-void function does not return a value in all control paths']);
  assert.deepEqual(warningsOf('', 'if (x) return 1; else return 2;', 'int'), []);
  assert.deepEqual(warningsOf('', 'for (;;) {}', 'int'), []);
  assert.deepEqual(warningsOf('', 'while (true) { if (x) return 1; }', 'int'), []);
  assert.deepEqual(warningsOf('', 'while (true) { if (x) break; }', 'int'),
    ['non-void function does not return a value']);
  assert.deepEqual(warningsOf('', 'do { return 1; } while (x);', 'int'), []);
  assert.deepEqual(parse('int main() { }').warnings, []);
});

test('reports statement syntax errors and recovers', function () {
  var r = body('', 'if x) {}\nwhile (x {}\nx = 1;\ndo x++ while (x);\nelse;\ngoto *x;');
  assert.deepEqual(r.errors, ['expected \'(\' after \'if\'', 'expected \')\'',
    'expected \';\' after expression', 'expected expression',
    'computed goto is a GNU extension and is not supported']);
});
