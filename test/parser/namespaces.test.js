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

/** Dump lines matching a pattern. */
function lines(r, pattern) {
  return r.dump.split('\n').filter(function (l) { return pattern.test(l); })
    .map(function (l) { return l.trim(); });
}

test('declares and reopens namespaces', function () {
  var r = ok('namespace a { int x; }\nnamespace a { int y = x; }\nint z = a::x + 0 ? 0 : a::y;'
    .replace(' + 0 ? 0 : a::y', ''));
  assert.deepEqual(lines(r, /NamespaceDecl/), ['NamespaceDecl a', 'NamespaceDecl a reopened']);
  assert.strictEqual(r.unit.decls[1].previous, r.unit.decls[0]);
  assert.strictEqual(r.unit.decls[1].scope, r.unit.decls[0].scope);
});

test('resolves qualified and global names', function () {
  var r = ok('int v = 1;\nnamespace a { int v = 2; namespace b { int v = 3; int w = ::v; ' +
    'int u = a::v; } }\nint t = a::b::v;\ntypedef int I;\nnamespace a { typedef long I; }\n' +
    '::I i1;\na::I i2;');
  assert.deepEqual(lines(r, /VarDecl (w|u|t|i1|i2)/), ['VarDecl w \'int\' copy-init',
    'VarDecl u \'int\' copy-init', 'VarDecl t \'int\' copy-init', 'VarDecl i1 \'int\'',
    'VarDecl i2 \'long\'']);
  assert.strictEqual(r.unit.decls[1].decls[1].decls[1].init.operand.decl, r.unit.decls[0]);
});

test('supports namespace aliases', function () {
  var r = ok('namespace very { namespace deep { int x; } }\nnamespace vd = very::deep;\n' +
    'namespace vd = very::deep;\nint y = vd::x;');
  // Each occurrence is an AST node; the repeated alias is accepted.
  assert.deepEqual(lines(r, /Alias/), ['NamespaceAliasDecl vd -> deep',
    'NamespaceAliasDecl vd -> deep']);
  assert.deepEqual(errorsOf('namespace a {}\nnamespace b {}\nnamespace x = a;\nnamespace x = b;'),
    ['redefinition of \'x\'']);
  assert.deepEqual(errorsOf('int n;\nnamespace x = n;'), ['expected namespace name']);
});

test('applies using-directives and using-declarations', function () {
  ok('namespace std { int cout; }\nusing namespace std;\nint a = cout;');
  ok('namespace std { int cout; }\nvoid f() { using namespace std; int a = cout; }');
  ok('namespace std { int swap(int); int swap(double); }\nusing std::swap;\nint (*p)(int);');
  assert.deepEqual(errorsOf('namespace std { int cout; }\nvoid f() { using namespace std; }\n' +
    'int a = cout;'), ['use of undeclared identifier \'cout\'']);
  assert.deepEqual(errorsOf('namespace a { int i; }\nint i;\nusing namespace a;\nint j = i;'),
    ['reference to \'i\' is ambiguous']);
  assert.deepEqual(errorsOf('namespace a {}\nusing a::missing;'),
    ['no member named \'missing\' in namespace \'a\'']);
  assert.deepEqual(errorsOf('namespace a { namespace b {} }\nusing a::b;'),
    ['using declaration cannot refer to a namespace']);
  assert.deepEqual(errorsOf('int x;\nusing x;'), ['using declaration requires a qualified name']);
});

test('handles unnamed and inline namespaces', function () {
  ok('namespace { int hidden; }\nint h = hidden;');
  ok('namespace lib { inline namespace v1 { int f(int); } }\nint (*p)(int);\n' +
    'namespace lib { int g = 0; }');
  assert.deepEqual(errorsOf('namespace n {}\ninline namespace n {}'),
    ['non-inline namespace cannot be reopened as inline']);
});

test('defines members outside their namespace', function () {
  var r = ok('namespace m { int f(int); extern int g; }\nint m::f(int x) { return g; }\n' +
    'int m::g = 1;');
  assert.strictEqual(r.unit.decls[1].previous, r.unit.decls[0].decls[0]);
  assert.deepEqual(errorsOf('namespace m {}\nint m::f() { return 0; }'),
    ['out-of-line definition of \'f\' does not match any declaration in namespace \'m\'']);
  assert.deepEqual(errorsOf('namespace a { int x; }\nnamespace b { int a::x = 2; }'),
    ['cannot define or redeclare \'x\' here because namespace \'b\' does not enclose ' +
      'namespace \'a\'']);
});

test('reports invalid qualifiers', function () {
  assert.deepEqual(errorsOf('int z = nothere::v;'), ['use of undeclared identifier \'nothere\'']);
  assert.deepEqual(errorsOf('int x;\nint z = x::r;'),
    ['\'x\' is not a class, namespace, or enumeration']);
  assert.deepEqual(errorsOf('namespace a {}\nint z = a::nope;'),
    ['no member named \'nope\' in namespace \'a\'']);
  assert.deepEqual(errorsOf('namespace a {}\na::T t;'), ['no type named \'T\' in namespace \'a\'']);
  assert.deepEqual(errorsOf('int z = ::nope;'),
    ['no member named \'nope\' in the global namespace']);
  assert.deepEqual(errorsOf('void f() { namespace inner {} }'),
    ['namespaces can only be defined in global or namespace scope']);
  assert.deepEqual(errorsOf('int x;\nnamespace x {}'),
    ['redefinition of \'x\' as different kind of symbol']);
});

test('applies linkage specifications', function () {
  var r = ok('extern "C" int f(int);\nextern "C" { int g(void); int data; }\n' +
    'extern "C" int decl;\nextern "C++" int h();');
  assert.deepEqual(lines(r, /Decl (f|g|data|decl|h) /), [
    'FunctionDecl f \'int (int)\' extern extern "C"', 'FunctionDecl g \'int ()\' extern "C"',
    'VarDecl data \'int\' extern "C"', 'VarDecl decl \'int\' extern extern "C"',
    'FunctionDecl h \'int ()\' extern']);
  assert.deepEqual(errorsOf('extern "Fortran" int f;'), ['unknown linkage language']);
  assert.deepEqual(errorsOf('extern "C" { int cf(int); int cf(double); }'),
    ['conflicting types for \'cf\'']);
  ok('extern "C" int cf(int);\nint cf(double);');
});

test('checks extern "JS" declarations (D-031)', function () {
  var r = ok('extern "JS" {\n  namespace console { void log(const char *s); }\n  int counter;\n}');
  assert.deepEqual(lines(r, /Decl (log|counter) /), [
    'FunctionDecl log \'void (const char *)\' extern extern "JS"',
    'VarDecl counter \'int\' extern extern "JS"']);
  assert.deepEqual(errorsOf('extern "JS" { void f() {} }'),
    ['function \'f\' with \'JS\' linkage cannot be defined: it is provided by JavaScript']);
  assert.deepEqual(errorsOf('extern "JS" { int v = 1; }'),
    ['variable \'v\' with \'JS\' linkage cannot be initialized: it is provided by JavaScript']);
});

test('reads [[js::module]] on namespaces (D-031)', function () {
  var r = parse('extern "JS" { namespace [[js::module("left-pad")]] leftpad { int pad(int); } }');
  assert.deepEqual(r.errors, ['CommonJS module \'left-pad\' cannot be imported on the browser ' +
    'platform']);
  assert.deepEqual(lines(r, /NamespaceDecl/), ['NamespaceDecl leftpad module "left-pad"']);
  assert.deepEqual(errorsOf('namespace [[js::module("x")]] n {}'),
    ['\'js::module\' attribute requires the namespace to be declared inside \'extern "JS"\'']);
  assert.deepEqual(errorsOf('extern "JS" { namespace [[js::module(1)]] n {} }'),
    ['\'js::module\' attribute requires a module name string']);
  assert.deepEqual(errorsOf('[[js::module("x")]] int bad;'),
    ['\'js::module\' attribute only applies to namespaces']);
});

test('accepts standard attributes and warns about unknown ones', function () {
  var r = parse('[[noreturn]] void f();\n[[gnu::unused, foo]] int x;');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, ['unknown attribute \'gnu::unused\' ignored',
    'unknown attribute \'foo\' ignored']);
});

test('treats C-linkage names in every namespace as one entity', function () {
  ok('namespace n { extern "C" int g(); }\nextern "C" int g();\nextern "C" int g() { return 1; }');
  assert.deepEqual(errorsOf('extern "C" { int h(); namespace m { double h(); } }'),
    ['conflicting types for \'h\'']);
  assert.deepEqual(errorsOf('extern "C" double v;\nnamespace q { extern "C" int v; }'),
    ['redeclaration of \'v\' with a different type: \'int\' vs \'double\'']);
  assert.deepEqual(errorsOf('namespace z { extern "C" int k(); }\nextern "C" int k;'),
    ['redefinition of \'k\' as different kind of symbol']);
  assert.deepEqual(errorsOf('extern "C" int in();\nextern "C" int arguments;'),
    ['C-linkage name \'in\' cannot be exported: it is reserved in JavaScript',
      'C-linkage name \'arguments\' cannot be exported: it is reserved in JavaScript']);
});
