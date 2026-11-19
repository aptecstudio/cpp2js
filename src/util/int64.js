'use strict';

/**
 * Exact 64-bit integer arithmetic on two 32-bit halves, for an ES5 engine
 * without BigInt. Values are immutable `Int64` objects holding the bit
 * pattern; whether it is read as signed (two's complement) or unsigned is
 * chosen by the operation (`ltS` / `ltU`, `divS` / `divU`, ...), as in a
 * CPU. All operations wrap modulo 2^64.
 *
 * Used by the preprocessor (`#if` arithmetic is done in intmax_t and
 * uintmax_t) and later by constant folding and `long long` (D-016).
 */

var TWO_32 = 4294967296;

/**
 * @constructor
 * @param {number} hi High 32 bits, as an unsigned integer.
 * @param {number} lo Low 32 bits, as an unsigned integer.
 */
function Int64(hi, lo) {
  this.hi = hi >>> 0;
  this.lo = lo >>> 0;
}

var ZERO = new Int64(0, 0);
var ONE = new Int64(0, 1);
var MAX_UNSIGNED = new Int64(0xffffffff, 0xffffffff);
var MAX_SIGNED = new Int64(0x7fffffff, 0xffffffff);
var MIN_SIGNED = new Int64(0x80000000, 0);

/**
 * Converts a JavaScript integer (|n| < 2^53) to its 64-bit pattern.
 *
 * @param {number} n
 * @returns {Int64}
 */
function fromNumber(n) {
  var negative = n < 0;
  var abs = Math.abs(n);
  var value = new Int64(Math.floor(abs / TWO_32), abs % TWO_32);
  return negative ? neg(value) : value;
}

/**
 * Converts to a JavaScript number (exact only within ±2^53).
 *
 * @param {Int64} a
 * @param {boolean} signed Read the pattern as signed.
 * @returns {number}
 */
function toNumber(a, signed) {
  if (signed && isNegative(a)) {
    return -toNumber(neg(a), false);
  }
  return a.hi * TWO_32 + a.lo;
}

function isZero(a) {
  return a.hi === 0 && a.lo === 0;
}

function isNegative(a) {
  return (a.hi & 0x80000000) !== 0;
}

function eq(a, b) {
  return a.hi === b.hi && a.lo === b.lo;
}

/** Unsigned less-than. */
function ltU(a, b) {
  return a.hi < b.hi || (a.hi === b.hi && a.lo < b.lo);
}

/** Signed less-than. */
function ltS(a, b) {
  var ah = (a.hi ^ 0x80000000) >>> 0;
  var bh = (b.hi ^ 0x80000000) >>> 0;
  return ah < bh || (ah === bh && a.lo < b.lo);
}

function add(a, b) {
  var lo = a.lo + b.lo;
  var carry = lo >= TWO_32 ? 1 : 0;
  return new Int64(a.hi + b.hi + carry, lo);
}

function not(a) {
  return new Int64(~a.hi, ~a.lo);
}

function neg(a) {
  return add(not(a), ONE);
}

function sub(a, b) {
  return add(a, neg(b));
}

function and(a, b) {
  return new Int64(a.hi & b.hi, a.lo & b.lo);
}

function or(a, b) {
  return new Int64(a.hi | b.hi, a.lo | b.lo);
}

function xor(a, b) {
  return new Int64(a.hi ^ b.hi, a.lo ^ b.lo);
}

/**
 * Multiplication on 16-bit limbs, so that every partial product stays below
 * 2^53 and is exact in a double.
 */
function mul(a, b) {
  var a48 = a.hi >>> 16;
  var a32 = a.hi & 0xffff;
  var a16 = a.lo >>> 16;
  var a00 = a.lo & 0xffff;
  var b48 = b.hi >>> 16;
  var b32 = b.hi & 0xffff;
  var b16 = b.lo >>> 16;
  var b00 = b.lo & 0xffff;
  var c48;
  var c32;
  var c16;
  var c00;
  c00 = a00 * b00;
  c16 = c00 >>> 16;
  c00 &= 0xffff;
  c16 += a16 * b00;
  c32 = c16 >>> 16;
  c16 &= 0xffff;
  c16 += a00 * b16;
  c32 += c16 >>> 16;
  c16 &= 0xffff;
  c32 += a32 * b00;
  c48 = c32 >>> 16;
  c32 &= 0xffff;
  c32 += a16 * b16;
  c48 += c32 >>> 16;
  c32 &= 0xffff;
  c32 += a00 * b32;
  c48 += c32 >>> 16;
  c32 &= 0xffff;
  c48 += a48 * b00 + a32 * b16 + a16 * b32 + a00 * b48;
  c48 &= 0xffff;
  return new Int64((c48 << 16) | c32, (c16 << 16) | c00);
}

/** Left shift by 0..63 bits. */
function shl(a, n) {
  if (n === 0) {
    return a;
  }
  if (n >= 32) {
    return new Int64(a.lo << (n - 32), 0);
  }
  return new Int64((a.hi << n) | (a.lo >>> (32 - n)), a.lo << n);
}

/** Logical (unsigned) right shift by 0..63 bits. */
function shrU(a, n) {
  if (n === 0) {
    return a;
  }
  if (n >= 32) {
    return new Int64(0, a.hi >>> (n - 32));
  }
  return new Int64(a.hi >>> n, (a.lo >>> n) | (a.hi << (32 - n)));
}

/** Arithmetic (signed) right shift by 0..63 bits. */
function shrS(a, n) {
  if (n === 0) {
    return a;
  }
  if (n >= 32) {
    return new Int64(a.hi >> 31, a.hi >> (n - 32));
  }
  return new Int64(a.hi >> n, (a.lo >>> n) | (a.hi << (32 - n)));
}

/**
 * Unsigned division with remainder (binary long division).
 *
 * @param {Int64} a Dividend.
 * @param {Int64} b Divisor, not zero.
 * @returns {{quotient: Int64, remainder: Int64}}
 * @throws {RangeError} On division by zero.
 */
function divModU(a, b) {
  var quotient = ZERO;
  var remainder = ZERO;
  var i;
  var bit;
  if (isZero(b)) {
    throw new RangeError('Division by zero');
  }
  for (i = 63; i >= 0; i--) {
    bit = i >= 32 ? (a.hi >>> (i - 32)) & 1 : (a.lo >>> i) & 1;
    remainder = or(shl(remainder, 1), new Int64(0, bit));
    if (!ltU(remainder, b)) {
      remainder = sub(remainder, b);
      quotient = or(quotient, shl(ONE, i));
    }
  }
  return { quotient: quotient, remainder: remainder };
}

function divU(a, b) {
  return divModU(a, b).quotient;
}

function modU(a, b) {
  return divModU(a, b).remainder;
}

/**
 * Signed division truncated toward zero (as in C++). MIN / -1 wraps.
 */
function divS(a, b) {
  var negative = isNegative(a) !== isNegative(b);
  var q = divU(isNegative(a) ? neg(a) : a, isNegative(b) ? neg(b) : b);
  return negative ? neg(q) : q;
}

/** Signed remainder; its sign follows the dividend (as in C++). */
function modS(a, b) {
  var r = modU(isNegative(a) ? neg(a) : a, isNegative(b) ? neg(b) : b);
  return isNegative(a) ? neg(r) : r;
}

/**
 * Parses digits in a radix, detecting overflow beyond 64 bits.
 *
 * @param {string} digits Digits only, no prefix or sign.
 * @param {number} radix 2, 8, 10 or 16.
 * @returns {?Int64} The value, or null on overflow or invalid digit.
 */
function parse(digits, radix) {
  var r = new Int64(0, radix);
  var limit = divU(MAX_UNSIGNED, r);
  var value = ZERO;
  var digit;
  var product;
  var i;
  if (!digits.length) {
    return null;
  }
  for (i = 0; i < digits.length; i++) {
    digit = parseInt(digits.charAt(i), radix);
    if (isNaN(digit)) {
      return null;
    }
    if (ltU(limit, value)) {
      return null;
    }
    product = mul(value, r);
    value = add(product, new Int64(0, digit));
    // The addition wrapped around.
    if (ltU(value, product)) {
      return null;
    }
  }
  return value;
}

/**
 * Formats in decimal.
 *
 * @param {Int64} a
 * @param {boolean} signed Read the pattern as signed.
 * @returns {string}
 */
function toString(a, signed) {
  var ten = new Int64(0, 10);
  var digits = '';
  var step;
  if (signed && isNegative(a)) {
    return '-' + toString(neg(a), false);
  }
  if (isZero(a)) {
    return '0';
  }
  while (!isZero(a)) {
    step = divModU(a, ten);
    digits = String(step.remainder.lo) + digits;
    a = step.quotient;
  }
  return digits;
}

module.exports = {
  Int64: Int64,
  ZERO: ZERO,
  ONE: ONE,
  MAX_UNSIGNED: MAX_UNSIGNED,
  MAX_SIGNED: MAX_SIGNED,
  MIN_SIGNED: MIN_SIGNED,
  fromNumber: fromNumber,
  toNumber: toNumber,
  isZero: isZero,
  isNegative: isNegative,
  eq: eq,
  ltU: ltU,
  ltS: ltS,
  add: add,
  sub: sub,
  neg: neg,
  not: not,
  and: and,
  or: or,
  xor: xor,
  mul: mul,
  shl: shl,
  shrU: shrU,
  shrS: shrS,
  divU: divU,
  modU: modU,
  divS: divS,
  modS: modS,
  parse: parse,
  toString: toString
};
