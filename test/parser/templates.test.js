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

test('selects partial and explicit class specializations', function () {
  var r = ok('template <class T> struct Traits { static const int kind = 0; };\n' +
    'template <class T> struct Traits<T *> { static const int kind = 1; T *p; };\n' +
    'template <class T> struct Traits<const T *> { static const int kind = 2; };\n' +
    'template <> struct Traits<bool> { static const int kind = 3; };\n' +
    'template <class T, int N> struct Traits<T[N]> { static const int kind = 4; };\n' +
    'int a[Traits<int>::kind + 1];\nint b[Traits<int *>::kind + 1];\n' +
    'int c[Traits<const int *>::kind + 1];\nint d[Traits<bool>::kind + 1];\n' +
    'int e[Traits<char[3]>::kind + 1];');
  assert.deepEqual(lines(r, /^VarDecl [a-e] /), ['VarDecl a \'int [1]\'', 'VarDecl b \'int [2]\'',
    'VarDecl c \'int [3]\'', 'VarDecl d \'int [4]\'', 'VarDecl e \'int [5]\'']);
  assert.ok(/FieldDecl p 'int \*'/.test(r.dump));
});

test('matches repeated parameters in partial specializations', function () {
  ok('template <class A, class B> struct Same { static const bool value = false; };\n' +
    'template <class A> struct Same<A, A> { static const bool value = true; };\n' +
    'static_assert(Same<int, int>::value && !Same<int, long>::value, "same");');
});

test('checks explicit specializations', function () {
  assert.deepEqual(errorsOf('template <class T> struct S {};\nS<int> s;\n' +
    'template <> struct S<int> {};'), ['explicit specialization of \'S<int>\' after instantiation']);
  assert.deepEqual(errorsOf('struct N {};\ntemplate <> struct N<int> {};'),
    ['\'N\' is not a class template']);
  assert.deepEqual(errorsOf('template <class T> int f(T *);\ntemplate <> int f(int);'),
    ['no function template matches function template specialization \'f\'']);
});

test('uses explicit function specializations', function () {
  var r = ok('template <class T> int name(T x) { return 0; }\n' +
    'template <> int name<double>(double x) { return 7; }\n' +
    'template <> int name(char x) { return 8; }\n' +
    'int f() { return name(1.5) + name(\'c\') + name(1); }');
  var specs = r.unit.instantiations.filter(function (d) { return d.kind === 'FunctionDecl'; })
    .map(function (d) { return T(d) + (d.isExplicitSpecialization ? ' explicit' : ''); });
  function T(d) { return require('../../src/semantic/types').typeToString(d.type); }
  assert.deepEqual(specs.sort(), ['int (char) explicit', 'int (double) explicit', 'int (int)']);
});

test('deduces and expands function parameter packs', function () {
  var r = ok('int sum() { return 0; }\n' +
    'template <class T, class... R> T sum(T first, R... rest) { return first + sum(rest...); }\n' +
    'template <class... Ts> int count(Ts... xs) { return sizeof...(Ts) + sizeof...(xs); }\n' +
    'int g(int, int, int);\n' +
    'template <class... Ts> int call(Ts... xs) { int a[] = { xs... }; return g(xs + 1 ...); }\n' +
    'template <class... Ts> void sink(Ts &&... xs);\n' +
    'int f() { int s = 0; sink(1, s); return sum(1, 2, 3) + count() + count(1, \'a\', 2.5) + ' +
    'call(1, 2, 3); }');
  assert.deepEqual(lines(r, /^DeclRefExpr sink/), ['DeclRefExpr sink \'void (int &&, int &)\' ' +
    'lvalue']);
  assert.deepEqual(lines(r, /^FunctionDecl (sum|count|call) /), [
    'FunctionDecl sum \'int ()\'', 'FunctionDecl sum \'int (int, int, int)\'', 'FunctionDecl count \'int ()\'',
    'FunctionDecl count \'int (int, char, double)\'', 'FunctionDecl call \'int (int, int, int)\'',
    'FunctionDecl sum \'int (int, int)\'', 'FunctionDecl sum \'int (int)\'']);
});

test('matches packs in partial specializations', function () {
  var r = ok('template <class... Ts> struct Tuple;\n' +
    'template <> struct Tuple<> { static const int size = 0; };\n' +
    'template <class H, class... T> struct Tuple<H, T...> : Tuple<T...> {\n' +
    '  H head; static const int size = 1 + sizeof...(T);\n};\n' +
    'Tuple<int, char, double> t;\nint arr[Tuple<int, char>::size];\nchar c = t.head;');
  assert.deepEqual(lines(r, /^(RecordDecl|BaseSpecifier)/).slice(0, 6), [
    'RecordDecl struct Tuple<> size=1 align=1', 'RecordDecl struct Tuple<double> size=8 align=8',
    'BaseSpecifier public Tuple<>', 'RecordDecl struct Tuple<char, double> size=16 align=8',
    'BaseSpecifier public Tuple<double>', 'RecordDecl struct Tuple<int, char, double> size=24 align=8']);
  assert.deepEqual(lines(r, /^VarDecl arr/), ['VarDecl arr \'int [2]\'']);
});

test('reports misused parameter packs', function () {
  assert.deepEqual(errorsOf('int g(int);\ntemplate <class... Ts> int bad(Ts... xs) { return g(xs); }\n' +
    'int f() { return bad(1); }'), ['expression contains unexpanded parameter pack \'xs\'']);
  assert.deepEqual(errorsOf('int g(int, int);\n' +
    'template <class... A> struct S { template <class... B> static void f(); };\n' +
    'template <class... Ts> int h(Ts... xs) { return g(xs...); }\nint f() { return h(1); }'),
    ['too few arguments to function call, expected 2, have 1']);
  assert.deepEqual(errorsOf('template <class... Ts, class U> struct S {};'),
    ['template parameter pack must be the last template parameter']);
});

test('substitutes alias templates', function () {
  var r = ok('template <class T> struct Box { T v; };\ntemplate <class T> using B = Box<T>;\n' +
    'template <class T> using Ptr = T *;\ntemplate <class T, int N> using Arr = T[N];\n' +
    'template <class T> int take(B<T> b) { return 1; }\n' +
    'template <class... Ts> struct L {};\ntemplate <class... Ts> using LL = L<int, Ts...>;\n' +
    'B<int> b; Ptr<char> p; Arr<int, 3> a; LL<char> l;\nint x = b.v + take(b);');
  assert.deepEqual(lines(r, /^VarDecl [bpal] /), ['VarDecl b \'Box<int>\'',
    'VarDecl p \'char *\'', 'VarDecl a \'int [3]\'', 'VarDecl l \'L<int, char>\'']);
  assert.deepEqual(lines(r, /^FunctionDecl take/), ['FunctionDecl take \'int (Box<int>)\'']);
});

test('instantiates member function templates', function () {
  var r = ok('struct S {\n  template <class T> T get(T x) const { return x + k; }\n' +
    '  template <class T> static T make() { return T(); }\n  int k;\n' +
    '  int use() { return get(2) + make<int>(); }\n};\n' +
    'int f() { S s; return s.get(1) + s.template get<int>(2) + s.get<char>(3) + ' +
    'S::make<int>() + (&s)->get(4); }');
  assert.deepEqual(lines(r, /^TemplateDecl/), ['TemplateDecl function get <typename T>',
    'TemplateDecl function make <typename T>']);
  assert.deepEqual(lines(r, /^FunctionDecl (get|make)/), [
    'FunctionDecl get \'int (int) const\' public', 'FunctionDecl make \'int ()\' public',
    'FunctionDecl get \'char (char) const\' public']);
  assert.deepEqual(errorsOf('struct S { int g; };\nint f(S s) { return s.template g<int>(); }'),
    ['\'g\' following the \'template\' keyword does not refer to a template']);
});

test('uses constructor templates and member templates of class templates', function () {
  var r = ok('template <class T> struct W {\n  template <class U> W(U u) : v(u) {}\n' +
    '  W(const W &o) : v(o.v) {}\n  T v;\n  template <class U> U as() const { return U(v); }\n};\n' +
    'W<int> w(2.5); W<int> w2(w); double d = w.as<double>();');
  assert.deepEqual(lines(r, /^ConstructExpr/).slice(0, 2), [
    'ConstructExpr \'W<int>\' prvalue \'void (double)\' user',
    'ConstructExpr \'W<int>\' prvalue \'void (const W<int> &)\' user']);
  assert.deepEqual(lines(r, /^FunctionDecl as/), ['FunctionDecl as \'double () const\' public']);
  ok('struct S { template <class U> struct In { U u; }; template <class U> using P = U *; };\n' +
    'S::In<int> i; S::P<char> p; int x = i.u; char *q = p;');
});
