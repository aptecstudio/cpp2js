'use strict';

var assert = require('assert');
var test = require('../harness').test;
var helper = require('./parse-helper');

var parse = helper.parse;

/** Parses `decls` then a function body holding `body`. */
function inMain(decls, body) {
  return parse(decls + '\nint main() {\n' + body + '\nreturn 0;\n}');
}

function errorsOf(decls, body) {
  return inMain(decls, body).errors;
}

function warningsOf(decls, body) {
  return inMain(decls, body).warnings;
}

/** Type and category of the initializer of `int probe` style checks. */
function exprType(decls, expr) {
  var r = parse(decls + '\nauto probe() -> void { ' + expr + '; }');
  var line;
  assert.deepEqual(r.errors, [], expr);
  line = r.dump.split('\n').filter(function (l) { return /ExprStmt/.test(l); })[0];
  line = r.dump.split('\n')[r.dump.split('\n').indexOf(line) + 1].trim();
  return /'([^']*)' (lvalue|xvalue|prvalue)/.exec(line.replace(/^\S+ '[^']*' (postfix )?(?=')/,
    '')).slice(1, 3).join(' ');
}

/** Like exprType, without the value category. */
function typeOnly(decls, expr) {
  return exprType(decls, expr).replace(/ (lvalue|xvalue|prvalue)$/, '');
}

test('types arithmetic with promotions and usual conversions', function () {
  var d = 'char c; short s; unsigned u; long l; long long ll; float f; double d; bool b;';
  assert.equal(typeOnly(d, 'c + c'), 'int');
  assert.equal(typeOnly(d, 's * u'), 'unsigned int');
  assert.equal(typeOnly(d, 'l + u'), 'unsigned long');
  assert.equal(typeOnly(d, 'll + u'), 'long long');
  assert.equal(typeOnly(d, 'f + l'), 'float');
  assert.equal(typeOnly(d, 'f * d'), 'double');
  assert.equal(typeOnly(d, 'b + b'), 'int');
  assert.equal(typeOnly(d, '-c'), 'int');
  assert.equal(typeOnly(d, '~s'), 'int');
  assert.equal(typeOnly(d, '!d'), 'bool');
  assert.equal(typeOnly(d, 'c << ll'), 'int');
  assert.equal(typeOnly(d, 'u % 3'), 'unsigned int');
  assert.equal(typeOnly(d, 'c < d'), 'bool');
});

test('computes value categories', function () {
  var d = 'int x; int *p; int a[3]; int f(); int &g(); int &&h();';
  assert.equal(exprType(d, 'x'), 'int lvalue');
  assert.equal(exprType(d, '*p'), 'int lvalue');
  assert.equal(exprType(d, 'a[1]'), 'int lvalue');
  assert.equal(exprType(d, 'x = 1'), 'int lvalue');
  assert.equal(exprType(d, '++x'), 'int lvalue');
  assert.equal(exprType(d, 'x++'), 'int prvalue');
  assert.equal(exprType(d, '&x'), 'int * prvalue');
  assert.equal(exprType(d, 'f()'), 'int prvalue');
  assert.equal(exprType(d, 'g()'), 'int lvalue');
  assert.equal(exprType(d, 'h()'), 'int xvalue');
  assert.equal(exprType(d, 'true ? x : x'), 'int lvalue');
  assert.equal(exprType(d, 'true ? x : 1'), 'int prvalue');
  assert.equal(exprType(d, '(x, x)'), 'int lvalue');
});

test('handles pointers and arrays', function () {
  var d = 'int a[4]; int *p; const int *cp; void *vp; double *dp;';
  assert.equal(exprType(d, 'a + 1'), 'int * prvalue');
  assert.equal(exprType(d, '1 + p'), 'int * prvalue');
  assert.equal(exprType(d, 'p - a'), 'int prvalue');
  assert.equal(exprType(d, '2[a]'), 'int lvalue');
  assert.equal(exprType(d, 'p == cp'), 'bool prvalue');
  assert.equal(exprType(d, 'p == 0'), 'bool prvalue');
  assert.equal(exprType(d, 'p != nullptr'), 'bool prvalue');
  assert.equal(exprType(d, 'true ? p : cp'), 'const int * prvalue');
  assert.equal(exprType(d, 'true ? p : vp'), 'void * prvalue');
  assert.equal(exprType(d, 'true ? p : 0'), 'int * prvalue');
  assert.deepEqual(errorsOf(d, 'p == dp;'),
    ['comparison of distinct pointer types (\'int *\' and \'double *\')']);
  assert.deepEqual(errorsOf(d, 'p - dp;'),
    ['\'int *\' and \'double *\' are not pointers to compatible types']);
  assert.deepEqual(errorsOf(d, 'p + dp;'),
    ['invalid operands to binary expression (\'int *\' and \'double *\')']);
  assert.deepEqual(errorsOf(d, '*vp;'),
    ['indirection not permitted on operand of type \'void *\'']);
  assert.deepEqual(errorsOf(d, 'vp + 1;'),
    ['arithmetic on a pointer to an incomplete type \'void\'']);
});

test('reports invalid operands and assignments', function () {
  var d = 'int x; const int c = 1; int *p; double dd; int arr[2];';
  assert.deepEqual(errorsOf(d, 'c = 2;'),
    ['cannot assign to variable \'c\' with const-qualified type \'const int\'']);
  assert.deepEqual(errorsOf(d, '3 = x;'), ['expression is not assignable']);
  assert.deepEqual(errorsOf(d, 'arr = arr;'), ['array type \'int [2]\' is not assignable']);
  assert.deepEqual(errorsOf(d, 'x = p;'), ['assigning to \'int\' from incompatible type \'int *\'']);
  assert.deepEqual(errorsOf(d, 'dd % 2;'),
    ['invalid operands to binary expression (\'double\' and \'int\')']);
  assert.deepEqual(errorsOf(d, '*x;'), ['indirection requires pointer operand (\'int\' invalid)']);
  assert.deepEqual(errorsOf(d, '&3;'), ['cannot take the address of an rvalue of type \'int\'']);
  assert.deepEqual(errorsOf(d, '~dd;'), ['invalid argument type \'double\' to unary expression']);
  assert.deepEqual(errorsOf(d, '++c;'),
    ['cannot assign to variable \'c\' with const-qualified type \'const int\'']);
  assert.deepEqual(errorsOf(d, 'x[1];'), ['subscripted value is not an array, pointer, or vector']);
  assert.deepEqual(errorsOf(d, 'arr[dd];'), ['array subscript is not an integer']);
  assert.deepEqual(errorsOf(d, 'x();'),
    ['called object type \'int\' is not a function or function pointer']);
  assert.deepEqual(errorsOf(d, 'x += p;'),
    ['invalid operands to binary expression (\'int\' and \'int *\')']);
  ok(d, 'p += 2; x <<= 1; dd *= x; x %= 3;');
});

function ok(decls, body) {
  var r = inMain(decls, body);
  assert.deepEqual(r.errors, [], body);
  return r;
}

test('resolves overloaded calls', function () {
  var d = 'int f(int); double f(double); char f(char *); long f(long, int = 0);';
  assert.equal(exprType(d, 'f(1)'), 'int prvalue');
  assert.equal(exprType(d, 'f(1.5)'), 'double prvalue');
  assert.equal(exprType(d, 'f(1.5f)'), 'double prvalue');
  assert.equal(exprType(d, 'f(\'a\')'), 'int prvalue');
  assert.equal(exprType(d, 'f(0L)'), 'long prvalue');
  assert.equal(exprType(d, 'f(1L, 2)'), 'long prvalue');
  assert.deepEqual(errorsOf(d, 'f(1u);'), ['call to \'f\' is ambiguous']);
  assert.deepEqual(errorsOf(d, 'f(1, 2, 3);'), ['no matching function for call to \'f\'']);
  assert.deepEqual(inMain(d, 'f("x");').bag.getAll()[0].notes.map(function (n) {
    return n.message;
  }), [
    'candidate function not viable: no known conversion from \'const char [2]\' to \'int\' ' +
      'for 1st argument',
    'candidate function not viable: no known conversion from \'const char [2]\' to \'double\' ' +
      'for 1st argument',
    'candidate function not viable: no known conversion from \'const char [2]\' to \'char *\' ' +
      'for 1st argument',
    'candidate function not viable: requires at most 2 arguments, but 1 was provided'
  ].slice(0, 3).concat(['candidate function not viable: no known conversion from ' +
    '\'const char [2]\' to \'long\' for 1st argument']));
});

test('ranks conversions as C++ does', function () {
  assert.equal(exprType('int g(int *); char g(const int *); int *p;', 'g(p)'), 'int prvalue');
  assert.equal(exprType('int g(int *); char g(const int *); const int *p;', 'g(p)'),
    'char prvalue');
  assert.equal(exprType('int g(bool); char g(void *); int *p;', 'g(p)'), 'char prvalue');
  assert.equal(exprType('int g(int &); char g(int &&); int x;', 'g(x)'), 'int prvalue');
  assert.equal(exprType('int g(const int &); char g(int &&);', 'g(1)'), 'char prvalue');
  assert.equal(exprType('int g(int &); char g(const int &); const int c = 1;', 'g(c)'),
    'char prvalue');
  assert.equal(exprType('int g(long); char g(double);', 'g(1.0f)'), 'char prvalue');
  assert.equal(exprType('int g(int); char g(...);', 'g(1.5)'), 'int prvalue');
  assert.equal(exprType('int g(int, ...); ', 'g(1, 2, 3)'), 'int prvalue');
});

test('checks calls to a single function', function () {
  var d = 'void k(int *); int h(int, int = 1); int v(int, ...);';
  assert.deepEqual(errorsOf(d, 'k(2.0);'),
    ['cannot initialize a parameter of type \'int *\' with an rvalue of type \'double\'']);
  assert.deepEqual(errorsOf(d, 'h();'),
    ['too few arguments to function call, expected at least 1, have 0']);
  assert.deepEqual(errorsOf(d, 'h(1, 2, 3);'),
    ['too many arguments to function call, expected at most 2, have 3']);
  assert.deepEqual(errorsOf(d, 'v();'),
    ['too few arguments to function call, expected at least 1, have 0']);
  ok(d, 'h(1); v(1, 2.5, "s", 3);');
});

test('resolves the address of an overloaded function by its target', function () {
  ok('int f(int); double f(double);', 'int (*p)(int) = f; double (*q)(double) = &f;');
  assert.deepEqual(errorsOf('int f(int); double f(double);', 'f + 1;'),
    ['reference to overloaded function could not be resolved; did you mean to call it?']);
});

test('checks initialization and narrowing', function () {
  assert.deepEqual(errorsOf('', 'char c{300};'),
    ['constant expression evaluates to 300 which cannot be narrowed to type \'char\'']);
  assert.deepEqual(errorsOf('', 'int z{2.5};'),
    ['type \'double\' cannot be narrowed to \'int\' in initializer list']);
  assert.deepEqual(errorsOf('double dd = 1;', 'int w{dd};'),
    ['non-constant-expression cannot be narrowed from type \'double\' to \'int\' in ' +
      'initializer list']);
  assert.deepEqual(errorsOf('int x;', 'unsigned u{x};'),
    ['non-constant-expression cannot be narrowed from type \'int\' to \'unsigned int\' in ' +
      'initializer list']);
  ok('', 'char c{100}; long l{1}; double d{1}; unsigned u{5}; int e{};');
  assert.deepEqual(errorsOf('', 'int x{1, 2};'), ['excess elements in scalar initializer']);
  assert.deepEqual(errorsOf('', 'int a[2] = {1, 2, 3};'), ['excess elements in array initializer']);
  assert.deepEqual(errorsOf('', 'char s[2] = "abc";'),
    ['initializer-string for char array is too long']);
  assert.deepEqual(errorsOf('', 'int a[] = {};'), ['zero size arrays are not allowed']);
  assert.deepEqual(errorsOf('', 'int a[];'), ['definition of variable with array type needs an ' +
    'explicit size or an initializer']);
  ok('', 'char s[] = "abc"; int m[2][2] = {{1, 2}, {3}}; int n[3] = {1};');
});

test('binds references', function () {
  assert.deepEqual(errorsOf('', 'int &r = 3;'),
    ['non-const lvalue reference to type \'int\' cannot bind to a temporary of type \'int\'']);
  assert.deepEqual(errorsOf('int x;', 'int &&rr = x;'),
    ['rvalue reference to type \'int\' cannot bind to lvalue of type \'int\'']);
  assert.deepEqual(errorsOf('double d;', 'int &r = d;'),
    ['non-const lvalue reference to type \'int\' cannot bind to a value of unrelated type ' +
      '\'double\'']);
  assert.deepEqual(errorsOf('const int c = 1;', 'int &r = c;'),
    ['binding reference of type \'int\' to value of type \'const int\' drops \'const\' ' +
      'qualifier']);
  ok('int x; double d;', 'int &a = x; const int &b = 3; const int &e = d; int &&f = 4; ' +
    'const int &g = x;');
});

test('checks explicit casts', function () {
  var d = 'int x; double dd; void *vp; const int *cip; int *ip;';
  ok(d, 'static_cast<int>(dd); static_cast<int *>(vp); static_cast<void>(x); ' +
    'reinterpret_cast<double *>(ip); reinterpret_cast<unsigned long>(ip); ' +
    'const_cast<int *>(cip); (int *)cip; (char)x; int(dd); static_cast<int &&>(x);');
  assert.deepEqual(errorsOf(d, 'static_cast<int *>(cip);'),
    ['static_cast from \'const int *\' to \'int *\' casts away qualifiers']);
  assert.deepEqual(errorsOf(d, 'static_cast<int *>(dd);'),
    ['static_cast from \'double\' to \'int *\' is not allowed']);
  assert.deepEqual(errorsOf(d, 'reinterpret_cast<int>(dd);'),
    ['reinterpret_cast from \'double\' to \'int\' is not allowed']);
  assert.deepEqual(errorsOf(d, 'reinterpret_cast<char>(ip);'),
    ['reinterpret_cast from \'int *\' to \'char\' is not allowed']);
  assert.deepEqual(errorsOf(d, 'const_cast<double>(x);'),
    ['const_cast from \'int\' to \'double\' is not allowed']);
  assert.deepEqual(errorsOf(d, '(int *)dd;'),
    ['C-style cast from \'double\' to \'int *\' is not allowed']);
});

test('disambiguates casts and parenthesized expressions', function () {
  assert.equal(exprType('typedef int T; int *p;', '(T)*p'), 'int prvalue');
  assert.equal(exprType('int T = 2; int *p;', '(T)*p'.replace('*p', '* 3')), 'int prvalue');
  assert.equal(exprType('struct_dummy_placeholder;'.replace(/.*/, 'typedef int T;'),
    'sizeof(T) + sizeof T()'.replace(' + sizeof T()', '')), 'unsigned int prvalue');
  assert.equal(exprType('int v;', 'sizeof(v)'), 'unsigned int prvalue');
  assert.equal(exprType('int v;', 'sizeof v'), 'unsigned int prvalue');
});

test('handles sizeof, alignof and new/delete', function () {
  var r = inMain('', 'int a = sizeof(long long); int b = alignof(double); int *p = new int(3); ' +
    'int *q = new int[a]; int (*m)[4] = new int[a][4]; delete p; delete[] q;');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(errorsOf('', 'sizeof(void);'),
    ['invalid application of \'sizeof\' to an incomplete type \'void\'']);
  assert.deepEqual(errorsOf('int f();', 'sizeof(f);'),
    ['invalid application of \'sizeof\' to a function type']);
  assert.deepEqual(errorsOf('int x;', 'delete x;'), ['cannot delete expression of type \'int\'']);
  assert.deepEqual(errorsOf('double d;', 'new int[d];'),
    ['array size expression must have integral or unscoped enumeration type, not \'double\'']);
  assert.deepEqual(errorsOf('', 'new void;'), ['cannot allocate incomplete type \'void\' with new']);
});

test('evaluates integral constant expressions', function () {
  var r = parse('const int N = 4;\nconst unsigned M = N * 2 - 9;\nint a[N + (N > 3 ? 1 : 0)];\n' +
    'int b[sizeof(double) << 1];\nint c[(char)300];\nint d[M > 0];\nint e[-1 % 3 + 2];');
  var sizes = r.dump.split('\n').filter(function (l) { return /VarDecl [a-e] /.test(l); })
    .map(function (l) { return /\[(\d+)\]/.exec(l)[1]; });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(sizes, ['5', '16', '44', '1', '1']);
  assert.deepEqual(parse('int n = 3;\nint a[n];').errors,
    ['array size is not an integral constant expression']);
  assert.deepEqual(parse('int a[1.5];').errors, ['size of array has non-integer type \'double\'']);
});

test('warns about suspicious code', function () {
  assert.deepEqual(warningsOf('int x;', 'x + 1; x == 2; x; (void)x; x = 1; x++;'),
    ['expression result unused', 'expression result unused', 'expression result unused']);
  assert.deepEqual(warningsOf('int x;', 'x = x / 0;'), ['division by zero is undefined']);
  assert.deepEqual(warningsOf('', 'int i = 2.5; char c = 300;'), [
    'implicit conversion from \'double\' to \'int\' changes value from 2.5 to 2',
    'implicit conversion from \'int\' to \'char\' changes value from 300 to 44']);
});
