'use strict';

var assert = require('assert');
var test = require('../harness').test;
var SourceFile = require('../../src/source/source-file');
var DiagnosticBag = require('../../src/diagnostics/diagnostic-bag');
var ppLexer = require('../../src/preprocessor/pp-lexer');

var TokenKind = ppLexer.TokenKind;

function lex(text) {
  var bag = new DiagnosticBag();
  var tokens = ppLexer.tokenizeAll(new SourceFile('t.cpp', text), bag);
  return { tokens: tokens, bag: bag };
}

function kinds(text) {
  return lex(text).tokens.map(function (t) { return t.kind + ':' + t.text; });
}

test('lexes identifiers, numbers and punctuators', function () {
  assert.deepEqual(kinds('int x_1 = 0x1F + 1.5e+3;'), [
    'identifier:int', 'identifier:x_1', 'punct:=', 'number:0x1F', 'punct:+',
    'number:1.5e+3', 'punct:;'
  ]);
  assert.deepEqual(kinds('a->*b <<= c ... ::d .5'), [
    'identifier:a', 'punct:->*', 'identifier:b', 'punct:<<=', 'identifier:c', 'punct:...',
    'punct:::', 'identifier:d', 'number:.5'
  ]);
  assert.deepEqual(kinds('1e-x 0x1p-3 12_km'), ['number:1e-x', 'number:0x1p-3', 'number:12_km']);
});

test('normalizes digraphs and applies the <:: rule', function () {
  var tokens = lex('<: :> <% %> %: %:%: <::a <::>').tokens;
  assert.deepEqual(tokens.map(function (t) { return t.value; }),
    ['[', ']', '{', '}', '#', '##', '<', '::', 'a', '[', ']']);
  assert.equal(tokens[0].text, '<:');
});

test('lexes character and string literals with prefixes and suffixes', function () {
  assert.deepEqual(kinds('\'a\' u\'b\' L"w" u8"x" U"y" "a\\"b" "s"_sv \'\\\'\''), [
    'char:\'a\'', 'char:u\'b\'', 'string:L"w"', 'string:u8"x"', 'string:U"y"',
    'string:"a\\"b"', 'string:"s"_sv', 'char:\'\\\'\''
  ]);
});

test('lexes raw strings and keeps their splices', function () {
  var r = lex('R"(a\\\nb)" uR"x(")")x" LR"()"');
  assert.equal(r.bag.errorCount, 0);
  assert.deepEqual(r.tokens.map(function (t) { return t.text; }),
    ['R"(a\\\nb)"', 'uR"x(")")x"', 'LR"()"']);
});

test('reports unterminated literals and comments', function () {
  assert.equal(lex('"abc\nx').bag.getAll()[0].message, 'missing terminating \'"\' character');
  assert.equal(lex('\'a').bag.getAll()[0].message, 'missing terminating \' character');
  assert.equal(lex('a /* b').bag.getAll()[0].message, 'unterminated /* comment');
  assert.equal(lex('R"(abc').bag.getAll()[0].message, 'unterminated raw string');
  assert.equal(lex('R"a b(x)a b"').bag.getAll()[0].message, 'invalid raw string delimiter');
});

test('quiet mode suppresses lexical errors', function () {
  var bag = new DiagnosticBag();
  var lexer = new ppLexer.PPLexer(new SourceFile('t.cpp', 'don\'t stop\nx'), bag);
  lexer.skipLine();
  assert.equal(bag.errorCount, 0);
  assert.equal(lexer.next().text, 'x');
});

test('tracks line starts and preceding whitespace', function () {
  var tokens = lex('a b\n  c/**/d /* x\n y */ e\n#f').tokens;
  assert.deepEqual(tokens.map(function (t) {
    return t.text + (t.lineStart ? '^' : '') + (t.spaceBefore ? '_' : '');
  }), ['a^', 'b_', 'c^_', 'd_', 'e_', '#^_', 'f']);
});

test('splices lines and maps positions to the original text', function () {
  var source = new SourceFile('t.cpp', 'ab\\\ncd e\\\r\nf');
  var tokens = ppLexer.tokenizeAll(source, new DiagnosticBag());
  assert.deepEqual(tokens.map(function (t) { return t.text; }), ['abcd', 'ef']);
  assert.equal(tokens[0].start, 0);
  assert.equal(tokens[0].end, 6);
  assert.deepEqual(source.getPosition(tokens[1].start), { line: 2, column: 4 });
  assert.equal(source.text.slice(tokens[1].start, tokens[1].end), 'e\\\r\nf');
});

test('skips a byte order mark and comments', function () {
  assert.deepEqual(kinds('﻿a // c\n/* d */b'), ['identifier:a', 'identifier:b']);
});

test('stops at the end of a directive line', function () {
  var lexer = new ppLexer.PPLexer(new SourceFile('t.cpp', 'a b // c\nd'), new DiagnosticBag());
  assert.equal(lexer.next(true).text, 'a');
  assert.equal(lexer.atEndOfLine(), false);
  assert.equal(lexer.next(true).text, 'b');
  assert.equal(lexer.atEndOfLine(), true);
  assert.equal(lexer.next(true).kind, TokenKind.EOF);
  assert.equal(lexer.next(true).kind, TokenKind.EOF);
  assert.equal(lexer.next().text, 'd');
});

test('lexes header names on request', function () {
  var lexer = new ppLexer.PPLexer(new SourceFile('t.cpp', ' <node/fs> "x"'), new DiagnosticBag());
  var tok = lexer.nextHeaderName();
  assert.equal(tok.kind, TokenKind.HEADER_NAME);
  assert.equal(tok.value, 'node/fs');
  assert.equal(lexer.nextHeaderName(), null);
  assert.equal(lexer.next(true).kind, TokenKind.STRING);
});

test('reports stray characters as other tokens', function () {
  assert.deepEqual(kinds('a @ \\ b'), ['identifier:a', 'other:@', 'other:\\', 'identifier:b']);
});

test('lexes alternative tokens as operators', function () {
  var tokens = lex('a and b or not c bitand d xor_eq e compl f').tokens;
  assert.deepEqual(tokens.map(function (t) { return t.kind + ':' + t.value; }), [
    'identifier:a', 'punct:&&', 'identifier:b', 'punct:||', 'punct:!', 'identifier:c',
    'punct:&', 'identifier:d', 'punct:^=', 'identifier:e', 'punct:~', 'identifier:f'
  ]);
  assert.equal(tokens[1].text, 'and');
});
