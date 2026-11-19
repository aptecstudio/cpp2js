'use strict';

var assert = require('assert');
var test = require('../harness').test;
var SourceFile = require('../../src/source/source-file');
var DiagnosticBag = require('../../src/diagnostics/diagnostic-bag');
var tokenizeAll = require('../../src/preprocessor/pp-lexer').tokenizeAll;
var evaluate = require('../../src/preprocessor/expression').evaluate;

function run(expr) {
  var bag = new DiagnosticBag();
  var source = new SourceFile('t.cpp', 'if ' + expr);
  var tokens = tokenizeAll(source, bag);
  var result = evaluate(tokens.slice(1), tokens[0], bag);
  return {
    value: result,
    errors: bag.getAll().filter(function (d) { return d.severity === 'error'; })
      .map(function (d) { return d.message; }),
    warnings: bag.getAll().filter(function (d) { return d.severity === 'warning'; })
      .map(function (d) { return d.message; })
  };
}

function truth(expr) {
  var r = run(expr);
  assert.deepEqual(r.errors, [], expr + ': ' + r.errors.join('; '));
  return r.value;
}

function errorOf(expr) {
  var r = run(expr);
  assert.equal(r.value, null, expr);
  return r.errors[0];
}

test('evaluates arithmetic with C++ precedence', function () {
  assert.equal(truth('1 + 2 * 3 == 7'), true);
  assert.equal(truth('(1 + 2) * 3 == 9'), true);
  assert.equal(truth('10 - 2 - 3 == 5'), true);
  assert.equal(truth('7 / 2 == 3 && 7 % 2 == 1'), true);
  assert.equal(truth('-7 / 2 == -3 && -7 % 2 == -1'), true);
  assert.equal(truth('1 << 3 | 1 == 9'), true);
  assert.equal(truth('(1 << 3 | 1) == 9'), true);
  assert.equal(truth('6 & 3 ^ 1'), true);
  assert.equal(truth('~0 == -1'), true);
  assert.equal(truth('!0 && !!5'), true);
  assert.equal(truth('+-+1 == -1'), true);
  assert.equal(truth('0'), false);
});

test('evaluates comparisons, logic and the conditional operator', function () {
  assert.equal(truth('3 > 2 && 2 >= 2 && 1 < 2 && 2 <= 2 && 1 != 2'), true);
  assert.equal(truth('0 || 0'), false);
  assert.equal(truth('1 ? 2 : 0'), true);
  assert.equal(truth('0 ? 1 : 0'), false);
  assert.equal(truth('1 ? 0 ? 1 : 0 : 1'), false);
});

test('uses 64-bit intmax_t arithmetic', function () {
  assert.equal(truth('0x7fffffffffffffff > 0'), true);
  assert.equal(truth('9223372036854775807 + 0 == 0x7fffffffffffffff'), true);
  assert.equal(truth('1 << 62 == 4611686018427387904'), true);
  assert.equal(truth('4294967296 * 4294967296 == 0'), true);
});

test('applies unsigned conversions', function () {
  assert.equal(truth('-1 < 0'), true);
  assert.equal(truth('-1 < 0u'), false);
  assert.equal(truth('-1 > 0U'), true);
  assert.equal(truth('0xffffffffffffffff == -1'), true);
  assert.equal(truth('0xffffffffffffffff > 0'), true);
  assert.equal(truth('(0 ? 1u : -1) > 0'), true);
  assert.equal(truth('-1 >> 1 == -1'), true);
  assert.equal(truth('-1u >> 63 == 1'), true);
  assert.deepEqual(run('18446744073709551615 > 0').warnings,
    ['integer constant is so large that it is unsigned']);
});

test('parses integer literals', function () {
  assert.equal(truth('010 == 8 && 0x10 == 16 && 0b101 == 5 && 0 == 0'), true);
  assert.equal(truth('10u == 10 && 10UL == 10 && 10ll == 10 && 10LLU == 10 && 10uLL == 10'),
    true);
  assert.equal(errorOf('1.5'), 'floating constant in preprocessor expression');
  assert.equal(errorOf('1e3'), 'floating constant in preprocessor expression');
  assert.equal(errorOf('10lL'), 'invalid suffix \'lL\' on integer constant');
  assert.equal(errorOf('10_km'), 'invalid suffix \'_km\' on integer constant');
  assert.equal(errorOf('09'), 'invalid digit in octal constant');
  assert.equal(errorOf('18446744073709551616'), 'integer constant is too large for its type');
});

test('evaluates character literals', function () {
  assert.equal(truth('\'A\' == 65 && \'\\n\' == 10 && \'\\0\' == 0'), true);
  assert.equal(truth('\'\\x41\' == 65 && \'\\101\' == 65 && \'\\\\\' == 92'), true);
  assert.equal(truth('\'\\xff\' == -1 && \'\\377\' < 0'), true);
  assert.equal(truth('u\'\\xffff\' == 65535 && U\'\\U0001F600\' == 0x1F600'), true);
  assert.equal(truth('L\'\\xffffffff\' == -1 && u\'\\u00e9\' == 233'), true);
  assert.equal(truth('\'ab\' == 0x6162'), true);
  assert.deepEqual(run('\'ab\'').warnings, ['multi-character character constant']);
  assert.equal(truth('\'\\u00e9\' == 0xc3a9'), true);
  assert.equal(errorOf('\'\''), 'empty character constant');
  assert.deepEqual(run('\'\\q\' == 113').warnings, ['unknown escape sequence \'\\q\'']);
  assert.equal(errorOf('\'\\x\''), '\\x used with no following hex digits');
  assert.equal(errorOf('\'\\777\''), 'character too large for enclosing character literal type');
  assert.equal(errorOf('u\'ab\''), 'character constant with more than one character');
});

test('identifiers are 0 except true', function () {
  assert.equal(truth('FOO'), false);
  assert.equal(truth('true'), true);
  assert.equal(truth('false || FOO == 0'), true);
});

test('does not report errors in unevaluated operands', function () {
  assert.equal(truth('0 && 1 / 0'), false);
  assert.equal(truth('1 || 1 % 0'), true);
  assert.equal(truth('1 ? 1 : 1 / 0'), true);
  assert.equal(truth('0 ? 1 << 99 : 1'), true);
  assert.deepEqual(run('0 && 18446744073709551615').warnings, []);
});

test('reports evaluation and syntax errors', function () {
  assert.equal(errorOf('1 / 0'), 'division by zero in preprocessor expression');
  assert.equal(errorOf('1 % 0'), 'remainder by zero in preprocessor expression');
  assert.equal(errorOf('1 << 64'), 'shift count is negative or too large');
  assert.equal(errorOf('1 >> -1'), 'shift count is negative or too large');
  assert.equal(errorOf('(1'), 'expected \')\'');
  assert.equal(errorOf('1 +'), 'expected value in expression');
  assert.equal(errorOf('1 2'),
    'token is not a valid binary operator in a preprocessor subexpression');
  assert.equal(errorOf('"s"'), 'token is not valid in preprocessor expressions');
  assert.equal(errorOf('1 = 1'),
    'token is not a valid binary operator in a preprocessor subexpression');
  assert.equal(errorOf('1 ? 2'), 'expected \':\'');
  assert.equal(errorOf(''), '#if with no expression');
});

test('attaches a note to an unmatched parenthesis', function () {
  var bag = new DiagnosticBag();
  var source = new SourceFile('t.cpp', 'if (1 + 2');
  var tokens = tokenizeAll(source, bag);
  evaluate(tokens.slice(1), tokens[0], bag);
  assert.equal(bag.getAll()[0].notes[0].message, 'to match this \'(\'');
  assert.equal(bag.getAll()[0].notes[0].start, 3);
});
