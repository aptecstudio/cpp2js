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
