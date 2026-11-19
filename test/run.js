'use strict';

/**
 * In-house test runner.
 *
 * Usage: `node test/run.js [filter]`
 *
 * Loads every `*.test.js` file under `test/` (except `test/fixtures/`), runs
 * the registered cases in order and prints one line per case. When a filter
 * is given, only cases whose "file > name" label contains it are run.
 * Exits with code 1 if any case fails or if a test file cannot be loaded.
 */

var fs = require('fs');
var path = require('path');
var harness = require('./harness');

var TEST_DIR = __dirname;
var SKIPPED_DIRS = { fixtures: true };

/**
 * Recursively collects test files, sorted for a deterministic order.
 *
 * @param {string} dir Absolute directory to scan.
 * @param {Array.<string>} out Accumulator of absolute paths.
 * @returns {Array.<string>} The accumulator.
 */
function collectTestFiles(dir, out) {
  var entries = fs.readdirSync(dir).sort();
  var i;
  var full;
  for (i = 0; i < entries.length; i++) {
    full = path.join(dir, entries[i]);
    if (fs.statSync(full).isDirectory()) {
      if (!SKIPPED_DIRS[entries[i]]) {
        collectTestFiles(full, out);
      }
    } else if (/\.test\.js$/.test(entries[i])) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Converts a path to a label relative to the test directory, with forward
 * slashes on every platform.
 *
 * @param {string} file Absolute path.
 * @returns {string}
 */
function relativeLabel(file) {
  return path.relative(TEST_DIR, file).split(path.sep).join('/');
}

/**
 * Formats a thrown value for the failure report.
 *
 * @param {*} err The value thrown by a test case.
 * @returns {string}
 */
function describeError(err) {
  var text = err && err.stack ? String(err.stack) : String(err);
  return '    ' + text.split('\n').join('\n    ');
}

function main() {
  var filter = process.argv[2] || '';
  var files = collectTestFiles(TEST_DIR, []);
  var loadFailures = 0;
  var passed = 0;
  var failed = [];
  var tests;
  var label;
  var i;

  for (i = 0; i < files.length; i++) {
    harness.setCurrentFile(relativeLabel(files[i]));
    try {
      require(files[i]);
    } catch (err) {
      loadFailures++;
      process.stdout.write('not ok - cannot load ' + relativeLabel(files[i]) + '\n');
      process.stdout.write(describeError(err) + '\n');
    }
  }
  harness.setCurrentFile(null);

  tests = harness.getTests();
  for (i = 0; i < tests.length; i++) {
    label = tests[i].file + ' > ' + tests[i].name;
    if (filter && label.indexOf(filter) === -1) {
      continue;
    }
    try {
      tests[i].fn();
      passed++;
      process.stdout.write('ok - ' + label + '\n');
    } catch (err) {
      failed.push(label);
      process.stdout.write('not ok - ' + label + '\n');
      process.stdout.write(describeError(err) + '\n');
    }
  }

  process.stdout.write('\n' + passed + ' passed, ' + failed.length + ' failed');
  if (loadFailures) {
    process.stdout.write(', ' + loadFailures + ' file(s) not loaded');
  }
  process.stdout.write('\n');
  for (i = 0; i < failed.length; i++) {
    process.stdout.write('  failed: ' + failed[i] + '\n');
  }

  process.exit(failed.length || loadFailures ? 1 : 0);
}

main();
