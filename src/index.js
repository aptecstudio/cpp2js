'use strict';

/**
 * Programmatic API of cpp2js.
 *
 * The compilation phases are not implemented yet: `compile()` currently
 * loads the input files and reports that the pipeline is missing. Its
 * signature and result shape are the ones the phases will fill in.
 */

var fs = require('fs');
var SourceFile = require('./source/source-file');
var DiagnosticBag = require('./diagnostics/diagnostic-bag');

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
 * @returns {{success: boolean, diagnostics: DiagnosticBag,
 *   sources: Array.<SourceFile>, files: Array.<{path: string, contents: string}>}}
 *   `files` lists the outputs to write (none with `check`).
 */
function compile(options) {
  var diagnostics = new DiagnosticBag({
    warningsAsErrors: options.warningsAsErrors,
    ignoreWarnings: options.ignoreWarnings
  });
  var readFile = options.readFile || readFileUtf8;
  var sources = [];
  var i;

  for (i = 0; i < options.inputs.length; i++) {
    try {
      sources.push(new SourceFile(options.inputs[i], readFile(options.inputs[i])));
    } catch (err) {
      diagnostics.error('cannot read \'' + options.inputs[i] + '\': ' +
        (err && err.code === 'ENOENT' ? 'no such file or directory' : String(err.message)));
    }
  }

  if (!diagnostics.hasErrors()) {
    diagnostics.error('compilation is not implemented yet');
  }

  return {
    success: !diagnostics.hasErrors(),
    diagnostics: diagnostics,
    sources: sources,
    files: []
  };
}

module.exports = {
  compile: compile
};
