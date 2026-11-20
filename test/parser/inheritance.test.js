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

var SHAPES = 'struct Shape {\n  virtual ~Shape() {}\n  virtual double area() const = 0;\n' +
  '  virtual Shape *clone() const = 0;\n  int id;\n};\nstruct Circle : Shape {\n  double r;\n' +
  '  Circle(double x) : Shape(), r(x) {}\n  double area() const override { return r; }\n' +
  '  Circle *clone() const override { return new Circle(r); }\n};\n';

test('declares bases and virtual functions', function () {
  var r = ok(SHAPES);
  assert.deepEqual(lines(r, /RecordDecl|BaseSpecifier|FunctionDecl (~|area|clone)/), [
    'RecordDecl struct Shape size=8 align=4 polymorphic abstract',
    'FunctionDecl ~Shape \'void ()\' public destructor virtual',
    'FunctionDecl area \'double () const\' public virtual pure',
    'FunctionDecl clone \'Shape *() const\' public virtual pure',
    'RecordDecl struct Circle size=16 align=8 polymorphic', 'BaseSpecifier public Shape',
    'FunctionDecl area \'double () const\' public virtual override',
    'FunctionDecl clone \'Circle *() const\' public virtual override']);
});

test('lays out bases, vtable pointers and empty bases', function () {
  var r = ok('struct E {};\nstruct A : E { int x; };\nstruct B { int b; };\n' +
    'struct C : B { char c; };\nstruct V { virtual void f(); };\nstruct W : V { int w; };\n' +
    'struct P : B { virtual void g(); int p; };');
  assert.deepEqual(lines(r, /RecordDecl/).map(function (l) {
    return l.replace(/ polymorphic/, '');
  }), ['RecordDecl struct E size=1 align=1', 'RecordDecl struct A size=4 align=4',
    'RecordDecl struct B size=4 align=4', 'RecordDecl struct C size=8 align=4',
    'RecordDecl struct V size=4 align=4', 'RecordDecl struct W size=8 align=4',
    'RecordDecl struct P size=12 align=4']);
});

test('converts derived to base', function () {
  var r = ok(SHAPES + 'void f() {\n  Circle c(2);\n  Shape *s = &c;\n  Shape &ref = c;\n' +
    '  const Shape *cs = &c;\n  s->area();\n  ref.area();\n}');
  assert.deepEqual(lines(r, /DerivedToBase/), [
    'CastExpr \'Shape *\' prvalue <DerivedToBase>', 'CastExpr \'Shape\' lvalue <DerivedToBase>',
    'CastExpr \'const Shape *\' prvalue <DerivedToBase>']);
  assert.deepEqual(lines(r, /CallExpr 'double'/), ['CallExpr \'double\' prvalue virtual',
    'CallExpr \'double\' prvalue virtual']);
});

test('prefers conversions to closer bases', function () {
  var base = 'struct A {}; struct B : A {}; struct C : B {};\n';
  assert.ok(/CallExpr 'char'/.test(ok(base + 'int f(A *); char f(B *);\nvoid g(C *c) { f(c); }')
    .dump));
  assert.ok(/CallExpr 'char'/.test(ok(base + 'int f(void *); char f(A *);\n' +
    'void g(C *c) { f(c); }').dump));
  assert.ok(/CallExpr 'char'/.test(ok(base + 'int f(A &); char f(B &);\nvoid g(C &c) { f(c); }')
    .dump));
  assert.ok(/CallExpr 'int'/.test(ok(base + 'int f(C &); char f(B &);\nvoid g(C &c) { f(c); }')
    .dump));
});

test('slices objects and casts down', function () {
  var r = ok('struct B { int b; };\nstruct D : B { int d; };\nvoid f(D d, B *pb, B &rb) {\n' +
    '  B copy = d;\n  D *pd = static_cast<D *>(pb);\n  D &rd = static_cast<D &>(rb);\n}');
  assert.deepEqual(lines(r, /BaseToDerived|ConstructExpr/), [
    'ConstructExpr \'B\' prvalue \'void (const B &)\' copy',
    'CastExpr \'D *\' prvalue <BaseToDerived> static', 'CastExpr \'D\' lvalue <BaseToDerived> static']);
  assert.deepEqual(errorsOf('struct B {};\nstruct D : B {};\nvoid f(B *pb) { D *pd = pb; }'),
    ['cannot initialize a variable of type \'D *\' with an lvalue of type \'B *\'']);
});

test('applies access through inheritance', function () {
  var base = 'class Base { protected: int p; public: int q; void show(); private: int z; };\n';
  ok(base + 'class D : public Base { void use() { p = 1; q = 2; show(); } };');
  ok(base + 'class D : private Base { void use() { p = 1; q = 2; Base::show(); } };');
  assert.deepEqual(errorsOf(base + 'class D : public Base { void use() { z = 1; } };'),
    ['\'z\' is a private member of \'Base\'']);
  assert.deepEqual(errorsOf(base + 'class D : private Base {};\nvoid f(D d) { d.q = 1; }'),
    ['\'q\' is a private member of \'Base\'']);
  assert.deepEqual(parse(base + 'class D : private Base {};\nvoid f(D d) { d.q = 1; }').bag
    .getAll()[0].notes[0].message, 'constrained by private inheritance here');
  assert.deepEqual(errorsOf(base + 'class D : protected Base {};\nvoid f(D d) { d.q = 1; }'),
    ['\'q\' is a protected member of \'Base\'']);
  assert.deepEqual(errorsOf(base + 'class D : Base {};\nvoid f(D &d) { Base &b = d; }'),
    ['cannot cast \'D\' to its private base class \'Base\'']);
  ok(base + 'struct D : Base {};\nvoid f(D &d) { Base &b = d; d.q = 1; }');
});

test('restricts protected access to objects of the derived class', function () {
  var base = 'class A { protected: int p; static int s; void m(); };\n';
  ok(base + 'struct E : A { void k(E &e) { p = 1; A::p = 2; e.p = 3; e.m(); s = 4; A::s = 5; } };');
  assert.deepEqual(errorsOf(base + 'struct E : A { void k(A &a) { a.p = 1; a.m(); } };'),
    ['\'p\' is a protected member of \'A\'', '\'m\' is a protected member of \'A\'']);
  assert.deepEqual(parse(base + 'struct E : A { void k(A &a) { a.p = 1; } };').bag.getAll()[0]
    .notes[0].message, 'can only access this member on an object of type \'E\'');
  assert.deepEqual(parse('class A { public: int q; };\nclass C : private A {};\n' +
    'class D : public C { void m() { q = 1; } };').bag.getAll()[0].notes[0].message,
    'constrained by private inheritance here');
});

test('checks overriding', function () {
  assert.deepEqual(errorsOf('struct B { void f(); };\nstruct D : B { void f() override; };'),
    ['\'f\' marked \'override\' but does not override any member functions']);
  assert.deepEqual(errorsOf('struct B { virtual void f() final; };\nstruct D : B { void f(); };'),
    ['declaration of \'f\' overrides a \'final\' function']);
  assert.deepEqual(errorsOf('struct B { virtual void f(); };\nstruct D : B { int f(); };'),
    ['virtual function \'f\' has a different return type (\'int\') than the function it ' +
      'overrides (which has return type \'void\')']);
  assert.deepEqual(errorsOf('struct B { void f() = 0; };'),
    ['\'f\' is not virtual and cannot be declared pure']);
  assert.deepEqual(errorsOf('struct B final {};\nstruct D : B {};'),
    ['base \'B\' is marked \'final\'']);
  var r = ok('struct B { virtual void f(); virtual ~B(); };\nstruct D : B { void f(); ~D(); };');
  assert.deepEqual(lines(r, /FunctionDecl (f|~D)/), [
    'FunctionDecl f \'void ()\' public virtual', 'FunctionDecl f \'void ()\' public virtual',
    'FunctionDecl ~D \'void ()\' public destructor virtual']);
});

test('rejects objects of abstract classes', function () {
  assert.deepEqual(errorsOf(SHAPES + 'Shape s;'), ['variable type \'Shape\' is an abstract class']);
  assert.deepEqual(errorsOf(SHAPES + 'Shape *p = new Shape;'),
    ['allocating an object of abstract class type \'Shape\'']);
  assert.deepEqual(parse(SHAPES + 'Shape s;').bag.getAll()[0].notes.map(function (n) {
    return n.message;
  }), ['unimplemented pure virtual method \'area\' in \'Shape\'',
    'unimplemented pure virtual method \'clone\' in \'Shape\'']);
  ok(SHAPES + 'Circle c(1);\nShape *p = new Circle(2);');
  assert.deepEqual(errorsOf('struct A { virtual void f() = 0; };\nstruct B : A {};\nB b;'),
    ['variable type \'B\' is an abstract class']);
});

test('initializes base classes', function () {
  ok('struct B { B(int); };\nstruct D : B { D() : B(1) {} };');
  assert.deepEqual(errorsOf('struct B { B(int); };\nstruct D : B { D() {} };'),
    ['constructor for \'D\' must explicitly initialize the base class \'B\' which does not ' +
      'have a default constructor']);
  assert.deepEqual(errorsOf('struct B { B(int); };\nstruct D : B {};\nD d;'),
    ['call to implicitly-deleted default constructor of \'D\'']);
  assert.deepEqual(errorsOf('struct B {};\nstruct D : B { D() : B(), B() {} };'),
    ['multiple initializations given for base \'B\'']);
});

test('rejects unsupported and invalid bases', function () {
  assert.deepEqual(errorsOf('struct A {}; struct B {};\nstruct C : A, B {};'),
    ['multiple inheritance is not supported yet']);
  assert.deepEqual(errorsOf('struct A {};\nstruct C : virtual A {};'),
    ['virtual base classes are not supported yet']);
  assert.deepEqual(errorsOf('struct F;\nstruct C : F {};'), ['base class has incomplete type']);
  assert.deepEqual(errorsOf('struct C : Missing {};'), ['unknown class name \'Missing\'']);
  assert.deepEqual(errorsOf('union U {};\nstruct C : U {};'), ['unions cannot be base classes']);
});
