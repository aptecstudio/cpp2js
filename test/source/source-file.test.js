'use strict';

var assert = require('assert');
var test = require('../harness').test;
var SourceFile = require('../../src/source/source-file');

test('keeps path and text', function () {
  var file = new SourceFile('a.cpp', 'int x;');
  assert.equal(file.path, 'a.cpp');
  assert.equal(file.text, 'int x;');
});

test('counts lines with every kind of terminator', function () {
  assert.equal(new SourceFile('a', '').getLineCount(), 1);
  assert.equal(new SourceFile('a', 'x').getLineCount(), 1);
  assert.equal(new SourceFile('a', 'x\n').getLineCount(), 2);
  assert.equal(new SourceFile('a', 'a\nb\r\nc\rd').getLineCount(), 4);
  assert.equal(new SourceFile('a', '\r\n\r\n').getLineCount(), 3);
});

test('maps offsets to 1-based positions', function () {
  var file = new SourceFile('a', 'ab\ncd\r\nef\rgh');
  assert.deepEqual(file.getPosition(0), { line: 1, column: 1 });
  assert.deepEqual(file.getPosition(1), { line: 1, column: 2 });
  assert.deepEqual(file.getPosition(2), { line: 1, column: 3 });
  assert.deepEqual(file.getPosition(3), { line: 2, column: 1 });
  assert.deepEqual(file.getPosition(5), { line: 2, column: 3 });
  assert.deepEqual(file.getPosition(6), { line: 2, column: 4 });
  assert.deepEqual(file.getPosition(7), { line: 3, column: 1 });
  assert.deepEqual(file.getPosition(10), { line: 4, column: 1 });
  assert.deepEqual(file.getPosition(12), { line: 4, column: 3 });
});

test('clamps offsets past the end and rejects invalid ones', function () {
  var file = new SourceFile('a', 'ab\ncd');
  assert.deepEqual(file.getPosition(100), { line: 2, column: 3 });
  assert.throws(function () { file.getPosition(-1); }, RangeError);
  assert.throws(function () { file.getPosition(1.5); }, RangeError);
});

test('maps positions back to offsets', function () {
  var file = new SourceFile('a', 'ab\ncd\r\nef');
  var offset;
  assert.equal(file.getOffset(1, 1), 0);
  assert.equal(file.getOffset(2, 2), 4);
  assert.equal(file.getOffset(3, 1), 7);
  assert.equal(file.getOffset(2, 99), 5);
  for (offset = 0; offset < file.text.length; offset++) {
    if (file.text.charAt(offset) !== '\n' && file.text.charAt(offset) !== '\r') {
      assert.equal(file.getOffset(file.getPosition(offset).line,
        file.getPosition(offset).column), offset);
    }
  }
  assert.throws(function () { file.getOffset(0, 1); }, RangeError);
  assert.throws(function () { file.getOffset(4, 1); }, RangeError);
  assert.throws(function () { file.getOffset(1, 0); }, RangeError);
});

test('returns line text without terminators', function () {
  var file = new SourceFile('a', 'ab\ncd\r\nef\rgh\n');
  assert.equal(file.getLineText(1), 'ab');
  assert.equal(file.getLineText(2), 'cd');
  assert.equal(file.getLineText(3), 'ef');
  assert.equal(file.getLineText(4), 'gh');
  assert.equal(file.getLineText(5), '');
  assert.throws(function () { file.getLineText(6); }, RangeError);
});
