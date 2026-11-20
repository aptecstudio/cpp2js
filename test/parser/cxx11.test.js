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

/** Declared types of the variables, as dumped. */
function varTypes(r) {
  return r.dump.split('\n').filter(function (l) { return /VarDecl/.test(l); })
    .map(function (l) { return /VarDecl (\S+) '([^']*)'/.exec(l).slice(1, 3).join(': '); });
}

test('deduces auto like template arguments', function () {
  var r = ok('const int ci = 1;\nint i;\nint arr[3];\nint g();\nauto a = 1;\n' +
    'auto b = 2.5f, *pb = &b;\nconst auto c = g();\nauto &r = ci;\nconst auto &cr = i;\n' +
    'auto &&fw = i;\nauto &&fr = 3;\nauto p = arr;\nauto fp = g;\nauto d{7};\n' +
    'const auto *pc = &ci;\nauto *pci = &ci;\nauto copy = ci;');
  assert.deepEqual(varTypes(r).slice(3), ['a: int', 'b: float', 'pb: float *', 'c: const int',
    'r: const int &', 'cr: const int &', 'fw: int &', 'fr: int &&', 'p: int *',
    'fp: int (*)()', 'd: int', 'pc: const int *', 'pci: const int *', 'copy: int']);
});

test('reports invalid uses of auto', function () {
  assert.deepEqual(errorsOf('auto none;'),
    ['declaration of variable \'none\' with deduced type \'auto\' requires an initializer']);
  assert.deepEqual(errorsOf('auto x = 1, y = 2.0;'),
    ['\'auto\' deduced as \'int\' in declaration of \'x\' and deduced as \'double\' in ' +
      'declaration of \'y\'']);
  assert.deepEqual(errorsOf('auto il = {1, 2};'), ['deducing \'auto\' from a braced initializer ' +
    'list requires std::initializer_list, which is not supported yet']);
  assert.deepEqual(errorsOf('auto *bad = 3;'),
    ['variable \'bad\' with type \'auto *\' has incompatible initializer of type \'int\'']);
  assert.deepEqual(errorsOf('void f(auto x);'), ['\'auto\' not allowed in function prototype']);
  assert.deepEqual(errorsOf('struct S { auto x = 1; };'),
    ['\'auto\' not allowed in non-static class member']);
  assert.deepEqual(errorsOf('typedef auto T;'), ['\'auto\' not allowed in typedef']);
  assert.deepEqual(errorsOf('auto f();'), ['\'auto\' return without trailing return type; ' +
    'deduced return types are a C++14 extension']);
  assert.deepEqual(errorsOf('void v();\nauto x = v();'),
    ['variable \'x\' has incomplete type \'void\'']);
  ok('auto f(int x) -> long { return x; }\nint g() { if (auto v = f(1)) { return 1; } ' +
    'return 0; }');
});

test('computes decltype', function () {
  var r = ok('int a;\nint &h();\nint g();\nint &&m();\nstruct S { double d; };\nS s;\n' +
    'decltype(a) da = 0;\ndecltype((a)) dra = a;\ndecltype(h()) dh = a;\ndecltype(g()) dg = 0;\n' +
    'decltype(m()) dm = 1;\ndecltype(s.d) sd = 0;\ndecltype((s.d)) rsd = s.d;\n' +
    'auto add(int x, long y) -> decltype(x + y);');
  assert.deepEqual(varTypes(r).slice(2), ['da: int', 'dra: int &', 'dh: int &', 'dg: int',
    'dm: int &&', 'sd: double', 'rsd: double &']);
  assert.ok(/FunctionDecl add 'long \(int, long\)'/.test(r.dump));
});

test('checks static assertions', function () {
  ok('static_assert(sizeof(int) == 4, "int is 32-bit");\nstruct S { int x; ' +
    'static_assert(sizeof(int) == 4, "in class"); };\nvoid f() { static_assert(true, "x"); }');
  assert.deepEqual(errorsOf('static_assert(sizeof(long) == 8, "long is 64-bit");'),
    ['static assertion failed: long is 64-bit']);
  assert.deepEqual(errorsOf('int n = 1;\nstatic_assert(n == 1, "n");'),
    ['static_assert expression is not an integral constant expression']);
  assert.deepEqual(parse('static_assert(true);').warnings,
    ['static_assert with no message is a C++17 extension']);
});

test('expands range-based for over arrays and classes', function () {
  var r = ok('struct List { int data[4]; int *begin() { return data; } ' +
    'int *end() { return data + 4; } };\nnamespace geo { struct Path { int p[2]; }; ' +
    'int *begin(Path &); int *end(Path &); }\nint f() {\n  int arr[3] = {1, 2, 3};\n' +
    '  int total = 0;\n  for (int x : arr) total += x;\n  for (auto &x : arr) x = 0;\n' +
    '  List l;\n  for (const auto &v : l) total += v;\n  geo::Path p;\n' +
    '  for (int q : p) { if (q) continue; break; }\n  return total;\n}');
  assert.deepEqual(r.dump.split('\n').filter(function (l) {
    return /RangeFor|VarDecl (__|x|v|q)/.test(l);
  }).map(function (l) { return l.trim(); }), [
    'RangeForStmt', 'VarDecl __range \'int (&)[3]\' copy-init',
    'VarDecl __begin \'int *\' copy-init', 'VarDecl __end \'int *\' copy-init',
    'VarDecl x \'int\' copy-init',
    'RangeForStmt', 'VarDecl __range \'int (&)[3]\' copy-init',
    'VarDecl __begin \'int *\' copy-init', 'VarDecl __end \'int *\' copy-init',
    'VarDecl x \'int &\' copy-init',
    'RangeForStmt', 'VarDecl __range \'List &\' copy-init',
    'VarDecl __begin \'int *\' copy-init', 'VarDecl __end \'int *\' copy-init',
    'VarDecl v \'const int &\' copy-init',
    'RangeForStmt', 'VarDecl __range \'geo::Path &\' copy-init',
    'VarDecl __begin \'int *\' copy-init', 'VarDecl __end \'int *\' copy-init',
    'VarDecl q \'int\' copy-init']);
});

test('reports invalid ranges', function () {
  assert.deepEqual(errorsOf('void f(int n) { for (int z : n) {} }'),
    ['invalid range expression of type \'int\'; no viable \'begin\' function available']);
  assert.deepEqual(errorsOf('void f() { for (int w : {1, 2}) {} }'),
    ['iterating over a braced initializer list requires std::initializer_list, which is not ' +
      'supported yet']);
  assert.deepEqual(errorsOf('extern int a[];\nvoid f() { for (int x : a) {} }'),
    ['cannot use incomplete type \'int []\' as a range']);
  assert.deepEqual(errorsOf('void f() { int a[2]; for (int *x : a) {} }'),
    ['cannot initialize a variable of type \'int *\' with an lvalue of type \'int\'']);
});

test('builds closures and call operators', function () {
  var r = ok('int main() {\n  int base = 10, hits = 0;\n' +
    '  auto add = [base](int x) { return x + base; };\n' +
    '  auto count = [&hits]() mutable { ++hits; };\n' +
    '  auto both = [&](int y) -> long { hits += y; return base; };\n' +
    '  return add(1) + both(2);\n}');
  assert.deepEqual(r.dump.split('\n').filter(function (l) {
    return /LambdaExpr|LambdaCapture|captured/.test(l);
  }).map(function (l) { return l.trim(); }), [
    'LambdaExpr \'(lambda at t.cpp:3:14)\' prvalue \'int\'', 'LambdaCapture base',
    'DeclRefExpr base \'const int\' lvalue captured-copy',
    'LambdaExpr \'(lambda at t.cpp:4:16)\' prvalue \'void\' mutable', 'LambdaCapture &hits',
    'DeclRefExpr hits \'int\' lvalue captured-ref',
    'LambdaExpr \'(lambda at t.cpp:5:15)\' prvalue \'long\' [&]', 'LambdaCapture &hits',
    'LambdaCapture &base', 'DeclRefExpr hits \'int\' lvalue captured-ref',
    'DeclRefExpr base \'int\' lvalue captured-ref']);
});

test('converts captureless lambdas to function pointers', function () {
  ok('int apply(int (*fn)(int), int v) { return fn(v); }\n' +
    'int f() { return apply([](int x) { return x * 2; }, 3); }');
  assert.deepEqual(errorsOf('int apply(int (*fn)(int), int v);\n' +
    'int f(int k) { return apply([k](int x) { return x * k; }, 3); }'),
    ['cannot initialize a parameter of type \'int (*)(int)\' with an rvalue of type ' +
      '\'(lambda at t.cpp:2:29)\'']);
});

test('captures this in member functions', function () {
  ok('struct C { int n = 0; void bump() { auto f = [this] { n++; }; f(); ' +
    'auto g = [=] { return n; }; g(); } };');
  assert.deepEqual(errorsOf('struct C { int n; void f() { [] { return n; }; } };'),
    ['\'this\' cannot be implicitly captured in this context']);
  assert.deepEqual(errorsOf('void f() { [this] {}; }'),
    ['invalid use of \'this\' outside of a non-static member function']);
});

test('checks captures', function () {
  assert.deepEqual(errorsOf('int f(int base) { auto l = [](int x) { return x + base; }; ' +
    'return l(1); }'),
    ['variable \'base\' cannot be implicitly captured in a lambda with no capture-default ' +
      'specified']);
  assert.deepEqual(errorsOf('void f(int b) { [b]() { b = 1; }; }'),
    ['cannot assign to a variable captured by copy in a non-mutable lambda']);
  ok('void f(int b) { [b]() mutable { b = 1; }; [&b]() { b = 2; }; }');
  assert.deepEqual(errorsOf('void f(int b) { [b, b] {}; }'),
    ['\'b\' can appear only once in a capture list']);
  assert.deepEqual(errorsOf('void f(int b) { [=, b] {}; }'),
    ['\'&\' must precede a capture when the capture default is \'=\'']);
  assert.deepEqual(errorsOf('void f(int b) { [&, &b] {}; }'),
    ['\'&\' cannot precede a capture when the capture default is \'&\'']);
  assert.deepEqual(errorsOf('int g;\nvoid f() { [g] {}; }'),
    ['\'g\' cannot be captured because it does not have automatic storage duration']);
  ok('int g;\nvoid f() { static int s; [] { return g + s; }; }');
  ok('void f(int a) { [=] { [=] { return a; }; }; [&] { [a] { return a; }; }; }');
  assert.deepEqual(errorsOf('void f(int a) { [] { [=] { return a; }; }; }'),
    ['variable \'a\' cannot be implicitly captured in a lambda with no capture-default ' +
      'specified']);
});

test('deduces lambda return types', function () {
  assert.deepEqual(errorsOf('void f() { [](bool b) { if (b) return 1; return 2.5; }; }'),
    ['return type \'double\' must match previous return type \'int\' when lambda expression ' +
      'has unspecified explicit return type']);
  ok('void f() { [](bool b) -> double { if (b) return 1; return 2.5; }; ' +
    '[](bool b) { if (b) return 1; return 2; }; }');
  assert.deepEqual(errorsOf('void f() { while (true) { [] { break; }; } }'),
    ['\'break\' statement not in loop or switch statement']);
});
