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

var VEC = 'struct Vec {\n  int x, y;\n  Vec() : x(0), y(0) {}\n  Vec(int a, int b) : x(a), y{b} {}\n' +
  '  explicit Vec(int s);\n  ~Vec();\n};\nVec::Vec(int s) : Vec(s, s) {}\nVec::~Vec() {}\n';

test('declares constructors and destructors', function () {
  var r = ok(VEC);
  assert.deepEqual(lines(r, /FunctionDecl/), [
    'FunctionDecl Vec \'void ()\' public constructor',
    'FunctionDecl Vec \'void (int, int)\' public constructor',
    'FunctionDecl Vec \'void (int)\' public constructor explicit',
    'FunctionDecl ~Vec \'void ()\' public destructor',
    'FunctionDecl Vec \'void (int)\' redecl public constructor explicit',
    'FunctionDecl ~Vec \'void ()\' redecl public destructor']);
  assert.deepEqual(lines(r, /CtorInitializer/), ['CtorInitializer x', 'CtorInitializer y',
    'CtorInitializer x', 'CtorInitializer y', 'CtorInitializer <delegating>']);
});

test('selects constructors for every initialization form', function () {
  var r = ok(VEC + 'Vec make();\nvoid f() {\n  Vec a;\n  Vec b(1, 2);\n  Vec c = b;\n' +
    '  Vec d{3, 4};\n  Vec e = Vec(5);\n  Vec g = make();\n  Vec *p = new Vec(1, 1);\n' +
    '  Vec h = {1, 2};\n}');
  assert.deepEqual(lines(r, /ConstructExpr/), [
    'ConstructExpr \'Vec\' prvalue \'void (int, int)\' user',
    'ConstructExpr \'Vec\' prvalue \'void ()\' user',
    'ConstructExpr \'Vec\' prvalue \'void (int, int)\' user',
    'ConstructExpr \'Vec\' prvalue \'void (const Vec &)\' copy',
    'ConstructExpr \'Vec\' prvalue \'void (int, int)\' user list',
    'ConstructExpr \'Vec\' prvalue \'void (int)\' user',
    'ConstructExpr \'Vec\' prvalue \'void (int, int)\' user',
    'ConstructExpr \'Vec\' prvalue \'void (int, int)\' user list']);
});

test('declares implicit special members', function () {
  var r = ok('struct P { int x; };\nP a;\nP b = a;\nP c(static_cast<P &&>(a));\n' +
    'void f() { b = a; c = static_cast<P &&>(a); }');
  assert.deepEqual(lines(r, /ConstructExpr/), ['ConstructExpr \'P\' prvalue \'void ()\' default',
    'ConstructExpr \'P\' prvalue \'void (const P &)\' copy',
    'ConstructExpr \'P\' prvalue \'void (P &&)\' move']);
  assert.ok(/BinaryExpr '=' 'P' lvalue/.test(r.dump));
});

test('suppresses and deletes implicit members as C++11 requires', function () {
  assert.deepEqual(errorsOf('struct D { ~D(); };\nD a;\nD b(static_cast<D &&>(a));'), []);
  assert.deepEqual(errorsOf('struct M { M(M &&); M(); };\nM a;\nM b = a;'),
    ['call to implicitly-deleted copy constructor of \'M\'']);
  assert.deepEqual(errorsOf('struct R { int &r; };\nR r;'),
    ['call to implicitly-deleted default constructor of \'R\'']);
  assert.deepEqual(errorsOf('struct C { const int c; };\nC c;'),
    ['call to implicitly-deleted default constructor of \'C\'']);
  assert.deepEqual(errorsOf('struct R { int &r; };\nvoid f(R a, R b) { a = b; }'),
    ['object of type \'R\' cannot be assigned because its copy assignment operator is ' +
      'implicitly deleted']);
  assert.deepEqual(errorsOf('struct N { N(int); };\nstruct H { N n; };\nH h;'),
    ['call to implicitly-deleted default constructor of \'H\'']);
  ok('struct N { N(int); };\nstruct H { N n; H() : n(1) {} };\nH h;');
});

test('reports constructor resolution errors', function () {
  assert.deepEqual(errorsOf('struct N { N(int); };\nN n;'),
    ['no matching constructor for initialization of \'N\'']);
  assert.deepEqual(errorsOf('struct N { N(int); };\nN n(1, 2);'),
    ['no matching constructor for initialization of \'N\'']);
  assert.deepEqual(errorsOf('struct E { explicit E(int); };\nE e = 1;'),
    ['no viable conversion from \'int\' to \'E\'']);
  assert.deepEqual(errorsOf('struct E { explicit E(int); };\nE e = {1};'),
    ['chosen constructor is explicit in copy-initialization']);
  ok('struct E { explicit E(int); };\nE e(1);\nE f{1};');
  assert.deepEqual(errorsOf('struct D { D(); D(const D &) = delete; };\nD a;\nD b = a;'),
    ['call to deleted constructor of \'D\'']);
  assert.deepEqual(errorsOf('struct P { private: P(); };\nP p;'),
    ['calling a private constructor of class \'P\'']);
  assert.deepEqual(errorsOf('struct A { A(int); A(long); };\nA a(1u);'),
    ['call to constructor of \'A\' is ambiguous']);
});

test('checks member initializer lists', function () {
  assert.deepEqual(errorsOf('struct S { int a; S() : b(1) {} };'),
    ['member initializer \'b\' does not name a non-static data member or base class']);
  assert.deepEqual(errorsOf('struct S { int a; S() : a(1), a(2) {} };'),
    ['multiple initializations given for non-static member \'a\'']);
  assert.deepEqual(errorsOf('struct S { const int c; S() {} };'),
    ['constructor for \'S\' must explicitly initialize the const member \'c\'']);
  assert.deepEqual(errorsOf('struct S { int &r; S() {} };'),
    ['constructor for \'S\' must explicitly initialize the reference member \'r\'']);
  assert.deepEqual(errorsOf('struct S { int a; S(int); S() : S(1), a(2) {} };'),
    ['an initializer for a delegating constructor must appear alone']);
  assert.deepEqual(errorsOf('struct S { int a; void f() : a(1) {} };'),
    ['only constructors take base initializers']);
  ok('struct S { const int c = 1; int &r; S(int &x) : r(x) {} };');
  ok('struct S { int a[2]; S() : a{1, 2} {} };');
});

test('validates constructor and destructor declarations', function () {
  assert.deepEqual(errorsOf('struct S { S(); S(); };'), ['constructor cannot be redeclared']);
  assert.deepEqual(errorsOf('struct S { ~S(int); };'), ['destructor cannot have any parameters']);
  assert.deepEqual(errorsOf('struct S { S() const; };'),
    ['\'const\' qualifier is not allowed on a constructor']);
  assert.deepEqual(errorsOf('struct S { virtual S(); };'),
    ['constructor cannot be declared \'virtual\'']);
  assert.deepEqual(errorsOf('struct S { S(); };\nS::S(int) {}'),
    ['out-of-line definition of \'S\' does not match any declaration in struct \'S\'']);
  assert.deepEqual(errorsOf('struct S { void f() = default; };'),
    ['only special member functions may be defaulted']);
  ok('struct S { S() = default; S(const S &) = default; ~S() = default; };\nS s;');
  ok('namespace n { struct S { S(); }; }\nn::S::S() {}');
});

test('calls deleted functions and moves returned locals', function () {
  assert.deepEqual(errorsOf('int g() = delete;\nint f() { return g(); }'),
    ['call to deleted function \'g\'']);
  var r = ok('struct M { M(); M(const M &); M(M &&); };\nM f() { M m; return m; }');
  assert.ok(/ConstructExpr 'M' prvalue 'void \(M &&\)' user/.test(r.dump));
});

test('constructs class temporaries and arguments', function () {
  var r = ok('struct S { S(int); };\nvoid take(S s);\nvoid f(S s) { take(s); take(S(1)); ' +
    'S t = S{2}; }');
  assert.deepEqual(lines(r, /ConstructExpr/), [
    'ConstructExpr \'S\' prvalue \'void (const S &)\' copy',
    'ConstructExpr \'S\' prvalue \'void (int)\' user',
    'ConstructExpr \'S\' prvalue \'void (int)\' user list']);
});
