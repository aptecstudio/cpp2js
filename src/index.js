'use strict';

/**
 * Programmatic API of cpp2js.
 *
 * Pipeline status: inputs are loaded and preprocessed (Phase 3); the
 * following phases are not implemented yet, so a successful preprocessing
 * ends with an error saying so. The signature and result shape are the
 * ones the phases will fill in.
 */

var fs = require('fs');
var SourceFile = require('./source/source-file');
var DiagnosticBag = require('./diagnostics/diagnostic-bag');
var Preprocessor = require('./preprocessor/preprocessor').Preprocessor;

/**
 * Reads a file as UTF-8 text (default `readFile` of `compile`).
 *
 * @param {string} file
 * @returns {string}
 */
function readFileUtf8(file) {
  return fs.readFileSync(file, 'utf8');
}

/**
 * Compiles C++ translation units.
 *
 * @param {Object} options Options in the shape produced by the CLI parser
 *   (`src/cli/parse-args.js`): `inputs`, `target`, `platform`, `check`,
 *   `warningsAsErrors`, `ignoreWarnings`, ...
 * @param {function(string): string} [options.readFile] Reads a file;
 *   defaults to `fs.readFileSync` in UTF-8. Lets callers and tests supply
 *   sources without touching the disk.
 * @param {Array.<string>} [options.systemIncludePaths] Overrides the
 *   directory of the headers shipped with cpp2js (tests only).
 * @returns {{success: boolean, diagnostics: DiagnosticBag,
 *   sources: Array.<SourceFile>, units: Array.<{source: SourceFile,
 *   tokens: Array.<Object>}>, files: Array.<{path: ?string, contents: string}>}}
 *   `units` holds the preprocessed tokens of each translation unit.
 *   `files` lists the outputs to write (none with `check`); a null path
 *   means standard output.
 */
function compile(options) {
  var diagnostics = new DiagnosticBag({
    warningsAsErrors: options.warningsAsErrors,
    ignoreWarnings: options.ignoreWarnings
  });
  var readFile = options.readFile || readFileUtf8;
  var sources = [];
  var units = [];
  var result;
  var i;

  for (i = 0; i < options.inputs.length; i++) {
    try {
      sources.push(new SourceFile(options.inputs[i], readFile(options.inputs[i])));
    } catch (err) {
      diagnostics.error('cannot read \'' + options.inputs[i] + '\': ' +
        (err && err.code === 'ENOENT' ? 'no such file or directory' : String(err.message)));
    }
  }

  // Each translation unit is preprocessed with a fresh macro table.
  for (i = 0; i < sources.length; i++) {
    result = new Preprocessor({
      diagnostics: diagnostics,
      readFile: readFile,
      includePaths: options.includePaths,
      systemIncludePaths: options.systemIncludePaths,
      macros: options.macros,
      target: options.target,
      platform: options.platform
    }).run(sources[i]);
    units.push({ source: sources[i], tokens: result.tokens });
  }

  if (!diagnostics.hasErrors()) {
    diagnostics.error('compilation is not implemented yet');
  }

  return {
    success: !diagnostics.hasErrors(),
    diagnostics: diagnostics,
    sources: sources,
    units: units,
    files: []
  };
}

module.exports = {
  compile: compile
};
