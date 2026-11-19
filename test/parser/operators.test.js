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

function lines(r, pattern) {
  return r.dump.split('\n').filter(function (l) { return pattern.test(l); })
    .map(function (l) { return l.trim(); });
}

var VEC = 'namespace geo {\n  struct Vec {\n    int x, y;\n' +
  '    Vec(int a = 0, int b = 0) : x(a), y(b) {}\n' +
  '    Vec operator+(const Vec &o) const { return Vec(x + o.x, y + o.y); }\n' +
  '    Vec &operator+=(const Vec &o) { x += o.x; y += o.y; return *this; }\n' +
  '    int operator[](int i) const { return i ? y : x; }\n' +
  '    bool operator==(const Vec &o) const { return x == o.x && y == o.y; }\n' +
  '    Vec &operator++() { ++x; return *this; }\n' +
  '    Vec operator++(int) { Vec old = *this; ++x; return old; }\n' +
  '    Vec operator-() const { return Vec(-x, -y); }\n' +
  '    explicit operator bool() const { return x || y; }\n  };\n' +
  '  Vec operator*(const Vec &v, int k) { return Vec(v.x * k, v.y * k); }\n}\n';

test('calls member and non-member operators', function () {
  var r = ok(VEC + 'void f(geo::Vec a, geo::Vec b) {\n  a + b; a += b; a[1]; a == b; ++a; a++;\n' +
    '  -a; a * 3;\n}');
  assert.deepEqual(lines(r, /CallExpr operator/), [
    'CallExpr operator+ \'geo::Vec\' prvalue', 'CallExpr operator+= \'geo::Vec\' lvalue',
    'CallExpr operator[] \'int\' prvalue', 'CallExpr operator== \'bool\' prvalue',
    'CallExpr operator++ \'geo::Vec\' lvalue', 'CallExpr operator++ \'geo::Vec\' prvalue',
    'CallExpr operator- \'geo::Vec\' prvalue', 'CallExpr operator* \'geo::Vec\' prvalue']);
});

test('finds non-member operators in the namespaces of the operands', function () {
  ok(VEC + 'geo::Vec scaled(geo::Vec v) { return v * 2; }');
  assert.deepEqual(errorsOf('namespace n { struct S {}; }\nint operator+(n::S, n::S);\n' +
    'int f(n::S a) { return a + a; }'), []);
});

test('uses function objects and operator->', function () {
  var r = ok('struct Adder { int operator()(int a, int b) const { return a + b; } };\n' +
    'struct Target { int v; };\nstruct Ptr { Target *t; Target *operator->() const { ' +
    'return t; } };\nint f(Adder add, Ptr p) { return add(1, 2) + p->v; }');
  assert.deepEqual(lines(r, /CallExpr operator/), ['CallExpr operator() \'int\' prvalue',
    'CallExpr operator-> \'Target *\' prvalue']);
  assert.deepEqual(errorsOf('struct S {};\nvoid f(S s) { s(1); }'),
    ['type \'S\' does not provide a call operator']);
});

test('applies user-defined conversions', function () {
  var r = ok('struct S { S(int); };\nvoid take(S);\nvoid f() { take(5); S s = 3; }');
  assert.deepEqual(lines(r, /ConstructExpr/), [
    'ConstructExpr \'S\' prvalue \'void (int)\' user', 'ConstructExpr \'S\' prvalue \'void (int)\' user']);
  r = ok('struct D { operator double() const; };\ndouble f(D d) { double x = d; return x; }');
  assert.deepEqual(lines(r, /MemberExpr/), ['MemberExpr .operator double \'double () const\' ' +
    'prvalue']);
  assert.deepEqual(errorsOf('struct E { explicit E(int); };\nvoid take(E);\nvoid f() { take(1); }'),
    ['cannot initialize a parameter of type \'E\' with an rvalue of type \'int\'']);
  ok('struct B { explicit operator bool() const; };\nvoid f(B b) { if (b) {} while (!b) {} ' +
    'bool x = b && true; }');
  assert.deepEqual(errorsOf('struct B { explicit operator bool() const; };\n' +
    'void f(B b) { bool x = b; }'),
    ['cannot initialize a variable of type \'bool\' with an lvalue of type \'B\'']);
});

test('ranks user-defined conversions below standard ones', function () {
  assert.ok(/CallExpr 'int'/.test(ok('struct S { S(int); };\nint f(long); char f(S);\n' +
    'void g() { f(1); }').dump));
  assert.deepEqual(errorsOf('struct A { A(int); }; struct B { B(int); };\n' +
    'void pick(A); void pick(B);\nvoid g() { pick(1); }'), ['call to \'pick\' is ambiguous']);
  assert.ok(/CallExpr 'char'/.test(ok('struct S { S(int); };\nint f(...); char f(S);\n' +
    'void g() { f(1); }').dump));
});

test('checks operator declarations', function () {
  assert.deepEqual(errorsOf('int operator+(int, int);'),
    ['overloaded \'operator+\' must have at least one parameter of class or enumeration type']);
  assert.deepEqual(errorsOf('struct S {};\nint operator=(S, int);'),
    ['overloaded \'operator=\' must be a non-static member function']);
  assert.deepEqual(errorsOf('struct S { int operator+(int, int); };'),
    ['overloaded \'operator+\' must be a unary or binary operator (has 3 parameters)']);
  assert.deepEqual(errorsOf('struct S { S operator++(double); };'),
    ['parameter of overloaded post-increment operator must have type \'int\' (not \'double\')']);
  assert.deepEqual(errorsOf('struct S { operator int(int); };'),
    ['conversion function cannot have any parameters']);
  assert.deepEqual(errorsOf('struct S { explicit void f(); };'),
    ['\'explicit\' can only be applied to a constructor or conversion function']);
  ok('enum E { a, b };\nE operator|(E l, E r);\nE f() { return a | b; }');
});

test('defines operators out of line', function () {
  ok('struct S { int v; S operator+(const S &) const; operator int() const; };\n' +
    'S S::operator+(const S &o) const { S r = *this; r.v += o.v; return r; }\n' +
    'S::operator int() const { return v; }'.replace('S::operator int() const',
      'S::operator int() const'));
});

test('falls back to built-in operators', function () {
  assert.deepEqual(errorsOf('struct V { int x; };\nvoid f(V v) { v + 1; }'),
    ['invalid operands to binary expression (\'V\' and \'int\')']);
  ok('enum E { a, b };\nint f() { return a + b; }');
});
