'use strict';

/**
 * Fixture-based end-to-end tests of the CLI (D-029).
 *
 * Every directory under `test/fixtures/` that contains `.cpp` files or an
 * `args` file is a fixture:
 *
 *     test/fixtures/<group>/<name>/
 *       *.cpp, *.h ...    inputs (paths in diagnostics are relative to here)
 *       args              optional: CLI arguments, one per line; default:
 *                         every .cpp file, sorted, then `-o out.js`
 *       expected/         files the build must write, at their relative path
 *       expected.stdout   optional: expected standard output (default empty)
 *       expected.stderr   optional: expected standard error (default empty)
 *       expected.exit     optional: expected exit code (default 0)
 *
 * The CLI runs in memory: inputs are read from the fixture directory and
 * outputs are captured, so nothing is written to disk. Setting the
 * environment variable `CPP2JS_UPDATE_FIXTURES=1` rewrites the expectations
 * from the actual results instead of comparing them.
 */

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var test = require('./harness').test;
var cli = require('../src/cli/main');

var FIXTURES_DIR = path.join(__dirname, 'fixtures');
var UPDATE = process.env.CPP2JS_UPDATE_FIXTURES === '1';

function isFixture(dir) {
  var entries = fs.readdirSync(dir);
  var i;
  for (i = 0; i < entries.length; i++) {
    if (entries[i] === 'args' || /\.cpp$/.test(entries[i])) {
      return true;
    }
  }
  return false;
}

function collectFixtures(dir, out) {
  var entries;
  var full;
  var i;
  if (!fs.existsSync(dir)) {
    return out;
  }
  if (isFixture(dir)) {
    out.push(dir);
    return out;
  }
  entries = fs.readdirSync(dir).sort();
  for (i = 0; i < entries.length; i++) {
    full = path.join(dir, entries[i]);
    if (fs.statSync(full).isDirectory()) {
      collectFixtures(full, out);
    }
  }
  return out;
}

function readOptional(file, fallback) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : fallback;
}

/** Recursively lists files under `dir`, as forward-slash relative paths. */
function listFiles(dir, prefix, out) {
  var entries;
  var full;
  var i;
  if (!fs.existsSync(dir)) {
    return out;
  }
  entries = fs.readdirSync(dir).sort();
  for (i = 0; i < entries.length; i++) {
    full = path.join(dir, entries[i]);
    if (fs.statSync(full).isDirectory()) {
      listFiles(full, prefix + entries[i] + '/', out);
    } else {
      out.push(prefix + entries[i]);
    }
  }
  return out;
}

/** Creates the missing directories of a path (no recursive mkdir in Node 0.10). */
function makeDirs(dir) {
  if (!fs.existsSync(dir)) {
    makeDirs(path.dirname(dir));
    fs.mkdirSync(dir);
  }
}

function getArgs(dir) {
  var text = readOptional(path.join(dir, 'args'), null);
  var args = [];
  var lines;
  var i;
  if (text === null) {
    args = fs.readdirSync(dir).filter(function (name) {
      return /\.cpp$/.test(name);
    }).sort();
    return args.concat(['-o', 'out.js']);
  }
  lines = text.split('\n');
  for (i = 0; i < lines.length; i++) {
    if (lines[i] !== '') {
      args.push(lines[i]);
    }
  }
  return args;
}

function runFixture(dir) {
  var actual = { stdout: '', stderr: '', files: {} };
  actual.exit = cli.run(getArgs(dir), {
    stdout: function (text) { actual.stdout += text; },
    stderr: function (text) { actual.stderr += text; },
    readFile: function (file) {
      return fs.readFileSync(path.join(dir, file), 'utf8');
    },
    writeFile: function (file, contents) {
      actual.files[file.split(path.sep).join('/')] = contents;
    }
  });
  return actual;
}

function updateFixture(dir, actual) {
  var expectedDir = path.join(dir, 'expected');
  var old = listFiles(expectedDir, '', []);
  var name;
  var i;
  for (i = 0; i < old.length; i++) {
    fs.unlinkSync(path.join(expectedDir, old[i]));
  }
  for (name in actual.files) {
    if (actual.files.hasOwnProperty(name)) {
      makeDirs(path.dirname(path.join(expectedDir, name)));
      fs.writeFileSync(path.join(expectedDir, name), actual.files[name]);
    }
  }
  writeOrRemove(path.join(dir, 'expected.stdout'), actual.stdout, '');
  writeOrRemove(path.join(dir, 'expected.stderr'), actual.stderr, '');
  writeOrRemove(path.join(dir, 'expected.exit'), actual.exit + '\n', '0\n');
}

function writeOrRemove(file, contents, defaultContents) {
  if (contents === defaultContents) {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  } else {
    fs.writeFileSync(file, contents);
  }
}

/** Fails with both values printed, so the difference is visible. */
function expectEqual(actualValue, expectedValue, what) {
  if (actualValue !== expectedValue) {
    throw new assert.AssertionError({
      message: what + ' differs\n--- expected\n' + expectedValue + '\n--- actual\n' +
        actualValue + '\n---\n(set CPP2JS_UPDATE_FIXTURES=1 to accept the actual result)',
      actual: actualValue,
      expected: expectedValue,
      operator: '==='
    });
  }
}

function checkFixture(dir, actual) {
  var expectedDir = path.join(dir, 'expected');
  var expectedFiles = listFiles(expectedDir, '', []);
  var actualFiles = [];
  var name;
  var i;
  expectEqual(actual.exit, Number(readOptional(path.join(dir, 'expected.exit'), '0')),
    'exit code');
  expectEqual(actual.stderr, readOptional(path.join(dir, 'expected.stderr'), ''), 'stderr');
  expectEqual(actual.stdout, readOptional(path.join(dir, 'expected.stdout'), ''), 'stdout');
  for (name in actual.files) {
    if (actual.files.hasOwnProperty(name)) {
      actualFiles.push(name);
    }
  }
  expectEqual(actualFiles.sort().join('\n'), expectedFiles.join('\n'), 'list of written files');
  for (i = 0; i < expectedFiles.length; i++) {
    expectEqual(actual.files[expectedFiles[i]],
      fs.readFileSync(path.join(expectedDir, expectedFiles[i]), 'utf8'), expectedFiles[i]);
  }
}

(function registerFixtures() {
  var fixtures = collectFixtures(FIXTURES_DIR, []);
  var i;
  for (i = 0; i < fixtures.length; i++) {
    (function (dir) {
      var label = path.relative(FIXTURES_DIR, dir).split(path.sep).join('/');
      test(label, function () {
        var actual = runFixture(dir);
        if (UPDATE) {
          updateFixture(dir, actual);
        } else {
          checkFixture(dir, actual);
        }
      });
    }(fixtures[i]));
  }
}());
