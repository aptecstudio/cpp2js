'use strict';

var path = require('path');

/** Default file name of the separate standard library (D-028). */
var STD_FILE_NAME = 'stdlib.js';

var DEFAULT_EXPORTS = {
  browser: 'global',
  node: 'exports',
  mixed: 'both'
};

/**
 * Checks the combination rules of D-021 and D-028 and resolves the defaults
 * that depend on other options. Help and version requests are not checked:
 * the caller handles them first.
 *
 * Errors make the CLI stop with exit code 2. Warnings flag options that
 * have no effect; the compilation goes on (D-028).
 *
 * @param {Object} options Parsed options (see `parse-args.js`); `exports`
 *   and `stdOut` are filled in when they were not given.
 * @returns {{errors: Array.<string>, warnings: Array.<string>}}
 */
function validateOptions(options) {
  var errors = [];
  var warnings = [];
  var ignoredByCheck = [];
  var hasOutput = options.output !== null;

  if (!options.inputs.length) {
    errors.push('no input files');
  }
  if (options.warningsAsErrors && options.ignoreWarnings) {
    errors.push('\'-Werror\' and \'-w\' cannot be used together');
  }
  if (options.quiet && options.verbose) {
    errors.push('\'--quiet\' and \'--verbose\' cannot be used together');
  }
  if (options.platform === 'browser' && options.exports === 'exports') {
    errors.push('\'--exports exports\' is not available on the browser platform');
  }
  if (options.exports === null) {
    options.exports = DEFAULT_EXPORTS[options.platform];
  }

  if (options.check) {
    // Nothing is written: output-related options have no effect.
    if (hasOutput) {
      ignoredByCheck.push('-o');
    }
    if (options.minify) {
      ignoredByCheck.push('--minify');
    }
    if (options.sourceMap !== null) {
      ignoredByCheck.push('--source-map');
    }
    if (options.embedStd) {
      ignoredByCheck.push('--embed-std');
    }
    if (options.stdOut !== null) {
      ignoredByCheck.push('--std-out');
    }
    if (ignoredByCheck.length) {
      warnings.push('\'' + ignoredByCheck.join('\', \'') + '\' ' +
        (ignoredByCheck.length === 1 ? 'has' : 'have') + ' no effect with \'--check\'');
    }
    return { errors: errors, warnings: warnings };
  }

  if (options.embedStd && options.stdOut !== null) {
    warnings.push('\'--std-out\' has no effect with \'--embed-std\'');
  }
  if (!hasOutput) {
    if (options.sourceMap === 'external') {
      errors.push('an external source map needs \'-o\'; use \'--source-map inline\' ' +
        'when writing to standard output');
    }
    if (!options.embedStd && options.stdOut === null) {
      errors.push('when writing to standard output the standard library needs ' +
        '\'--std-out <file>\' or \'--embed-std\'');
    }
  } else if (!options.embedStd && options.stdOut === null) {
    options.stdOut = path.join(path.dirname(options.output), STD_FILE_NAME);
  }
  if (hasOutput && !options.embedStd &&
      path.resolve(options.stdOut) === path.resolve(options.output)) {
    errors.push('the bundle and the standard library would be written to the same file \'' +
      options.output + '\'');
  }

  return { errors: errors, warnings: warnings };
}

module.exports = {
  STD_FILE_NAME: STD_FILE_NAME,
  validateOptions: validateOptions
};
