'use strict';

var assert = require('assert');
var test = require('../harness').test;
var SourceFile = require('../../src/source/source-file');
var DiagnosticBag = require('../../src/diagnostics/diagnostic-bag');
var Preprocessor = require('../../src/preprocessor/preprocessor').Preprocessor;
var lexer = require('../../src/lexer/lexer');
var I = require('../../src/util/int64');

var TokenKind = lexer.TokenKind;

function lex(text) {
  var bag = new DiagnosticBag();
  var main = new SourceFile('t.cpp', text);
  var pp = new Preprocessor({ diagnostics: bag, readFile: function () { throw new Error(); },
    systemIncludePaths: [] }).run(main);
  var tokens = new lexer.Lexer(bag).lex(pp.tokens, main);
  return {
    tokens: tokens,
    errors: bag.getAll().filter(function (d) { return d.severity === 'error'; })
      .map(function (d) { return d.message; }),
    warnings: bag.getAll().filter(function (d) { return d.severity === 'warning'; })
      .map(function (d) { return d.message; })
  };
}

function one(text) {
  var r = lex(text);
  assert.deepEqual(r.errors, [], text);
  assert.equal(r.tokens.length, 2, text);
  return r.tokens[0];
}

function errorOf(text) {
  return lex(text).errors[0];
}

test('separates keywords from identifiers', function () {
  var tokens = lex('int main __js__ nullptr override final x_1').tokens;
  assert.deepEqual(tokens.map(function (t) { return t.kind + ':' + t.text; }), [
    'keyword:int', 'identifier:main', 'keyword:__js__', 'keyword:nullptr',
    'identifier:override', 'identifier:final', 'identifier:x_1', 'eof:'
  ]);
  assert.equal(Object.keys(lexer.KEYWORDS).length, 74);
});

test('decodes integer literals without choosing their type', function () {
  var tok = one('42');
  assert.equal(tok.kind, TokenKind.INTEGER);
  assert.equal(I.toString(tok.value.value, false), '42');
  assert.equal(tok.value.radix, 10);
  assert.equal(tok.value.unsigned, false);
  assert.equal(tok.value.longs, 0);
  assert.equal(I.toString(one('0x1F').value.value, false), '31');
  assert.equal(I.toString(one('017').value.value, false), '15');
  assert.equal(one('017').value.radix, 8);
  assert.equal(I.toString(one('0').value.value, false), '0');
  assert.equal(I.toString(one('0b1010').value.value, false), '10');
  assert.equal(I.toString(one('18446744073709551615u').value.value, false),
    '18446744073709551615');
  assert.equal(one('1u').value.unsigned, true);
  assert.equal(one('1l').value.longs, 1);
  assert.equal(one('1ULL').value.longs, 2);
  assert.equal(one('1llu').value.unsigned, true);
  assert.equal(one('12_km').value.udSuffix, '_km');
});

test('reports invalid integer literals', function () {
  assert.equal(errorOf('089'), 'invalid digit \'8\' in octal constant');
  assert.equal(errorOf('12abc'), 'invalid suffix \'abc\' on integer constant');
  assert.equal(errorOf('1lL'), 'invalid suffix \'lL\' on integer constant');
  assert.equal(errorOf('0x'), 'invalid integer constant \'0x\'');
  assert.equal(errorOf('18446744073709551616'),
    'integer literal is too large to be represented in any integer type');
});

test('decodes floating literals', function () {
  assert.equal(one('1.5').value.value, 1.5);
  assert.equal(one('.5').value.value, 0.5);
  assert.equal(one('1.').value.value, 1);
  assert.equal(one('1e3').value.value, 1000);
  assert.equal(one('1.5e-2').value.value, 0.015);
  assert.equal(one('2.5f').value.suffix, 'f');
  assert.equal(one('2.5L').value.suffix, 'l');
  assert.equal(one('0x1.8p1').value.value, 3);
  assert.equal(one('0x10p-4').value.value, 1);
  assert.equal(one('1.0_deg').value.udSuffix, '_deg');
  assert.equal(one('1.5').kind, TokenKind.FLOAT);
  assert.equal(errorOf('1e'), 'exponent has no digits');
  assert.equal(errorOf('1.5e+'), 'exponent has no digits');
  assert.equal(errorOf('1.5q'), 'invalid suffix \'q\' on floating constant');
  assert.equal(errorOf('0x1.8'), 'hexadecimal floating literal requires an exponent');
  assert.deepEqual(lex('1e999').warnings, ['floating constant exceeds range of \'double\'']);
});

test('decodes character literals', function () {
  assert.equal(one('\'a\'').value.value, 97);
  assert.equal(one('\'\\n\'').value.value, 10);
  assert.equal(one('\'\\xff\'').value.value, -1);
  assert.equal(one('u\'\\u00e9\'').value.value, 233);
  assert.equal(one('U\'\\U0001F600\'').value.encoding, 'U');
  assert.equal(one('L\'x\'').value.encoding, 'L');
  assert.equal(lex('\'ab\'').tokens[0].value.multi, true);
  assert.equal(errorOf('\'\''), 'empty character constant');
  assert.equal(errorOf('\'\\u12\''), 'incomplete universal character name');
  assert.equal(errorOf('\'\\ud800\''), 'invalid universal character');
});

test('decodes string literals into code units', function () {
  assert.deepEqual(one('"ab\\n"').value, { encoding: '', units: [97, 98, 10], udSuffix: null });
  assert.deepEqual(one('"\\u00e9"').value.units, [0xc3, 0xa9]);
  assert.deepEqual(one('u"\\U0001F600"').value.units, [0xd83d, 0xde00]);
  assert.deepEqual(one('U"\\U0001F600"').value.units, [0x1f600]);
  assert.deepEqual(one('"\\x41\\101"').value.units, [65, 65]);
  assert.deepEqual(one('R"(a\\n)"').value.units, [97, 92, 110]);
  assert.deepEqual(one('R"x(a)"b)x"').value.units, [97, 41, 34, 98]);
  assert.equal(errorOf('"\\x100"'), 'hex escape sequence out of range');
  assert.equal(one('u"\\x100"').value.units[0], 256);
});

test('concatenates adjacent string literals', function () {
  var tok = one('"ab" "c"\n"d"');
  assert.deepEqual(tok.value.units, [97, 98, 99, 100]);
  assert.equal(tok.start, 0);
  assert.equal(tok.end, 12);
  assert.deepEqual(one('"\\x12" "3"').value.units, [0x12, 51]);
  assert.equal(one('"a" L"b"').value.encoding, 'L');
  assert.deepEqual(one('u"a" "\\u00e9"').value.units, [97, 0xe9]);
  assert.equal(one('u8"a" "b"').value.encoding, 'u8');
  assert.equal(one('"a"_s "b"').value.udSuffix, '_s');
  assert.equal(errorOf('u"a" U"b"'), 'unsupported non-standard concatenation of string literals');
  assert.equal(errorOf('"a"_x "b"_y'),
    'differing user-defined suffixes (\'_x\' and \'_y\') in string literal concatenation');
  assert.equal(lex('"a" x "b"').tokens.length, 4);
});

test('reports stray tokens', function () {
  assert.deepEqual(lex('a @ b # c ## \\').errors, ['stray \'@\' in program',
    'stray \'#\' in program', 'stray \'##\' in program', 'stray \'\\\' in program']);
  assert.deepEqual(lex('"abc').errors, ['missing terminating \'"\' character']);
});

test('keeps punctuators canonical and positions', function () {
  var tokens = lex('a <: 0 :> and b').tokens;
  assert.equal(tokens[1].value, '[');
  assert.equal(tokens[3].value, ']');
  assert.equal(tokens[4].value, '&&');
  assert.equal(tokens[1].text, '<:');
  assert.equal(tokens[1].start, 2);
  assert.equal(tokens[tokens.length - 1].kind, TokenKind.EOF);
  assert.equal(tokens[tokens.length - 1].start, 15);
});

test('reports octal escapes out of range for narrow strings', function () {
  assert.equal(errorOf('"\\777"'), 'octal escape sequence out of range');
  assert.equal(one('L"\\777"').value.units[0], 511);
});
