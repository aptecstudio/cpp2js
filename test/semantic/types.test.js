'use strict';

var assert = require('assert');
var test = require('../harness').test;
var T = require('../../src/semantic/types');

var ctx = new T.TypeContext();
var INT = ctx.builtin('int');
var CHAR = ctx.builtin('char');
var DOUBLE = ctx.builtin('double');

function str(type) {
  return T.typeToString(type);
}

test('interns types so that === is type identity', function () {
  assert.strictEqual(ctx.pointer(INT), ctx.pointer(INT));
  assert.strictEqual(ctx.qualified(INT, true, false), ctx.qualified(INT, true, false));
  assert.notStrictEqual(ctx.qualified(INT, true, false), INT);
  assert.strictEqual(ctx.qualified(INT, true, false).unqualified, INT);
  assert.strictEqual(ctx.qualified(ctx.qualified(INT, true, false), false, false), INT);
  assert.strictEqual(ctx.func(INT, [CHAR]), ctx.func(INT, [CHAR]));
  assert.notStrictEqual(ctx.func(INT, [CHAR]), ctx.func(INT, [CHAR], { variadic: true }));
  assert.strictEqual(ctx.array(INT, 3), ctx.array(INT, 3));
  assert.notStrictEqual(ctx.array(INT, 3), ctx.array(INT, null));
  assert.throws(function () { ctx.builtin('integer'); }, Error);
});

test('applies qualifiers to array elements and not to references', function () {
  var constArray = ctx.qualified(ctx.array(INT, 2), true, false);
  assert.strictEqual(constArray, ctx.array(ctx.qualified(INT, true, false), 2));
  assert.strictEqual(ctx.qualified(ctx.lvalueReference(INT), true, false),
    ctx.lvalueReference(INT));
  assert.strictEqual(ctx.addQualifiers(ctx.qualified(INT, true, false), false, true),
    ctx.qualified(INT, true, true));
  assert.strictEqual(ctx.removeQualifiers(constArray), ctx.array(INT, 2));
});

test('collapses references', function () {
  var lref = ctx.lvalueReference(INT);
  var rref = ctx.rvalueReference(INT);
  assert.strictEqual(ctx.lvalueReference(lref), lref);
  assert.strictEqual(ctx.lvalueReference(rref), lref);
  assert.strictEqual(ctx.rvalueReference(lref), lref);
  assert.strictEqual(ctx.rvalueReference(rref), rref);
  assert.strictEqual(T.removeReference(rref), INT);
});

test('adjusts parameters and decays', function () {
  var fn = ctx.func(INT, []);
  assert.strictEqual(ctx.adjustParameter(ctx.array(CHAR, 4)), ctx.pointer(CHAR));
  assert.strictEqual(ctx.adjustParameter(fn), ctx.pointer(fn));
  assert.strictEqual(ctx.adjustParameter(ctx.qualified(INT, true, false)), INT);
  assert.strictEqual(ctx.decay(ctx.array(INT, 3)), ctx.pointer(INT));
  assert.strictEqual(ctx.decay(INT), INT);
});

test('spells types like Clang', function () {
  var cint = ctx.qualified(INT, true, false);
  assert.equal(str(INT), 'int');
  assert.equal(str(cint), 'const int');
  assert.equal(str(ctx.pointer(cint)), 'const int *');
  assert.equal(str(ctx.qualified(ctx.pointer(INT), true, false)), 'int *const');
  assert.equal(str(ctx.pointer(ctx.pointer(CHAR))), 'char **');
  assert.equal(str(ctx.lvalueReference(INT)), 'int &');
  assert.equal(str(ctx.rvalueReference(INT)), 'int &&');
  assert.equal(str(ctx.array(INT, 3)), 'int [3]');
  assert.equal(str(ctx.array(INT, null)), 'int []');
  assert.equal(str(ctx.pointer(ctx.array(INT, 3))), 'int (*)[3]');
  assert.equal(str(ctx.lvalueReference(ctx.array(CHAR, 4))), 'char (&)[4]');
  assert.equal(str(ctx.func(ctx.builtin('void'), [INT, DOUBLE])), 'void (int, double)');
  assert.equal(str(ctx.pointer(ctx.func(INT, [ctx.pointer(CHAR)], { variadic: true }))),
    'int (*)(char *, ...)');
  assert.equal(str(ctx.func(INT, [], { methodConst: true, refQualifier: '&' })),
    'int () const &');
  assert.equal(str(ctx.array(ctx.array(INT, 3), 2)), 'int [2][3]');
  assert.equal(str(ctx.qualified(ctx.builtin('unsigned long long'), true, true)),
    'const volatile unsigned long long');
  assert.equal(str(ctx.record({ id: 1, name: 'Foo', qualifiedName: 'ns::Foo' })), 'ns::Foo');
});

test('classifies types', function () {
  var e = ctx.enumeration({ id: 2, name: 'E', scoped: false, underlyingType: INT });
  assert.ok(T.isIntegral(INT) && T.isIntegral(ctx.builtin('bool')));
  assert.ok(!T.isIntegral(DOUBLE) && T.isFloating(DOUBLE) && T.isArithmetic(DOUBLE));
  assert.ok(!T.isIntegral(e) && T.isEnum(e) && T.isScalar(e));
  assert.ok(T.isScalar(ctx.pointer(INT)) && T.isScalar(ctx.builtin('std::nullptr_t')));
  assert.ok(!T.isObject(ctx.builtin('void')) && !T.isObject(ctx.lvalueReference(INT)));
  assert.ok(T.isObject(ctx.array(INT, 2)));
  assert.ok(T.isSigned(CHAR) && T.isUnsigned(ctx.builtin('char16_t')));
  assert.ok(!T.isComplete(ctx.builtin('void')) && !T.isComplete(ctx.array(INT, null)));
  assert.ok(!T.isComplete(ctx.record({ id: 3, name: 'X', complete: false })));
});

test('computes ILP32 sizes', function () {
  assert.equal(T.sizeOf(CHAR), 1);
  assert.equal(T.sizeOf(ctx.builtin('short')), 2);
  assert.equal(T.sizeOf(INT), 4);
  assert.equal(T.sizeOf(ctx.builtin('long')), 4);
  assert.equal(T.sizeOf(ctx.builtin('long long')), 8);
  assert.equal(T.sizeOf(ctx.builtin('wchar_t')), 4);
  assert.equal(T.sizeOf(ctx.builtin('long double')), 8);
  assert.equal(T.sizeOf(ctx.pointer(DOUBLE)), 4);
  assert.equal(T.sizeOf(ctx.array(ctx.array(DOUBLE, 3), 2)), 48);
  assert.equal(T.sizeOf(ctx.lvalueReference(DOUBLE)), 8);
  assert.equal(T.sizeOf(ctx.builtin('void')), null);
  assert.equal(T.sizeOf(ctx.func(INT, [])), null);
  assert.equal(T.sizeOf(ctx.record({ id: 4, name: 'S', complete: true, size: 12 })), 12);
});

test('applies integral promotions', function () {
  var b = function (n) { return ctx.builtin(n); };
  var e = ctx.enumeration({ id: 5, name: 'E', scoped: false, underlyingType: b('short') });
  assert.strictEqual(T.promote(ctx, b('bool')), INT);
  assert.strictEqual(T.promote(ctx, CHAR), INT);
  assert.strictEqual(T.promote(ctx, b('unsigned short')), INT);
  assert.strictEqual(T.promote(ctx, b('char16_t')), INT);
  assert.strictEqual(T.promote(ctx, b('char32_t')), b('unsigned int'));
  assert.strictEqual(T.promote(ctx, b('wchar_t')), INT);
  assert.strictEqual(T.promote(ctx, b('long')), b('long'));
  assert.strictEqual(T.promote(ctx, e), INT);
  assert.strictEqual(T.promote(ctx, DOUBLE), DOUBLE);
});

test('applies the usual arithmetic conversions (ILP32)', function () {
  var b = function (n) { return ctx.builtin(n); };
  var uac = function (x, y) { return T.typeToString(T.usualArithmeticConversions(ctx, b(x), b(y))); };
  assert.equal(uac('char', 'short'), 'int');
  assert.equal(uac('int', 'unsigned int'), 'unsigned int');
  assert.equal(uac('long', 'unsigned int'), 'unsigned long');
  assert.equal(uac('long long', 'unsigned int'), 'long long');
  assert.equal(uac('long long', 'unsigned long'), 'long long');
  assert.equal(uac('unsigned long long', 'long long'), 'unsigned long long');
  assert.equal(uac('int', 'long'), 'long');
  assert.equal(uac('int', 'float'), 'float');
  assert.equal(uac('float', 'double'), 'double');
  assert.equal(uac('long double', 'double'), 'long double');
  assert.equal(uac('unsigned short', 'unsigned char'), 'int');
  assert.equal(T.typeToString(T.usualArithmeticConversions(ctx,
    ctx.qualified(INT, true, false), CHAR)), 'int');
});
