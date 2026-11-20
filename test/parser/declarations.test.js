'use strict';

var assert = require('assert');
var test = require('../harness').test;
var helper = require('./parse-helper');

var parse = helper.parse;

/** Type of the only top-level declaration, as dumped. */
function typeOf(source) {
  var r = parse(source);
  assert.deepEqual(r.errors, [], source);
  return /'([^']*)'/.exec(r.dump.split('\n')[1])[1];
}

function errorsOf(source) {
  return parse(source).errors;
}

test('combines builtin type specifiers', function () {
  assert.equal(typeOf('unsigned x;'), 'unsigned int');
  assert.equal(typeOf('long int unsigned x;'), 'unsigned long');
  assert.equal(typeOf('signed char x;'), 'signed char');
  assert.equal(typeOf('long long x;'), 'long long');
  assert.equal(typeOf('unsigned long long int x;'), 'unsigned long long');
  assert.equal(typeOf('short unsigned x;'), 'unsigned short');
  assert.equal(typeOf('long double x;'), 'long double');
  assert.equal(typeOf('const volatile int x = 0;'), 'const volatile int');
  assert.equal(typeOf('int const x = 0;'), 'const int');
  assert.deepEqual(errorsOf('long long long x;'), ['\'long long long\' is too long']);
  assert.deepEqual(errorsOf('unsigned double x;'),
    ['cannot combine type specifiers \'unsigned double\'']);
  assert.deepEqual(errorsOf('const x = 1;'),
    ['C++ requires a type specifier for all declarations']);
});

test('builds declarator types inside out', function () {
  assert.equal(typeOf('int *p;'), 'int *');
  assert.equal(typeOf('int *const p = 0;'), 'int *const');
  assert.equal(typeOf('const int **p;'), 'const int **');
  assert.equal(typeOf('int a[2][3];'), 'int [2][3]');
  assert.equal(typeOf('int *a[3];'), 'int *[3]');
  assert.equal(typeOf('int (*a)[3];'), 'int (*)[3]');
  assert.equal(typeOf('int (*fp)(int, double);'), 'int (*)(int, double)');
  assert.equal(typeOf('int (*g(int))(double);'), 'int (*(int))(double)');
  assert.equal(typeOf('void (*table[4])(void);'), 'void (*[4])()');
  assert.equal(typeOf('int &&r = 1;'), 'int &&');
  assert.equal(typeOf('extern int (&ra)[2];'), 'int (&)[2]');
  assert.equal(typeOf('int printf(const char *, ...);'), 'int (const char *, ...)');
  assert.equal(typeOf('auto f(int) -> long;'), 'long (int)');
  assert.equal(typeOf('int f(void);'), 'int ()');
  assert.equal(typeOf('int ((x));'), 'int');
});

test('adjusts parameter types', function () {
  assert.equal(typeOf('void f(int a[3], int g(int), const int c);'),
    'void (int *, int (*)(int), int)');
});

test('reports invalid declarator types', function () {
  assert.deepEqual(errorsOf('int &a[2];'),
    ['\'a\' declared as array of references of type \'int &\'']);
  assert.deepEqual(errorsOf('int &*p;'),
    ['\'p\' declared as a pointer to a reference of type \'int &\'']);
  assert.deepEqual(errorsOf('extern void &r;'), ['cannot form a reference to \'void\'']);
  assert.deepEqual(errorsOf('int f()[3];'), ['function cannot return array type \'int [3]\'']);
  assert.deepEqual(errorsOf('int f()();'), ['function cannot return function type \'int ()\'']);
  assert.deepEqual(errorsOf('void a[2];'), ['array has incomplete element type \'void\'']);
  assert.deepEqual(errorsOf('int a[0];'), ['zero size arrays are not allowed']);
  assert.deepEqual(errorsOf('int a[-1];'), ['array size is negative']);
  assert.deepEqual(errorsOf('void f(void x);'), ['argument may not have \'void\' type']);
  assert.deepEqual(errorsOf('void f(int, void);'),
    ['\'void\' must be the first and only parameter if specified']);
  assert.deepEqual(errorsOf('int f() const;'),
    ['non-member function cannot have \'const\' qualifier']);
  assert.deepEqual(errorsOf('int f() -> int;'),
    ['function with trailing return type must specify return type \'auto\', not \'int\'']);
});

test('handles typedefs and alias declarations', function () {
  var r = parse('typedef int *IntPtr, Arr[3];\nusing F = void (int);\nIntPtr p;\nArr a;\n' +
    'F *fp;\ntypedef int IntPtr2;\ntypedef int IntPtr2;');
  assert.deepEqual(r.errors, []);
  assert.equal(r.dump, [
    'TranslationUnit',
    '  TypedefDecl IntPtr \'int *\'',
    '  TypedefDecl Arr \'int [3]\'',
    '  TypedefDecl F \'void (int)\'',
    '  VarDecl p \'int *\'',
    '  VarDecl a \'int [3]\'',
    '  VarDecl fp \'void (*)(int)\'',
    '  TypedefDecl IntPtr2 \'int\'',
    '  TypedefDecl IntPtr2 \'int\'', ''
  ].join('\n'));
  assert.deepEqual(errorsOf('typedef int T;\ntypedef long T;'),
    ['typedef redefinition with different types (\'long\' vs \'int\')']);
  assert.deepEqual(errorsOf('int T;\ntypedef int T;'),
    ['redefinition of \'T\' as different kind of symbol']);
});

test('checks variable redeclarations', function () {
  assert.deepEqual(errorsOf('extern int x;\nint x;\nextern int x;'), []);
  assert.deepEqual(errorsOf('int x;\nint x;'), ['redefinition of \'x\'']);
  assert.deepEqual(errorsOf('int x;\nlong x;'),
    ['redefinition of \'x\' with a different type: \'long\' vs \'int\'']);
  assert.deepEqual(errorsOf('int x;\nvoid x();'),
    ['redefinition of \'x\' as different kind of symbol']);
  assert.deepEqual(errorsOf('void f() { int a; int a; }'), ['redefinition of \'a\'']);
  assert.deepEqual(errorsOf('void f() { int a; { int a; } }'), []);
  assert.deepEqual(errorsOf('void f(int a) { int a; }'), ['redefinition of \'a\'']);
});

test('requires initializers where C++ does', function () {
  assert.deepEqual(errorsOf('int &r;'),
    ['declaration of reference variable \'r\' requires an initializer']);
  assert.deepEqual(errorsOf('const int c;'),
    ['default initialization of an object of const type \'const int\'']);
  assert.deepEqual(errorsOf('extern const int c;\nextern int &r;'), []);
  assert.deepEqual(errorsOf('void v;'), ['variable has incomplete type \'void\'']);
  assert.deepEqual(errorsOf('int f() = 1;'),
    ['illegal initializer (only variables can be initialized)']);
});

test('records initializer styles', function () {
  var r = parse('int a = 1;\nint b(2);\nint c{3};\nint d = {4};\nint e[] = {1, 2};');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.dump.split('\n').filter(function (l) {
    return /VarDecl/.test(l);
  }), ['  VarDecl a \'int\' copy-init', '  VarDecl b \'int\' direct-init',
    '  VarDecl c \'int\' list-init', '  VarDecl d \'int\' copy-init',
    '  VarDecl e \'int [2]\' copy-init']);
});

test('overloads and redeclares functions', function () {
  var r = parse('int f(int);\nint f(double);\nint f(int a);\nint f(int a) { return a; }');
  assert.deepEqual(r.errors, []);
  assert.equal(r.unit.decls.length, 4);
  assert.strictEqual(r.unit.decls[2].previous, r.unit.decls[0]);
  assert.strictEqual(r.unit.decls[3].previous, r.unit.decls[2]);
  assert.deepEqual(errorsOf('int f();\nlong f();'),
    ['functions that differ only in their return type cannot be overloaded']);
  assert.deepEqual(errorsOf('int f() { return 1; }\nint f() { return 2; }'),
    ['redefinition of \'f\'']);
  assert.deepEqual(errorsOf('void f(int a, int a);'), ['redefinition of parameter \'a\'']);
  assert.deepEqual(errorsOf('void f(int x[3]);\nvoid f(int *x);\nvoid f(const int);\n' +
    'void f(int);'), []);
});

test('merges default arguments', function () {
  assert.deepEqual(errorsOf('void f(int, int = 2);\nvoid f(int = 1, int);'), []);
  assert.deepEqual(errorsOf('void f(int = 1);\nvoid f(int = 1);'),
    ['redefinition of default argument']);
});

test('checks main', function () {
  assert.deepEqual(errorsOf('int main() { return 0; }'), []);
  assert.deepEqual(errorsOf('int main(int argc, char **argv) { return 0; }'), []);
  assert.deepEqual(errorsOf('void main() {}'), ['\'main\' must return \'int\'']);
  assert.deepEqual(errorsOf('inline int main() { return 0; }'),
    ['\'main\' is not allowed to be declared inline']);
  assert.deepEqual(errorsOf('static int main() { return 0; }'),
    ['\'main\' is not allowed to be declared static']);
});

test('checks return statements', function () {
  assert.deepEqual(errorsOf('void f() { return 1; }'),
    ['void function \'f\' should not return a value']);
  assert.deepEqual(errorsOf('int f() { return; }'),
    ['non-void function \'f\' should return a value']);
  assert.deepEqual(errorsOf('void g();\nvoid f() { return; }'), []);
});

test('types literals with ILP32 rules', function () {
  var r = parse('long long a = 2147483648;\nunsigned b = 0x80000000;\nlong c = 2147483647L;\n' +
    'long long d = 0xffffffffL;\nunsigned long long e = 1ull;\nchar f = \'x\';\n' +
    'wchar_t g = L\'x\';\ndouble h = 1.5;\nfloat i = 1.5f;\nlong double j = 1.5L;\n' +
    'bool k = true;\nint m = \'ab\';');
  var types = r.dump.split('\n').filter(function (l) {
    return /Literal/.test(l);
  }).map(function (l) {
    return /'([^']*)'/.exec(l)[1];
  });
  assert.deepEqual(types, ['long long', 'unsigned int', 'long', 'unsigned long',
    'unsigned long long', 'char', 'wchar_t', 'double', 'float', 'long double', 'bool', 'int']);
  assert.deepEqual(parse('unsigned long long x = 18446744073709551615;').warnings,
    ['integer literal is too large to be represented in a signed integer type, ' +
      'interpreting as unsigned']);
});

test('types string literals as const arrays', function () {
  var r = parse('const char *s = "abc";\nconst char16_t *u = u"\\u00e9";\n' +
    'const char *t = "\\u00e9";');
  assert.deepEqual(r.dump.split('\n').filter(function (l) {
    return /StringLiteral/.test(l);
  }).map(function (l) { return l.trim(); }), ['StringLiteral \'const char [4]\' "abc"',
    'StringLiteral \'const char16_t [2]\' "\\xe9"',
    'StringLiteral \'const char [3]\' "\\xc3\\xa9"']);
});

test('resolves names and reports undeclared ones', function () {
  var r = parse('int a = 1;\nint b = a;\nint c = missing;');
  assert.deepEqual(r.errors, ['use of undeclared identifier \'missing\'']);
  assert.ok(/DeclRefExpr a 'int' lvalue/.test(r.dump));
});

test('recovers from syntax errors', function () {
  var r = parse('int a = 1\nint b;\nint 3;\nint d;\nfoo e;\nint f;\n}\nint g;');
  assert.deepEqual(r.errors, ['expected \';\' after top level declarator',
    'expected unqualified-id', 'unknown type name \'foo\'', 'extraneous closing brace (\'}\')']);
  // A `;` missing at the end of a line is taken as present.
  assert.ok(/VarDecl b 'int'/.test(r.dump));
  assert.ok(/VarDecl d 'int'/.test(r.dump));
  assert.ok(/VarDecl f 'int'/.test(r.dump));
  assert.ok(/VarDecl g 'int'/.test(r.dump));
});

test('rejects nested function definitions', function () {
  assert.deepEqual(errorsOf('void f() { void g() {} }'),
    ['function definition is not allowed here']);
});

test('reports expected tokens at the end of the previous line', function () {
  var r = parse('int a = 1\nint b;');
  var d = r.bag.getAll()[0];
  assert.equal(d.start, 9);
});

test('recovers from missing semicolons like Clang', function () {
  var r = parse('struct S { int a; }\nint f() { int x = 1\n  return x; }\n' +
    'enum E { e1 }\nstruct O { int m\n};\ntemplate <class T> struct X { T v; }\nint y;');
  assert.deepEqual(r.errors, ['expected \';\' after struct', 'expected \';\' at end of declaration',
    'expected \';\' after enum', 'expected \';\' at end of declaration list',
    'expected \';\' after struct']);
  assert.deepEqual(r.warnings, []);
  assert.ok(/FunctionDecl f 'int \(\)'/.test(r.dump));
  assert.ok(/VarDecl y 'int'/.test(r.dump));
});

test('reports unknown type names and stray tokens', function () {
  assert.deepEqual(errorsOf('int f(bar b) { foo y = 3; return y; }'),
    ['unknown type name \'bar\'', 'unknown type name \'foo\'']);
  assert.deepEqual(errorsOf('int f(int a, ) { return a; }'), ['expected parameter declarator']);
  // No `does not return a value` warning after an error in the body.
  assert.deepEqual(parse('int f() { return (1 + ; }').warnings, []);
});
