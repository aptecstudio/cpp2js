'use strict';

/**
 * Minimal test harness: test files register cases with `test(name, fn)`;
 * the runner (`test/run.js`) executes them. No external framework is used.
 */

var registry = [];
var currentFile = null;

/**
 * Registers a test case.
 *
 * @param {string} name Human-readable name of the case.
 * @param {Function} fn Body of the case; it fails by throwing (usually via
 *   the `assert` module).
 * @returns {void}
 */
function test(name, fn) {
  if (typeof name !== 'string' || typeof fn !== 'function') {
    throw new TypeError('test(name, fn) expects a string and a function');
  }
  registry.push({ name: name, fn: fn, file: currentFile });
}

/**
 * Sets the file that subsequent `test()` calls are attributed to.
 * Used by the runner only.
 *
 * @param {string|null} file Path relative to the test directory.
 * @returns {void}
 */
function setCurrentFile(file) {
  currentFile = file;
}

/**
 * Returns the registered test cases, in registration order.
 *
 * @returns {Array.<{name: string, fn: Function, file: (string|null)}>}
 */
function getTests() {
  return registry.slice();
}

module.exports = {
  test: test,
  setCurrentFile: setCurrentFile,
  getTests: getTests
};
