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

test('declares members with default access', function () {
  var r = ok('struct S { int a; void f(); };\nclass C { int a; public: int b; protected: int c; ' +
    'private: int d; };\nunion U { int i; float f; };');
  assert.deepEqual(lines(r, /FieldDecl|RecordDecl|FunctionDecl/), [
    'RecordDecl struct S size=4 align=4', 'FieldDecl a \'int\' public',
    'FunctionDecl f \'void ()\' public', 'RecordDecl class C size=16 align=4',
    'FieldDecl a \'int\' private', 'FieldDecl b \'int\' public', 'FieldDecl c \'int\' protected',
    'FieldDecl d \'int\' private', 'RecordDecl union U size=4 align=4',
    'FieldDecl i \'int\' public', 'FieldDecl f \'float\' public']);
});

test('lays classes out with ILP32 natural alignment', function () {
  var r = ok('struct E {};\nstruct A { char c; double d; short s; };\n' +
    'struct B { char a; char b; int i; };\nstruct P { char c; int *p; };\n' +
    'struct N { A a; char c; };\nstruct Arr { char c[5]; int i; };\n' +
    'struct Bits { unsigned a : 3, b : 5; int c; };\nstruct Bits2 { char x : 4; char y : 6; };\n' +
    'union U { char c[5]; int i; };\nstruct R { int &r; char c; };');
  assert.deepEqual(lines(r, /RecordDecl/), ['RecordDecl struct E size=1 align=1',
    'RecordDecl struct A size=24 align=8', 'RecordDecl struct B size=8 align=4',
    'RecordDecl struct P size=8 align=4', 'RecordDecl struct N size=32 align=8',
    'RecordDecl struct Arr size=12 align=4', 'RecordDecl struct Bits size=8 align=4',
    'RecordDecl struct Bits2 size=2 align=1', 'RecordDecl union U size=8 align=4',
    'RecordDecl struct R size=8 align=4']);
  r = ok('struct A { char c; double d; };\nint s[sizeof(A)];');
  assert.ok(/VarDecl s 'int \[16\]'/.test(r.dump));
});

test('checks member declarations', function () {
  assert.deepEqual(errorsOf('struct S { int a; int a; };'), ['duplicate member \'a\'']);
  assert.deepEqual(errorsOf('struct S { int S; };'),
    ['member \'S\' has the same name as its class']);
  assert.deepEqual(errorsOf('struct F;\nstruct S { F f; };'), ['field has incomplete type \'F\'']);
  assert.deepEqual(errorsOf('struct S { S s; };'), ['field has incomplete type \'S\'']);
  ok('struct S { S *next; S &self(); };');
  assert.deepEqual(errorsOf('struct S { double d : 3; };'),
    ['bit-field \'d\' has non-integral type \'double\'']);
  assert.deepEqual(errorsOf('struct S { char c : 9; };'),
    ['width of bit-field \'c\' (9 bits) exceeds the width of its type (8 bits)']);
  assert.deepEqual(errorsOf('struct S { mutable const int c = 1; };'),
    ['\'mutable\' cannot be applied to const members']);
  assert.deepEqual(errorsOf('struct S { extern int e; };'),
    ['storage class specified for a member declaration']);
  assert.deepEqual(errorsOf('struct S {};\nstruct S {};'), ['redefinition of \'S\'']);
  assert.deepEqual(errorsOf('struct S;\nunion S { int i; };'),
    ['use of \'S\' with tag type that does not match previous declaration']);
});

test('parses member function bodies after the class is complete', function () {
  var r = ok('struct S {\n  int get() const { return value + helper(); }\n' +
    '  int helper() const { return 1; }\n  int value;\n};');
  assert.ok(/MemberExpr ->value 'const int' lvalue/.test(r.dump));
  ok('struct Outer {\n  struct Inner { int f() { return Outer::k(); } };\n' +
    '  static int k();\n};');
});

test('types this and implicit member access', function () {
  var r = ok('struct S { int v; void f() { v = 1; this->v = 2; (*this).v = 3; } ' +
    'int g() const { return v; } };');
  assert.deepEqual(lines(r, /ThisExpr/), ['ThisExpr \'S *\' prvalue implicit',
    'ThisExpr \'S *\' prvalue', 'ThisExpr \'S *\' prvalue',
    'ThisExpr \'const S *\' prvalue implicit']);
  assert.deepEqual(errorsOf('int f() { return this != 0; }'),
    ['invalid use of \'this\' outside of a non-static member function']);
  assert.deepEqual(errorsOf('struct T { int v; };\nint h() { return T::v; }'),
    ['invalid use of non-static data member \'v\'']);
});

test('computes member access types and categories', function () {
  var r = ok('struct S { int i; const int c = 0; mutable int m; int &r; };\n' +
    'S make();\nvoid f(S s, const S cs, S *p) { s.i; cs.i; cs.m; p->i; make().i; s.r; }');
  assert.deepEqual(lines(r, /MemberExpr/), ['MemberExpr .i \'int\' lvalue',
    'MemberExpr .i \'const int\' lvalue', 'MemberExpr .m \'int\' lvalue',
    'MemberExpr ->i \'int\' lvalue', 'MemberExpr .i \'int\' xvalue',
    'MemberExpr .r \'int\' lvalue']);
});

test('checks constness of member functions and objects', function () {
  assert.deepEqual(errorsOf('struct T { int v; void f() const { v = 2; } };'),
    ['cannot assign to non-static data member within const member function \'f\'']);
  ok('struct T { mutable int v; void f() const { v = 2; } };');
  assert.deepEqual(errorsOf('struct T { int v; };\nvoid h() { const T ct = {1}; ct.v = 3; }'),
    ['cannot assign to variable \'ct\' with const-qualified type \'const T\'']);
  assert.deepEqual(errorsOf('struct T { const int v; };\nvoid h(T t) { t.v = 3; }'),
    ['cannot assign to non-static data member \'v\' with const-qualified type \'const int\'']);
  assert.deepEqual(errorsOf('struct T { void set(); };\nvoid h(const T &t) { t.set(); }'),
    ['\'this\' argument to member function \'set\' has type \'const T\', but function is not ' +
      'marked const']);
});

test('resolves member function overloads with the object argument', function () {
  var r = ok('struct S { int get(); char get() const; };\n' +
    'void f(S s, const S cs) { s.get(); cs.get(); }');
  assert.deepEqual(lines(r, /CallExpr/), ['CallExpr \'int\' prvalue', 'CallExpr \'char\' prvalue']);
  assert.deepEqual(errorsOf('struct S { void f(int); void f(double); };\nvoid g(S s) { s.f(1u); }'),
    ['call to member function \'f\' is ambiguous']);
  assert.deepEqual(errorsOf('struct S { void f(int); void f(int, int); };\n' +
    'void g(S s) { s.f(); }'), ['no matching member function for call to \'f\'']);
  ok('struct S { int f(int); int f(int) const; };\nint g(const S &s) { return s.f(1); }');
});

test('checks access control', function () {
  var src = 'class C { int hidden; void priv(); public: int open; void pub(); };';
  assert.deepEqual(errorsOf(src + '\nvoid f(C c) { c.hidden = 1; }'),
    ['\'hidden\' is a private member of \'C\'']);
  assert.deepEqual(errorsOf(src + '\nvoid f(C c) { c.priv(); }'),
    ['\'priv\' is a private member of \'C\'']);
  assert.deepEqual(parse(src + '\nvoid f(C c) { c.hidden = 1; }').bag.getAll()[0].notes[0]
    .message, 'declared private here');
  ok(src + '\nvoid f(C c) { c.open = 1; c.pub(); }');
  ok('class C { int x; public: void f(C other) { other.x = x; } };');
  ok('class C { int x; struct In { int g(C c) { return c.x; } }; };');
  assert.deepEqual(errorsOf('class C { protected: int p; };\nint f(C c) { return c.p; }'),
    ['\'p\' is a protected member of \'C\'']);
});

test('defines member functions out of line', function () {
  var r = ok('class C { int v; public: int get() const; void set(int); };\n' +
    'int C::get() const { return v; }\nvoid C::set(int x) { v = x; }');
  assert.deepEqual(lines(r, /FunctionDecl (get|set)/), ['FunctionDecl get \'int () const\' public',
    'FunctionDecl set \'void (int)\' public', 'FunctionDecl get \'int () const\' redecl public',
    'FunctionDecl set \'void (int)\' redecl public']);
  assert.deepEqual(errorsOf('struct C { void f(); };\nvoid C::g() {}'),
    ['out-of-line definition of \'g\' does not match any declaration in struct \'C\'']);
  assert.deepEqual(errorsOf('struct C { int get(); };\nint C::get() const { return 0; }'),
    ['out-of-line definition of \'get\' does not match any declaration in struct \'C\'']);
  assert.deepEqual(errorsOf('struct C { int get(); };\nlong C::get() { return 0; }'),
    ['return type of out-of-line definition of \'get\' differs from that in the declaration']);
  assert.deepEqual(errorsOf('struct C { void f(); };\nvoid C::f();'),
    ['out-of-line declaration of a member must be a definition']);
  assert.deepEqual(errorsOf('struct C { void f(); };\nvoid C::f() {}\nint after = 1;\n' +
    'int C::nothing;\nint g() { return after; }'),
    ['out-of-line definition of \'nothing\' does not match any declaration in struct \'C\'']);
});

test('reports invalid member accesses', function () {
  assert.deepEqual(errorsOf('struct S {};\nvoid f(S s) { s.nothing; }'),
    ['no member named \'nothing\' in struct \'S\'']);
  assert.deepEqual(errorsOf('struct F;\nvoid f(F *p) { p->x; }'),
    ['member access into incomplete type \'F\'']);
  assert.deepEqual(errorsOf('void f(int i) { i.x; }'),
    ['member reference base type \'int\' is not a structure or union']);
  assert.deepEqual(errorsOf('struct S { int v; };\nvoid f(S s) { s->v; }'),
    ['member reference type \'S\' is not a pointer']);
  assert.deepEqual(errorsOf('struct S { void m(); };\nvoid f() { S::m(); }'),
    ['call to non-static member function without an object argument']);
});

test('initializes aggregates', function () {
  var r = ok('struct P { int x, y; };\nstruct L { P a, b; int n[2]; };\nP p = {1, 2};\n' +
    'P q{3};\nL l = {{1, 2}, {3}, {4, 5}};\nP z = {};');
  assert.ok(/VarDecl l 'L' copy-init/.test(r.dump));
  assert.deepEqual(errorsOf('struct P { int x, y; };\nP p = {1, 2, 3};'),
    ['excess elements in struct initializer']);
  assert.deepEqual(errorsOf('struct P { int x; };\nP p = {1.5};'),
    ['type \'double\' cannot be narrowed to \'int\' in initializer list']);
  assert.deepEqual(errorsOf('class C { int x; };\nC c = {1};'),
    ['no matching constructor for initialization of \'C\'']);
  assert.deepEqual(errorsOf('struct F;\nF f;'), ['variable has incomplete type \'F\'']);
});

test('declares tags through elaborated specifiers', function () {
  var r = ok('struct Node *head;\nstruct Node { int v; Node *next; };\n' +
    'void f() { struct Local { int x; } l; l.x = 1; }');
  assert.ok(/VarDecl head 'Node \*'/.test(r.dump));
});
