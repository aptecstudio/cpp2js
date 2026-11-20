'use strict';

var assert = require('assert');
var path = require('path');
var test = require('../harness').test;
var parseArgs = require('../../src/cli/parse-args').parseArgs;
var validateOptions = require('../../src/cli/validate-options').validateOptions;

function validate(args) {
  var parsed = parseArgs(args);
  var result;
  assert.deepEqual(parsed.errors, []);
  result = validateOptions(parsed.options);
  result.options = parsed.options;
  return result;
}

test('accepts a typical build and resolves defaults', function () {
  var r = validate(['a.cpp', '-o', path.join('dist', 'app.js')]);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.options.stdOut, path.join('dist', 'stdlib.js'));
  assert.equal(r.options.exports, 'global');
  assert.equal(validate(['a.cpp', '-o', 'app.js']).options.stdOut, 'stdlib.js');
});

test('derives --exports from the platform', function () {
  assert.equal(validate(['a.cpp', '--check', '--platform', 'node']).options.exports, 'exports');
  assert.equal(validate(['a.cpp', '--check', '--platform', 'mixed']).options.exports, 'both');
  assert.equal(validate(['a.cpp', '--check', '--platform', 'browser']).options.exports,
    'global');
  assert.equal(validate(['a.cpp', '--check', '--platform', 'node', '--exports', 'global'])
    .options.exports, 'global');
});

test('requires input files', function () {
  assert.deepEqual(validate(['--check']).errors, ['no input files']);
});

test('rejects mutually exclusive flags', function () {
  assert.deepEqual(validate(['a.cpp', '--check', '-Werror', '-w']).errors,
    ['\'-Werror\' and \'-w\' cannot be used together']);
  assert.deepEqual(validate(['a.cpp', '--check', '--quiet', '--verbose']).errors,
    ['\'--quiet\' and \'--verbose\' cannot be used together']);
  assert.deepEqual(validate(['a.cpp', '--check', '--exports', 'exports']).errors,
    ['\'--exports exports\' is not available on the browser platform']);
});

test('standard output needs an explicit standard library destination', function () {
  assert.deepEqual(validate(['a.cpp']).errors, ['when writing to standard output the ' +
    'standard library needs \'--std-out <file>\' or \'--embed-std\'']);
  assert.deepEqual(validate(['a.cpp', '--embed-std']).errors, []);
  assert.deepEqual(validate(['a.cpp', '--std-out', 'lib.js']).errors, []);
});

test('standard output does not accept an external source map', function () {
  assert.deepEqual(validate(['a.cpp', '--embed-std', '--source-map']).errors,
    ['an external source map needs \'-o\'; use \'--source-map inline\' when writing to ' +
    'standard output']);
  assert.deepEqual(validate(['a.cpp', '--embed-std', '--source-map', 'inline']).errors, []);
  assert.deepEqual(validate(['a.cpp', '-o', 'a.js', '--source-map']).errors, []);
});

test('rejects a standard library path equal to the bundle', function () {
  assert.deepEqual(validate(['a.cpp', '-o', 'stdlib.js']).errors,
    ['the bundle and the standard library would be written to the same file \'stdlib.js\'']);
  assert.deepEqual(validate(['a.cpp', '-o', 'x.js', '--std-out', './x.js']).errors,
    ['the bundle and the standard library would be written to the same file \'x.js\'']);
  assert.deepEqual(validate(['a.cpp', '-o', 'stdlib.js', '--embed-std']).errors, []);
});

test('warns about options without effect', function () {
  var r = validate(['a.cpp', '--embed-std', '--std-out', 'lib.js']);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, ['\'--std-out\' has no effect with \'--embed-std\'']);
  r = validate(['a.cpp', '--check', '-o', 'a.js', '--minify', '--source-map']);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings,
    ['\'-o\', \'--minify\', \'--source-map\' have no effect with \'--check\'']);
  assert.deepEqual(validate(['a.cpp', '--check', '--embed-std']).warnings,
    ['\'--embed-std\' has no effect with \'--check\'']);
});

test('--check needs no output destination', function () {
  var r = validate(['a.cpp', '--check']);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.options.stdOut, null);
});

test('checks and converts --error-limit', function () {
  var r = validate(['a.cpp', '--check']);
  assert.equal(r.options.errorLimit, 20);
  r = validate(['a.cpp', '--check', '--error-limit=0']);
  assert.equal(r.options.errorLimit, 0);
  r = validate(['a.cpp', '--check', '--error-limit', 'many']);
  assert.deepEqual(r.errors, ['invalid value \'many\' for \'--error-limit\': expected a ' +
    'non-negative integer']);
});
