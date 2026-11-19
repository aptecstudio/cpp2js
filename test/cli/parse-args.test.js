'use strict';

var assert = require('assert');
var test = require('../harness').test;
var parseArgs = require('../../src/cli/parse-args').parseArgs;

function parse(args) {
  return parseArgs(args);
}

test('applies defaults', function () {
  var r = parse(['a.cpp']);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.options.inputs, ['a.cpp']);
  assert.equal(r.options.output, null);
  assert.equal(r.options.target, 'es5');
  assert.equal(r.options.platform, 'browser');
  assert.equal(r.options.exports, null);
  assert.equal(r.options.sourceMap, null);
  assert.equal(r.options.minify, false);
});

test('parses separate and attached values', function () {
  var r = parse(['-o', 'out.js', '--target', 'es6', '--platform=node', 'a.cpp', 'b.cpp',
    '-Iinc', '-I', 'lib', '--std-out=std.js', '--exports', 'both']);
  assert.deepEqual(r.errors, []);
  assert.equal(r.options.output, 'out.js');
  assert.equal(r.options.target, 'es6');
  assert.equal(r.options.platform, 'node');
  assert.equal(r.options.exports, 'both');
  assert.equal(r.options.stdOut, 'std.js');
  assert.deepEqual(r.options.inputs, ['a.cpp', 'b.cpp']);
  assert.deepEqual(r.options.includePaths, ['inc', 'lib']);
  assert.equal(parse(['-oout.js']).options.output, 'out.js');
  assert.equal(parse(['--output=x.js']).options.output, 'x.js');
});

test('parses boolean flags', function () {
  var o = parse(['--minify', '--embed-std', '--check', '-Werror', '-w', '--quiet',
    '--verbose', '-h', '-v']).options;
  assert.equal(o.minify, true);
  assert.equal(o.embedStd, true);
  assert.equal(o.check, true);
  assert.equal(o.warningsAsErrors, true);
  assert.equal(o.ignoreWarnings, true);
  assert.equal(o.quiet, true);
  assert.equal(o.verbose, true);
  assert.equal(o.help, true);
  assert.equal(o.version, true);
  assert.equal(parse(['--help']).options.help, true);
  assert.equal(parse(['--version']).options.version, true);
});

test('keeps macro operations in order', function () {
  var r = parse(['-DDEBUG', '-D', 'LEVEL=3', '-UDEBUG', '-DEMPTY=', '-U', 'X']);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.options.macros, [
    { kind: 'define', name: 'DEBUG', value: '1' },
    { kind: 'define', name: 'LEVEL', value: '3' },
    { kind: 'undefine', name: 'DEBUG', value: null },
    { kind: 'define', name: 'EMPTY', value: '' },
    { kind: 'undefine', name: 'X', value: null }
  ]);
});

test('rejects invalid macro names', function () {
  assert.deepEqual(parse(['-D1X']).errors, ['macro name must be an identifier: \'1X\'']);
  assert.deepEqual(parse(['-UA=1']).errors, ['macro name must be an identifier: \'A=1\'']);
  assert.deepEqual(parse(['-D=1']).errors, ['macro name must be an identifier: \'\'']);
});

test('handles the optional value of --source-map', function () {
  assert.equal(parse(['--source-map', 'a.cpp']).options.sourceMap, 'external');
  assert.deepEqual(parse(['--source-map', 'a.cpp']).options.inputs, ['a.cpp']);
  assert.equal(parse(['--source-map', 'inline', 'a.cpp']).options.sourceMap, 'inline');
  assert.equal(parse(['--source-map', 'external']).options.sourceMap, 'external');
  assert.equal(parse(['--source-map=inline']).options.sourceMap, 'inline');
  assert.equal(parse(['a.cpp', '--source-map']).options.sourceMap, 'external');
  assert.deepEqual(parse(['--source-map=both']).errors,
    ['invalid value \'both\' for \'--source-map\' (expected external, inline)']);
});

test('last value wins for repeated options', function () {
  var o = parse(['--target', 'es6', '--target', 'es5', '-o', 'a.js', '-o', 'b.js']).options;
  assert.equal(o.target, 'es5');
  assert.equal(o.output, 'b.js');
});

test('treats everything after -- as input files', function () {
  var r = parse(['--', '-weird.cpp', '--help']);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.options.inputs, ['-weird.cpp', '--help']);
  assert.equal(r.options.help, false);
});

test('reports usage errors', function () {
  assert.deepEqual(parse(['--frobnicate']).errors, ['unknown option \'--frobnicate\'']);
  assert.deepEqual(parse(['-Wall']).errors, ['unknown option \'-Wall\'']);
  assert.deepEqual(parse(['-o']).errors, ['missing argument to \'-o\'']);
  assert.deepEqual(parse(['--output=']).errors, ['missing argument to \'--output\'']);
  assert.deepEqual(parse(['--target', 'es7']).errors,
    ['invalid value \'es7\' for \'--target\' (expected es5, es6)']);
  assert.deepEqual(parse(['--platform=deno']).errors,
    ['invalid value \'deno\' for \'--platform\' (expected browser, node, mixed)']);
  assert.deepEqual(parse(['--minify=yes']).errors,
    ['option \'--minify\' does not take a value']);
  assert.deepEqual(parse(['-']).errors, ['reading from standard input is not supported']);
});
