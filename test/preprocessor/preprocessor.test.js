'use strict';

var assert = require('assert');
var test = require('../harness').test;
var SourceFile = require('../../src/source/source-file');
var DiagnosticBag = require('../../src/diagnostics/diagnostic-bag');
var format = require('../../src/diagnostics/format');
var tokenizeAll = require('../../src/preprocessor/pp-lexer').tokenizeAll;
var Preprocessor = require('../../src/preprocessor/preprocessor').Preprocessor;

/**
 * Preprocesses `files['main.cpp']` with an in-memory file system.
 *
 * @param {Object.<string, string>} files
 * @param {Object} [options] Extra Preprocessor options.
 */
function pp(files, options) {
  var bag = new DiagnosticBag();
  var opts = options || {};
  var result;
  opts.diagnostics = bag;
  opts.systemIncludePaths = opts.systemIncludePaths || ['sys'];
  opts.now = opts.now || new Date(2026, 0, 5, 9, 7, 3);
  opts.readFile = function (file) {
    var key = file.split('\\').join('/');
    if (!files.hasOwnProperty(key)) {
      throw new Error('ENOENT');
    }
    return files[key];
  };
  result = new Preprocessor(opts).run(new SourceFile('main.cpp', files['main.cpp']));
  return {
    tokens: result.tokens,
    text: result.tokens.map(function (t) { return t.text; }).join(' '),
    files: result.files.map(function (f) { return f.path; }),
    errors: bag.getAll().filter(function (d) { return d.severity === 'error'; })
      .map(function (d) { return d.message; }),
    warnings: bag.getAll().filter(function (d) { return d.severity === 'warning'; })
      .map(function (d) { return d.message; }),
    bag: bag
  };
}

/** Normalizes expected text to the same one-space token spelling. */
function norm(text) {
  return tokenizeAll(new SourceFile('x', text), new DiagnosticBag())
    .map(function (t) { return t.text; }).join(' ');
}

function expand(source, options) {
  var r = pp({ 'main.cpp': source }, options);
  assert.deepEqual(r.errors, []);
  return r.text;
}

test('expands object-like and function-like macros', function () {
  assert.equal(expand('#define N 10\nint a[N];'), norm('int a[10];'));
  assert.equal(expand('#define MAX(a, b) ((a) > (b) ? (a) : (b))\nMAX(1, x + 2)'),
    norm('((1) > (x + 2) ? (1) : (x + 2))'));
  assert.equal(expand('#define F(x) [x]\nF((a, b)) F() F(())'), norm('[(a, b)] [] [()]'));
  assert.equal(expand('#define F(x) x\nint F;'), norm('int F;'));
  assert.equal(expand('#define F(x) x\nF\n(1)'), norm('1'));
});

test('does not expand a macro inside its own expansion', function () {
  assert.equal(expand('#define x x + 1\nx'), norm('x + 1'));
  assert.equal(expand('#define a b\n#define b a\na b'), norm('a b'));
  assert.equal(expand('#define f(a) a*g\n#define g(a) f(a)\nf(2)(9)'), norm('2*9*g'));
});

test('follows the C++11 16.3.5/5 example', function () {
  var source = [
    '#define x 3',
    '#define f(a) f(x * (a))',
    '#undef x',
    '#define x 2',
    '#define g f',
    '#define z z[0]',
    '#define h g(~',
    '#define m(a) a(w)',
    '#define w 0,1',
    '#define t(a) a',
    '#define p() int',
    '#define q(x) x',
    '#define r(x,y) x ## y',
    '#define str(x) # x',
    'f(y+1) + f(f(z)) % t(t(g)(0) + t)(1);',
    'g(x+(3,4)-w) | h 5) & m',
    '(f)^m(m);',
    'p() i[q()] = { q(1), r(2,3), r(4,), r(,5), r(,) };',
    'char c[2][6] = { str(hello), str() };'
  ].join('\n');
  assert.equal(expand(source), norm([
    'f(2 * (y+1)) + f(2 * (f(2 * (z[0])))) % f(2 * (0)) + t(1);',
    'f(2 * (2+(3,4)-0,1)) | f(2 * (~ 5)) & f(2 * (0,1))^m(0,1);',
    'int i[] = { 1, 23, 4, 5, };',
    'char c[2][6] = { "hello", "" };'
  ].join('\n')));
});

test('follows the C++11 16.3.5/6 example (# and ##)', function () {
  var r = pp({
    'main.cpp': [
      '#define str(s) # s',
      '#define xstr(s) str(s)',
      '#define debug(s, t) printf("x" # s "= %d, x" # t "= %s", \\',
      ' x ## s, x ## t)',
      '#define INCFILE(n) vers ## n',
      '#define glue(a, b) a ## b',
      '#define xglue(a, b) glue(a, b)',
      '#define HIGHLOW "hello"',
      '#define LOW LOW ", world"',
      'debug(1, 2);',
      'fputs(str(strncmp("abc\\0d", "abc", \'\\4\') // this goes away',
      ' == 0) str(: @\\n), s);',
      '#include xstr(INCFILE(2).h)',
      'glue(HIGH, LOW);',
      'xglue(HIGH, LOW)'
    ].join('\n'),
    'vers2.h': 'included'
  });
  assert.deepEqual(r.errors, []);
  assert.equal(r.text, norm([
    'printf("x" "1" "= %d, x" "2" "= %s", x1, x2);',
    'fputs("strncmp(\\"abc\\\\0d\\", \\"abc\\", \'\\\\4\') == 0" ": @\\n", s);',
    'included',
    '"hello";',
    '"hello" ", world"'
  ].join('\n')));
});

test('follows the C++11 16.3.5/7 example (placemarkers)', function () {
  assert.equal(expand('#define t(x,y,z) x ## y ## z\n' +
    'int j[] = { t(1,2,3), t(,4,5), t(6,,7), t(8,9,),\n' +
    ' t(10,,), t(,11,), t(,,12), t(,,) };'),
    norm('int j[] = { 123, 45, 67, 89, 10, 11, 12, };'));
});

test('follows the C++11 16.3.5/9 example (variadic macros)', function () {
  assert.equal(expand([
    '#define debug(...) fprintf(stderr, __VA_ARGS__)',
    '#define showlist(...) puts(#__VA_ARGS__)',
    '#define report(test, ...) ((test)?puts(#test):\\',
    'printf(__VA_ARGS__))',
    'debug("Flag");',
    'debug("X = %d\\n", x);',
    'showlist(The first, second, and third items.);',
    'report(x>y, "x is %d but y is %d", x, y);'
  ].join('\n')), norm([
    'fprintf(stderr, "Flag" );',
    'fprintf(stderr, "X = %d\\n", x );',
    'puts( "The first, second, and third items." );',
    '((x>y)?puts("x>y"): printf("x is %d but y is %d", x, y));'
  ].join('\n')));
});

test('supports the GNU comma extension and omitted variadic arguments', function () {
  assert.equal(expand('#define L(fmt, ...) log(fmt, ## __VA_ARGS__)\nL("a") L("b", 1, 2)'),
    norm('log("a") log("b", 1, 2)'));
  assert.equal(expand('#define V(a, ...) [a __VA_ARGS__]\nV(1)'), norm('[1]'));
});

test('stringizes with normalized whitespace', function () {
  var r = pp({ 'main.cpp': '#define S(x) #x\nS(  a   +\n  b  ) S("q\\n") S(\'"\')' });
  assert.deepEqual(r.tokens.map(function (t) { return t.text; }),
    ['"a + b"', '"\\"q\\\\n\\""', '"\'\\"\'"']);
});

test('reports invalid token pasting', function () {
  var r = pp({ 'main.cpp': '#define P(a, b) a ## b\nP(+, -) P(x, 1) P(., .)' });
  assert.deepEqual(r.errors, ['pasting formed \'+-\', an invalid preprocessing token',
    'pasting formed \'..\', an invalid preprocessing token']);
  assert.equal(pp({ 'main.cpp': '#define P(a, b) a ## b\nP(x, 1)' }).text, 'x1');
  assert.equal(pp({ 'main.cpp': '#define P(a, b) a ## b\nP(<, <=)' }).text, '<<=');
});

test('reports macro invocation errors', function () {
  var r = pp({ 'main.cpp': '#define F(a, b) a\nF(1)\nF(1, 2, 3)\nF(1' });
  assert.deepEqual(r.errors, [
    'too few arguments provided to function-like macro invocation',
    'too many arguments provided to function-like macro invocation',
    'unterminated function-like macro invocation'
  ]);
  assert.equal(r.bag.getAll()[0].notes[0].message, 'macro \'F\' defined here');
});

test('checks macro definitions', function () {
  var cases = {
    '#define': 'macro name missing',
    '#define 1': 'macro name must be an identifier',
    '#define defined': '\'defined\' cannot be used as a macro name',
    '#define F(a, a)': 'duplicate macro parameter name \'a\'',
    '#define F(a': 'missing \')\' in macro parameter list',
    '#define F(a b)': 'expected comma in macro parameter list',
    '#define F(1)': 'invalid token in macro parameter list',
    '#define F(a) #b': '\'#\' is not followed by a macro parameter',
    '#define F ## a': '\'##\' cannot appear at either end of a macro expansion',
    '#define F(a) a ##': '\'##\' cannot appear at either end of a macro expansion',
    '#define F __VA_ARGS__': '__VA_ARGS__ can only appear in the expansion of a C++11 ' +
      'variadic macro'
  };
  var key;
  for (key in cases) {
    if (cases.hasOwnProperty(key)) {
      assert.deepEqual(pp({ 'main.cpp': key + '\n' }).errors, [cases[key]], key);
    }
  }
  assert.equal(expand('#define H #\nH'), '#');
});

test('warns about incompatible redefinitions only', function () {
  var r = pp({ 'main.cpp': '#define A 1\n#define A 1\n#define A  1\n#define A 2\n' +
    '#define B(x) x\n#define B(y) y\n#define __LINE__ 3\n#define X+1\n' });
  assert.deepEqual(r.warnings, ['\'A\' macro redefined', '\'B\' macro redefined',
    'redefining builtin macro \'__LINE__\'', 'whitespace required after the macro name']);
  assert.equal(r.bag.getAll()[0].notes[0].message, 'previous definition is here');
});

test('evaluates conditional groups', function () {
  assert.equal(expand('#if 1\na\n#else\nb\n#endif'), 'a');
  assert.equal(expand('#if 0\na\n#elif 2 > 1\nb\n#elif 1\nc\n#else\nd\n#endif'), 'b');
  assert.equal(expand('#if 0\na\n#elif 0\nb\n#else\nd\n#endif'), 'd');
  assert.equal(expand('#if 1\n#if 0\na\n#else\nb\n#endif\n#endif'), 'b');
  assert.equal(expand('#if 0\n#if 1\na\n#else\nb\n#endif\nc\n#else\nd\n#endif'), 'd');
  assert.equal(expand('#define X\n#ifdef X\na\n#endif\n#ifndef X\nb\n#endif'), 'a');
  assert.equal(expand('#if 0\ndon\'t "care\n#bogus\n#endif\nok'), 'ok');
  assert.equal(expand('#if 1\na\n#elif 1/0\nb\n#endif'), 'a');
});

test('evaluates defined and __has_include', function () {
  var files = { 'main.cpp': '#define M\n#if defined M && defined(M) && !defined N\nyes\n#endif\n' +
    '#if __has_include("a.h") && __has_include(<b.h>) && !__has_include(<c.h>)\ninc\n#endif\n' +
    '#ifdef __has_include\nhas\n#endif',
    'a.h': '', 'sys/b.h': '' };
  var r = pp(files);
  assert.deepEqual(r.errors, []);
  assert.equal(r.text, 'yes inc has');
  assert.equal(expand('#define D defined(Q)\n#define Q\n#if D\nq\n#endif'), 'q');
});

test('reports conditional structure errors', function () {
  assert.deepEqual(pp({ 'main.cpp': '#endif\n#else\n#elif 1\n' }).errors,
    ['#endif without #if', '#else without #if', '#elif without #if']);
  assert.deepEqual(pp({ 'main.cpp': '#if 1\n#else\n#else\n#endif' }).errors,
    ['#else after #else']);
  assert.deepEqual(pp({ 'main.cpp': '#if 0\n#else\n#elif 1\n#endif' }).errors,
    ['#elif after #else']);
  assert.deepEqual(pp({ 'main.cpp': '#if 1\n#ifdef X\n' }).errors,
    ['unterminated conditional directive', 'unterminated conditional directive']);
  assert.deepEqual(pp({ 'main.cpp': '#ifdef\n#endif' }).errors, ['macro name missing']);
  assert.deepEqual(pp({ 'main.cpp': '#if\n#endif' }).errors, ['#if with no expression']);
  assert.deepEqual(pp({ 'main.cpp': '#if defined(\n#endif' }).errors,
    ['macro name must be an identifier']);
  assert.deepEqual(pp({ 'main.cpp': '#ifdef A B\n#endif junk' }).warnings,
    ['extra tokens at end of #ifdef directive', 'extra tokens at end of #endif directive']);
});

test('includes files from the search paths', function () {
  var r = pp({
    'main.cpp': '#include "dir/a.h"\n#include <b.h>\n#include <c.h>\nmain',
    'dir/a.h': '#include "inner.h"\na',
    'dir/inner.h': 'inner',
    'inc/b.h': 'b_user',
    'sys/b.h': 'b_sys',
    'sys/c.h': 'c_sys'
  }, { includePaths: ['inc'] });
  assert.deepEqual(r.errors, []);
  assert.equal(r.text, 'inner a b_user c_sys main');
  assert.deepEqual(r.files.slice().sort(), ['dir/a.h', 'dir/inner.h', 'inc/b.h', 'main.cpp',
    'sys/c.h']);
});

test('honours include guards and #pragma once', function () {
  var r = pp({
    'main.cpp': '#include "g.h"\n#include "g.h"\n#include "o.h"\n#include "o.h"\n' +
      '#include "p.h"\n#include "p.h"\nend',
    'g.h': '#ifndef G_H\n#define G_H\ng\n#endif',
    'o.h': '#pragma once\no',
    'p.h': '_Pragma("once") p'
  });
  assert.deepEqual(r.errors, []);
  assert.equal(r.text, 'g o p end');
  assert.deepEqual(pp({ 'main.cpp': '#pragma once\n' }).warnings, ['#pragma once in main file']);
});

test('supports computed includes', function () {
  var r = pp({ 'main.cpp': '#define H <x.h>\n#define Q "y.h"\n#include H\n#include Q',
    'sys/x.h': 'x', 'y.h': 'y' });
  assert.deepEqual(r.errors, []);
  assert.equal(r.text, 'x y');
});

test('stops at a missing include', function () {
  var r = pp({ 'main.cpp': 'a\n#include "missing.h"\nb\n#error not reached' });
  assert.deepEqual(r.errors, ['\'missing.h\' file not found']);
  assert.equal(r.text, 'a');
  assert.deepEqual(pp({ 'main.cpp': '#include\n' }).errors,
    ['expected "FILENAME" or <FILENAME>']);
  assert.deepEqual(pp({ 'main.cpp': '#include ""\n' }).errors, ['empty filename']);
  assert.deepEqual(pp({ 'main.cpp': '#include "self.h"', 'self.h': '#include "self.h"' })
    .errors, ['#include nested too deeply']);
  assert.deepEqual(pp({ 'main.cpp': '#include "a.h" x', 'a.h': '' }).warnings,
    ['extra tokens at end of #include directive']);
});

test('defines the predefined macros', function () {
  assert.equal(expand('__cplusplus __STDC_HOSTED__ __DATE__ __TIME__'),
    norm('201103L 1 "Jan  5 2026" "09:07:03"'));
  assert.equal(expand('__CPP2JS_TARGET_ES5__ __CPP2JS_PLATFORM_BROWSER__ __CPP2JS_TARGET_ES6__'),
    '1 1 __CPP2JS_TARGET_ES6__');
  assert.equal(expand('__CPP2JS_TARGET_ES6__ __CPP2JS_PLATFORM_NODE__',
    { target: 'es6', platform: 'node' }), '1 1');
  assert.ok(/^[0-9]+$/.test(expand('__CPP2JS__')));
  assert.equal(expand('__COUNTER__ __COUNTER__ __COUNTER__'), '0 1 2');
});

test('applies command-line macros in order', function () {
  assert.equal(expand('A B C', { macros: [
    { kind: 'define', name: 'A', value: '1' },
    { kind: 'define', name: 'B', value: 'x y' },
    { kind: 'define', name: 'C', value: '' },
    { kind: 'undefine', name: 'C', value: null }
  ] }), '1 x y C');
  assert.equal(expand('__cplusplus', { macros: [{ kind: 'undefine', name: '__cplusplus',
    value: null }] }), '__cplusplus');
});

test('tracks __LINE__, __FILE__ and #line', function () {
  var r = pp({ 'main.cpp': '__LINE__ __FILE__\n#define L __LINE__\n\nL\n#line 100\n__LINE__\n' +
    '#line 7 "gen.y"\n__LINE__ __FILE__\nbad;' });
  assert.deepEqual(r.errors, []);
  assert.equal(r.text, '1 "main.cpp" 4 100 7 "gen.y" bad ;');
  assert.deepEqual(pp({ 'main.cpp': '#line 0\n#line x\n#line 1 x\n#line 99999999999' }).errors,
    ['#line directive requires a positive integer argument',
      '#line directive requires a positive integer argument',
      'invalid filename for #line directive', 'line number out of range in #line directive']);
});

test('diagnostics follow #line', function () {
  var r = pp({ 'main.cpp': '#line 50 "orig.cpp"\n#error here' });
  assert.equal(format.formatDiagnostic(r.bag.getAll()[0]),
    'orig.cpp:50:2: error: #error here\n#error here\n ^~~~~\n');
});

test('reports #error and #warning', function () {
  var r = pp({ 'main.cpp': '#error don\'t   do "this\n#warning careful  now\nx' });
  // An unterminated literal keeps the rest of the line as written.
  assert.deepEqual(r.errors, ['#error don\'t   do "this']);
  assert.deepEqual(r.warnings, ['#warning careful now']);
  assert.equal(r.text, 'x');
});

test('ignores unknown pragmas and handles _Pragma errors', function () {
  assert.equal(expand('#pragma GCC poison x\n#pragma\n_Pragma("message(\\"hi\\")") a'), 'a');
  assert.deepEqual(pp({ 'main.cpp': '_Pragma(x)' }).errors,
    ['_Pragma takes a parenthesized string literal']);
});

test('reports invalid directives', function () {
  assert.deepEqual(pp({ 'main.cpp': '#foo\n#include_next <x>\n# 12\n#\nok' }).errors,
    ['invalid preprocessing directive #foo', 'invalid preprocessing directive #include_next',
      'invalid preprocessing directive']);
  assert.equal(pp({ 'main.cpp': 'a # b' }).text, 'a # b');
});

test('records the macro expansion chain of every token', function () {
  var r = pp({ 'main.cpp': '#define A B + 1\n#define B x\nA' });
  var x = r.tokens[0];
  assert.equal(x.text, 'x');
  assert.equal(x.expansion.macro, 'B');
  assert.equal(x.expansion.site.text, 'B');
  assert.equal(x.expansion.site.expansion.macro, 'A');
  assert.equal(x.expansion.site.expansion.site.start, 28);
  assert.equal(r.tokens[1].expansion.macro, 'A');
});

test('reports errors in expanded code at the invocation', function () {
  var r = pp({ 'main.cpp': '#define DIV 1 / 0\n#if DIV\n#endif' });
  assert.equal(format.formatDiagnostic(r.bag.getAll()[0]),
    'main.cpp:2:5: error: division by zero in preprocessor expression\n#if DIV\n    ^~~\n');
});
