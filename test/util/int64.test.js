'use strict';

var assert = require('assert');
var test = require('../harness').test;
var I = require('../../src/util/int64');

function dec(text) {
  var negative = text.charAt(0) === '-';
  var value = I.parse(negative ? text.slice(1) : text, 10);
  return negative ? I.neg(value) : value;
}

function s(a) {
  return I.toString(a, true);
}

function u(a) {
  return I.toString(a, false);
}

test('parses and formats in every radix', function () {
  assert.equal(u(I.parse('18446744073709551615', 10)), '18446744073709551615');
  assert.equal(u(I.parse('ffffffffffffffff', 16)), '18446744073709551615');
  assert.equal(u(I.parse('1777777777777777777777', 8)), '18446744073709551615');
  assert.equal(u(I.parse('101', 2)), '5');
  assert.equal(u(I.parse('0', 10)), '0');
  assert.equal(s(I.parse('8000000000000000', 16)), '-9223372036854775808');
  assert.equal(I.parse('18446744073709551616', 10), null);
  assert.equal(I.parse('10000000000000000', 16), null);
  assert.equal(I.parse('19', 8), null);
  assert.equal(I.parse('', 10), null);
});

test('converts from and to JavaScript numbers', function () {
  assert.equal(s(I.fromNumber(-1)), '-1');
  assert.equal(u(I.fromNumber(-1)), '18446744073709551615');
  assert.equal(s(I.fromNumber(9007199254740991)), '9007199254740991');
  assert.equal(I.toNumber(I.fromNumber(-123456789012), true), -123456789012);
  assert.equal(I.toNumber(I.fromNumber(4294967296), false), 4294967296);
});

test('adds, subtracts and negates with wrap-around', function () {
  assert.equal(s(I.add(dec('9223372036854775807'), I.ONE)), '-9223372036854775808');
  assert.equal(s(I.sub(I.ZERO, I.ONE)), '-1');
  assert.equal(s(I.add(dec('4294967295'), I.ONE)), '4294967296');
  assert.equal(s(I.neg(I.MIN_SIGNED)), '-9223372036854775808');
  assert.equal(s(I.sub(dec('-5'), dec('7'))), '-12');
});

test('multiplies exactly', function () {
  assert.equal(s(I.mul(dec('3037000499'), dec('3037000499'))), '9223372030926249001');
  assert.equal(u(I.mul(dec('4294967296'), dec('4294967296'))), '0');
  assert.equal(s(I.mul(dec('-7'), dec('6'))), '-42');
  assert.equal(u(I.mul(I.MAX_UNSIGNED, I.MAX_UNSIGNED)), '1');
  assert.equal(s(I.mul(dec('123456789'), dec('987654321'))), '121932631112635269');
});

test('divides signed toward zero and unsigned', function () {
  assert.equal(s(I.divS(dec('-7'), dec('2'))), '-3');
  assert.equal(s(I.modS(dec('-7'), dec('2'))), '-1');
  assert.equal(s(I.divS(dec('7'), dec('-2'))), '-3');
  assert.equal(s(I.modS(dec('7'), dec('-2'))), '1');
  assert.equal(u(I.divU(I.MAX_UNSIGNED, dec('10'))), '1844674407370955161');
  assert.equal(u(I.modU(I.MAX_UNSIGNED, dec('10'))), '5');
  assert.equal(u(I.divU(I.fromNumber(-1), dec('2'))), '9223372036854775807');
  assert.throws(function () { I.divU(I.ONE, I.ZERO); }, RangeError);
});

test('shifts', function () {
  assert.equal(u(I.shl(I.ONE, 63)), '9223372036854775808');
  assert.equal(u(I.shl(I.ONE, 32)), '4294967296');
  assert.equal(u(I.shl(dec('3'), 31)), '6442450944');
  assert.equal(s(I.shrS(dec('-8'), 1)), '-4');
  assert.equal(s(I.shrS(I.MIN_SIGNED, 63)), '-1');
  assert.equal(u(I.shrU(I.MIN_SIGNED, 63)), '1');
  assert.equal(u(I.shrU(dec('6442450944'), 31)), '3');
  assert.equal(s(I.shrS(dec('-6442450944'), 33)), '-1');
});

test('compares signed and unsigned', function () {
  assert.ok(I.ltS(dec('-1'), I.ZERO));
  assert.ok(!I.ltU(dec('-1'), I.ZERO));
  assert.ok(I.ltS(I.MIN_SIGNED, I.MAX_SIGNED));
  assert.ok(I.ltU(I.MAX_SIGNED, I.MIN_SIGNED));
  assert.ok(I.eq(dec('42'), I.fromNumber(42)));
  assert.ok(I.isNegative(dec('-42')));
});

test('bitwise operations', function () {
  assert.equal(u(I.and(dec('12'), dec('10'))), '8');
  assert.equal(u(I.or(dec('12'), dec('3'))), '15');
  assert.equal(u(I.xor(dec('12'), dec('10'))), '6');
  assert.equal(s(I.not(I.ZERO)), '-1');
});

test('agrees with double arithmetic on small values', function () {
  var values = [0, 1, -1, 2, -3, 255, -256, 65535, -65536, 1000003, -999983, 33554431];
  var i;
  var j;
  var a;
  var b;
  for (i = 0; i < values.length; i++) {
    for (j = 0; j < values.length; j++) {
      a = I.fromNumber(values[i]);
      b = I.fromNumber(values[j]);
      assert.equal(I.toNumber(I.add(a, b), true), values[i] + values[j]);
      assert.equal(I.toNumber(I.sub(a, b), true), values[i] - values[j]);
      assert.equal(I.toNumber(I.mul(a, b), true), values[i] * values[j]);
      if (values[j] !== 0) {
        assert.equal(I.toNumber(I.divS(a, b), true),
          (values[i] / values[j]) < 0 ? Math.ceil(values[i] / values[j]) :
            Math.floor(values[i] / values[j]));
        assert.equal(I.toNumber(I.modS(a, b), true), values[i] % values[j]);
      }
      assert.equal(I.ltS(a, b), values[i] < values[j]);
    }
  }
});
