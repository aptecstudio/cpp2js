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
  return r.dump.split('\n').map(function (l) { return l.trim(); })
    .filter(function (l) { return pattern.test(l); });
}

var ARRAY = 'template <typename T, int N = 4>\nstruct Array {\n  T data[N];\n' +
  '  int size() const { return N; }\n  T &at(int i) { return data[i]; }\n' +
  '  Array<T, N> copy() const { return *this; }\n  Array same() const { return *this; }\n};\n' +
  'template <class K, class V> struct Pair { K key; V value; };\n';

test('instantiates class templates with defaults and nesting', function () {
  var r = ok(ARRAY + 'Array<int> a;\nArray<double, 2> b;\nPair<int, Array<int>> p;\n' +
    'Pair<Pair<int, int>, Pair<char, Array<short, 1>>> deep;\nArray<int, (2 > 1)> e;\n' +
    'Array<double, sizeof(int)> f;');
  assert.deepEqual(lines(r, /^VarDecl/), ['VarDecl a \'Array<int, 4>\'',
    'VarDecl b \'Array<double, 2>\'', 'VarDecl p \'Pair<int, Array<int, 4>>\'',
    'VarDecl deep \'Pair<Pair<int, int>, Pair<char, Array<short, 1>>>\'',
    'VarDecl e \'Array<int, 1>\'', 'VarDecl f \'Array<double, 4>\'']);
  assert.ok(/RecordDecl struct Array<double, 2> size=16 align=8/.test(r.dump));
});

test('caches instantiations', function () {
  var r = ok(ARRAY + 'Array<int> a;\nArray<int, 4> b;\nArray<int, 2 + 2> c;');
  assert.equal(lines(r, /RecordDecl struct Array</).length, 1);
});

test('instantiates member function bodies only when used', function () {
  var r = ok(ARRAY + 'int f() { Array<int> a; a.at(0) = 1; return a.size(); }');
  var record = r.unit.instantiations[0];
  var bodies = record.members.filter(function (m) { return m.kind === 'FunctionDecl'; })
    .map(function (m) { return m.name + ':' + !!m.body; });
  assert.deepEqual(bodies, ['size:true', 'at:true', 'copy:false', 'same:false']);
  ok('template <class T> struct Lazy { void bad() { T x = "no"; } int fine() { return 1; } };\n' +
    'int f() { Lazy<int> l; return l.fine(); }');
  assert.deepEqual(errorsOf('template <class T> struct Lazy { void bad() { T x = "no"; } };\n' +
    'void f() { Lazy<int> l; l.bad(); }'),
    ['cannot initialize a variable of type \'int\' with an lvalue of type \'const char [3]\'']);
});

test('reports invalid template arguments', function () {
  var src = ARRAY + 'template <char C> struct Ch {};\n';
  assert.deepEqual(errorsOf(src + 'Array<int, 1, 2> g;'),
    ['too many template arguments for class template \'Array\'']);
  assert.deepEqual(errorsOf(src + 'Pair<int> g;'),
    ['too few template arguments for class template \'Pair\'']);
  assert.deepEqual(errorsOf(src + 'Array<4> h;'),
    ['template argument for template type parameter must be a type']);
  assert.deepEqual(errorsOf(src + 'Array<int, 0.5> i;'),
    ['conversion from \'double\' to \'int\' is not allowed in a converted constant expression']);
  assert.deepEqual(errorsOf(src + 'Ch<300> c;'),
    ['non-type template argument evaluates to 300, which cannot be narrowed to type \'char\'']);
  assert.deepEqual(errorsOf(src + 'Array k;'),
    ['use of class template \'Array\' requires template arguments']);
  assert.deepEqual(errorsOf(src + 'int n = 2;\nArray<int, n> v;'),
    ['non-type template argument is not a constant expression']);
});

test('checks template parameter lists', function () {
  assert.deepEqual(errorsOf('template <class T = int, class U> struct S {};'),
    ['template parameter missing a default argument']);
  assert.deepEqual(errorsOf('template <class... Ts, class U> struct S {};'),
    ['template parameter pack must be the last template parameter']);
  assert.deepEqual(errorsOf('template <class T, class T> struct S {};'),
    ['declaration of \'T\' shadows template parameter']);
  assert.deepEqual(errorsOf('void f() { template <class T> struct S {}; }'),
    ['templates can only be declared in namespace or class scope']);
  assert.deepEqual(errorsOf('template <class T> struct S {};\ntemplate <class T> struct S {};'),
    ['redefinition of \'S\'']);
  ok('template <class T> struct F;\ntemplate <class T> struct F { T v; };\nF<int> f;');
});

test('uses template parameters in members and bases', function () {
  var r = ok('template <class T> struct Base { T v; };\n' +
    'template <class T> struct Holder : Base<T> { T get() const { return this->v; } };\n' +
    'int f() { Holder<int> h; return h.get(); }');
  assert.ok(/BaseSpecifier public Base<int>/.test(r.dump));
});

function callTypes(r) {
  return lines(r, /^CallExpr/).map(function (l) { return /'([^']*)'/.exec(l)[1]; });
}

test('deduces function template arguments', function () {
  var r = ok('template <typename T> T maxOf(T a, T b) { return a > b ? a : b; }\n' +
    'template <typename T, int N> int count(T (&arr)[N]) { return N; }\n' +
    'template <class T> struct Box { T v; };\n' +
    'template <class T> T unbox(const Box<T> &b) { return b.v; }\n' +
    'template <class T> T deref(const T *p) { return *p; }\n' +
    'void f() {\n  int arr[5];\n  Box<double> b;\n  maxOf(1.5, 2.5);\n  unbox(b);\n' +
    '  count(arr);\n  maxOf<long>(1, 2);\n  deref(arr);\n}');
  assert.deepEqual(callTypes(r), ['double', 'double', 'int', 'long', 'int']);
  assert.deepEqual(lines(r, /^FunctionDecl (maxOf|unbox|count|deref) /), [
    'FunctionDecl maxOf \'double (double, double)\'',
    'FunctionDecl unbox \'double (const Box<double> &)\'',
    'FunctionDecl count \'int (int (&)[5])\'', 'FunctionDecl maxOf \'long (long, long)\'',
    'FunctionDecl deref \'int (const int *)\'']);
});

test('deduces forwarding references', function () {
  var r = ok('template <class T> T &&pass(T &&x);\nvoid f() { int x = 0; pass(x); pass(1); }');
  assert.deepEqual(lines(r, /^CallExpr/), ['CallExpr \'int\' lvalue', 'CallExpr \'int\' xvalue']);
});

test('orders templates and functions in overload resolution', function () {
  var r = ok('template <class T> char show(T x);\nint show(int x);\n' +
    'template <class T> int first(T *p);\ntemplate <class T> char first(T p);\n' +
    'void f() { int arr[2]; show(1); show(1.5); first(arr); first(1); }');
  assert.deepEqual(callTypes(r), ['int', 'char', 'int', 'char']);
});

test('reports deduction failures', function () {
  var src = 'template <typename T> T maxOf(T a, T b);\n';
  assert.deepEqual(errorsOf(src + 'void f() { maxOf(1, 2.5); }'),
    ['no matching function for call to \'maxOf\'']);
  assert.deepEqual(parse(src + 'void f() { maxOf(1, 2.5); }').bag.getAll()[0].notes[0].message,
    'candidate template ignored: deduced conflicting types for parameter \'T\' (\'int\' vs. ' +
    '\'double\')');
  assert.deepEqual(parse('template <class T> T make();\nvoid f() { make(); }').bag.getAll()[0]
    .notes[0].message, 'candidate template ignored: couldn\'t infer template argument \'T\'');
  ok('template <class T> T make();\nvoid f() { make<int>(); }');
});

test('discards substitution failures (SFINAE)', function () {
  // `int::type` does not exist: the first template is dropped for int.
  var r = ok('struct S { typedef int type; };\n' +
    'template <class T> char pick(typename T::type *);\n' +
    'template <class T> long pick(...);\nvoid f() { pick<S>(0); pick<int>(0); }');
  assert.deepEqual(callTypes(r), ['char', 'long']);
});

test('instantiates function template bodies when used', function () {
  ok('template <class T> void bad(T x) { x.missing(); }\nvoid f() {}');
  assert.deepEqual(errorsOf('template <class T> void bad(T x) { x.missing(); }\n' +
    'void f() { bad(1); }'),
    ['member reference base type \'int\' is not a structure or union']);
});
