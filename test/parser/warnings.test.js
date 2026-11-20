'use strict';

var assert = require('assert');
var test = require('../harness').test;
var helper = require('./parse-helper');

var parse = helper.parse;

function warningsOf(source) {
  var r = parse(source);
  assert.deepEqual(r.errors, [], source);
  return r.warnings;
}

test('warns about shift counts and constant overflow', function () {
  assert.deepEqual(warningsOf('int a = 1 << 33; int b = 1 >> -1; int c = 1 << 31;'),
    ['shift count >= width of type', 'shift count is negative']);
  assert.deepEqual(warningsOf('int t = 2147483647 + 1; int u = 65536 * 65536;\n' +
    'unsigned v = 4294967295u + 1u; long long w = 9223372036854775807LL + 1;'), [
    'overflow in expression; result is -2147483648 with type \'int\'',
    'overflow in expression; result is 0 with type \'int\'',
    'overflow in expression; result is -9223372036854775808 with type \'long long\'']);
});

test('warns about constant indexes out of bounds', function () {
  var r = parse('void f() { int a[3]; a[3] = 1; a[-1] = 2; int *e = &a[3]; a[2] = 0; }');
  assert.deepEqual(r.warnings, [
    'array index 3 is past the end of the array (that has type \'int [3]\')',
    'array index -1 is before the beginning of the array']);
  assert.equal(r.bag.getAll()[0].notes[0].message, 'array \'a\' declared here');
});

test('warns about returning addresses of locals', function () {
  assert.deepEqual(warningsOf('int *f(int p) { int x = 0; if (p) return &x; return &p; }\n' +
    'int &g() { int y = 0; return y; }\nint *h() { int a[2]; return a; }\n' +
    'int *k() { static int s; return &s; }\nint &m(int &r) { return r; }'), [
    'address of stack memory associated with local variable \'x\' returned',
    'address of stack memory associated with parameter \'p\' returned',
    'reference to stack memory associated with local variable \'y\' returned',
    'address of stack memory associated with local variable \'a\' returned']);
});

test('warns about unused comparisons and string plus int', function () {
  assert.deepEqual(warningsOf('void f(int x) { x == 1; x != 2; x < 3; x = 4; }'), [
    'equality comparison result unused', 'equality comparison result unused',
    'relational comparison result unused']);
  assert.deepEqual(warningsOf('const char *f(int n) { const char *a = "abc" + 1; ' +
    'return "abc" + n; }'), ['adding \'int\' to a string does not append to the string']);
});

test('warns about enumeration values not handled in a switch', function () {
  assert.deepEqual(warningsOf('enum E { a, b, c, d, e };\nenum class F { x, y };\n' +
    'void f(E v, F w) {\n  switch (v) { case a: case b: case c: case d: break; }\n' +
    '  switch (v) { case a: case b: case c: break; }\n  switch (v) { case a: case b: break; }\n' +
    '  switch (v) { case a: break; }\n  switch (v) { case a: break; default: break; }\n' +
    '  switch (w) { case F::x: break; }\n}'), [
    'enumeration value \'e\' not handled in switch',
    'enumeration values \'d\' and \'e\' not handled in switch',
    'enumeration values \'c\', \'d\', and \'e\' not handled in switch',
    '4 enumeration values not handled in switch: \'b\', \'c\', \'d\'...',
    'enumeration value \'y\' not handled in switch']);
});

test('warns about uninitialized local variables in simple cases', function () {
  var r = parse('int f() { int u; return u; }');
  assert.deepEqual(r.warnings, ['variable \'u\' is uninitialized when used here']);
  assert.equal(r.bag.getAll()[0].notes[0].message,
    'initialize the variable \'u\' to silence this warning');
  assert.deepEqual(warningsOf('void g(int *);\nint f(int k) {\n  int a; if (k) a = 1; ' +
    'int b; g(&b); int c; int &r = c; int d; d = 2;\n  int e; for (int i = 0; i < 2; i++) ' +
    '{ if (i) return e; e = 1; }\n  return a + b + c + d + r;\n}'), []);
});
