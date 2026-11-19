'use strict';

var assert = require('assert');
var test = require('../harness').test;
var helper = require('./parse-helper');

var parse = helper.parse;

function ok(source) {
  var r = parse(source);
  assert.deepEqual(r.errors, [], source);
  return r;
}

function errorsOf(source) {
  return parse(source).errors;
}

test('friend classes and functions may access private members', function () {
  ok('class Box { int secret; friend class Inspector; friend int peek(const Box &b); };\n' +
    'struct Inspector { int look(Box b) { return b.secret; } };\n' +
    'int peek(const Box &b) { return b.secret; }');
  ok('class Box { int secret;\n  friend int peek(const Box &b) { return b.secret; }\n};\n' +
    'int use(Box b) { return peek(b); }');
  ok('class Base { int p; friend void f(); };\nclass D : public Base {};\n' +
    'void f() { Base b; b.p = 1; }');
  assert.deepEqual(errorsOf('class Box { int secret; };\nint peek(Box b) { return b.secret; }'),
    ['\'secret\' is a private member of \'Box\'']);
  assert.deepEqual(errorsOf('class Box { int secret; friend class A; };\n' +
    'struct B { int f(Box b) { return b.secret; } };'),
    ['\'secret\' is a private member of \'Box\'']);
  assert.deepEqual(errorsOf('struct S { friend int x; };'),
    ['friends can only be classes or functions']);
});

test('declares and defines static data members', function () {
  var r = ok('struct Counter { static int count; static const int max = 8; ' +
    'static constexpr long big = 1L << 20; int slots[max]; };\nint Counter::count = 0;\n' +
    'int f() { Counter c; return Counter::count + c.count + Counter::max; }');
  assert.ok(/RecordDecl struct Counter size=32 align=4/.test(r.dump));
  assert.ok(/VarDecl count 'int' redecl copy-init/.test(r.dump));
  assert.deepEqual(errorsOf('struct S { static int v = 1; };'),
    ['non-const static data member must be initialized out of line']);
  assert.deepEqual(errorsOf('struct S { static int v; };\nint S::w = 1;'),
    ['out-of-line definition of \'w\' does not match any declaration in struct \'S\'']);
  assert.deepEqual(errorsOf('struct S { static int v; };\nlong S::v = 1;'),
    ['redefinition of \'v\' with a different type: \'long\' vs \'int\'']);
  assert.deepEqual(errorsOf('struct S { static int v; };\nint S::v;\nint S::v;'),
    ['redefinition of \'v\'']);
  assert.deepEqual(errorsOf('void f() { struct L { static int x; }; }'),
    ['static data member \'x\' not allowed in local class \'L\'']);
  ok('struct S { static S instance; int v; };\nS S::instance;');
  ok('struct S { static const int k = 2; static int arr[k]; };\nint S::arr[k] = {1, 2};');
});

test('checks access to static members', function () {
  assert.deepEqual(errorsOf('class S { static int hidden; static void priv(); };\n' +
    'int f() { S::priv(); return S::hidden; }'),
    ['\'priv\' is a private member of \'S\'', '\'hidden\' is a private member of \'S\'']);
  ok('class S { static int hidden; public: static int get() { return hidden; } };\n' +
    'int S::hidden = 3;\nint f() { return S::get(); }');
});

test('calls static member functions', function () {
  var r = ok('struct M { static int twice(int x) { return 2 * x; } int k; };\n' +
    'int f(M m) { return M::twice(1) + m.twice(2); }');
  assert.ok(/CallExpr 'int' prvalue/.test(r.dump));
  assert.deepEqual(errorsOf('struct M { int k; static int g() { return k; } };'),
    ['invalid use of non-static data member \'k\'']);
  assert.deepEqual(errorsOf('struct M { static int g() { return this != 0; } };'),
    ['invalid use of \'this\' outside of a non-static member function']);
});
