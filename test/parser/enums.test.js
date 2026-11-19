'use strict';

var assert = require('assert');
var test = require('../harness').test;
var helper = require('./parse-helper');

var parse = helper.parse;

function lines(source, pattern) {
  var r = parse(source);
  assert.deepEqual(r.errors, [], source);
  return r.dump.split('\n').filter(function (l) { return pattern.test(l); })
    .map(function (l) { return l.trim(); });
}

function errorsOf(source) {
  return parse(source).errors;
}

test('numbers enumerators and types them after the definition', function () {
  assert.deepEqual(lines('enum Color { red, green = 5, blue, last = blue + 10 };',
    /Enum/), ['EnumDecl Color \'int\'', 'EnumeratorDecl red \'Color\' 0',
    'EnumeratorDecl green \'Color\' 5', 'EnumeratorDecl blue \'Color\' 6',
    'EnumeratorDecl last \'Color\' 16']);
});

test('chooses the underlying type like GCC', function () {
  assert.deepEqual(lines('enum A { a = -1 };\nenum B { b = 0x80000000 };\n' +
    'enum C { c = 0x100000000LL };\nenum D { d = -1, e = 0x100000000LL };\n' +
    'enum F { f = 0xffffffffffffffffULL };', /EnumDecl/), ['EnumDecl A \'int\'',
    'EnumDecl B \'unsigned int\'', 'EnumDecl C \'long long\'', 'EnumDecl D \'long long\'',
    'EnumDecl F \'unsigned long long\'']);
  assert.deepEqual(errorsOf('enum X { lo = -1, hi = 0xffffffffffffffffULL };'),
    ['enumeration values exceed range of largest integer']);
});

test('supports scoped enumerations and fixed underlying types', function () {
  assert.deepEqual(lines('enum class Mode : unsigned char { off, on = 200 };\n' +
    'enum struct Dir { up };\nenum Small : short { s1 };', /EnumDecl/), [
    'EnumDecl Mode class \'unsigned char\'', 'EnumDecl Dir class \'int\'',
    'EnumDecl Small \'short\'']);
  assert.deepEqual(errorsOf('enum class S : unsigned char { v = 300 };'),
    ['enumerator value 300 is not representable in the underlying type \'unsigned char\'']);
  assert.deepEqual(errorsOf('enum class S : signed char { w = 127, w2 };'),
    ['enumerator value is not representable in the underlying type \'signed char\'']);
  assert.deepEqual(errorsOf('enum class S : double { z };'),
    ['non-integral type \'double\' is an invalid underlying type']);
});

test('scopes enumerators', function () {
  var ok = parse('enum E { a, b };\nenum class S { x };\nint i = a + E::b;\nS s = S::x;\n' +
    'int j = static_cast<int>(S::x);');
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(errorsOf('enum class S { x };\nint y = x;'),
    ['use of undeclared identifier \'x\'']);
  assert.deepEqual(errorsOf('enum class S { x, y = x + 1 };'), []);
  assert.deepEqual(errorsOf('enum E { a };\nenum F { a };'),
    ['redefinition of enumerator \'a\'']);
  assert.deepEqual(errorsOf('int a;\nenum E { a };'),
    ['redefinition of \'a\' as different kind of symbol']);
});

test('applies enumeration conversions', function () {
  assert.deepEqual(errorsOf('enum class S { x };\nS s = 0;'),
    ['cannot initialize a variable of type \'S\' with an rvalue of type \'int\'']);
  assert.deepEqual(errorsOf('enum class S { x };\nint i = S::x;'),
    ['cannot initialize a variable of type \'int\' with an rvalue of type \'S\'']);
  assert.deepEqual(errorsOf('enum class S { x };\nint i = S::x + 1;'),
    ['invalid operands to binary expression (\'S\' and \'int\')']);
  assert.deepEqual(errorsOf('enum E { a };\nE e = 1;'),
    ['cannot initialize a variable of type \'E\' with an rvalue of type \'int\'']);
  assert.deepEqual(errorsOf('enum E { a };\nint i = a * 2;\nbool b = a;\nlong l = a;\n' +
    'E e = static_cast<E>(1);\nenum class S { x };\nbool t = S::x == S::x;'), []);
});

test('uses enumerators in constant expressions', function () {
  assert.deepEqual(lines('enum { N = 4 };\nint arr[N * 2];\nenum class K : short { k = 3 };\n' +
    'int s[sizeof(K)];', /VarDecl/), ['VarDecl arr \'int [8]\'', 'VarDecl s \'int [2]\'']);
  assert.deepEqual(errorsOf('int n = 3;\nenum K { k = n };'),
    ['expression is not an integral constant expression']);
  assert.deepEqual(errorsOf('enum H { h = 1.5 };'),
    ['expression is not an integral constant expression']);
});

test('handles opaque declarations and elaborated references', function () {
  assert.deepEqual(lines('enum class O;\nenum P : int;\nO *po;\nenum P ep;\n' +
    'enum class O { o1 };', /EnumDecl|VarDecl/), [
    // The opaque declaration and the definition are the same EnumDecl (D-049).
    'EnumDecl O class \'int\'',
    'EnumDecl P \'int\' opaque', 'VarDecl po \'O *\'', 'VarDecl ep \'P\'',
    'EnumDecl O class \'int\'']);
  assert.deepEqual(errorsOf('enum G;'), ['ISO C++ forbids forward references to \'enum\' ' +
    'types']);
  assert.deepEqual(errorsOf('enum Unknown u;'),
    ['ISO C++ forbids forward references to \'enum\' types']);
  assert.deepEqual(errorsOf('enum class S { x };\nenum S;'),
    ['enumeration previously declared as scoped']);
  assert.deepEqual(errorsOf('enum class S : int;\nenum class S : long;'),
    ['enumeration redeclared with different underlying type \'long\' (was \'int\')']);
  assert.deepEqual(errorsOf('enum E { a };\nenum E { b };'), ['redefinition of \'E\'']);
});

test('declares variables together with the enumeration', function () {
  assert.deepEqual(lines('enum E { a, b } e1 = b, e2;\nenum { c } anon;', /VarDecl/), [
    'VarDecl e1 \'E\' copy-init', 'VarDecl e2 \'E\'', 'VarDecl anon \'(anonymous enum)\'']);
});

test('switches on enumerations', function () {
  assert.deepEqual(errorsOf('enum class M { a, b };\nint f(M m) { switch (m) { case M::a: ' +
    'return 1; case M::b: return 2; } return 0; }'), []);
  assert.deepEqual(errorsOf('enum class M { a, b };\nint f(M m) { switch (m) { case M::a: ' +
    'case M::a: ; } return 0; }'), ['duplicate case value \'0\'']);
});
