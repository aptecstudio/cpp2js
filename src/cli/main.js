'use strict';

var fs = require('fs');
var parseArgs = require('./parse-args').parseArgs;
var validateOptions = require('./validate-options').validateOptions;
var help = require('./help');
var DiagnosticBag = require('../diagnostics/diagnostic-bag');
var format = require('../diagnostics/format');
var Severity = require('../diagnostics/diagnostic').Severity;
var compiler = require('../index');

/** Exit codes (MEMORY.md section 3.4). */
var EXIT_SUCCESS = 0;
var EXIT_COMPILE_ERROR = 1;
var EXIT_USAGE = 2;

/**
 * Prints the diagnostics of a bag on standard error, honouring `--quiet`.
 *
 * @param {DiagnosticBag} bag
 * @param {boolean} quiet Print errors only.
 * @param {function(string)} write Standard error writer.
 * @returns {void}
 */
function printDiagnostics(bag, quiet, write) {
  var all = bag.getAll();
  var i;
  for (i = 0; i < all.length; i++) {
    if (!quiet || all[i].severity === Severity.ERROR) {
      write(format.formatDiagnostic(all[i]));
    }
  }
}

/**
 * Writes the compilation outputs.
 *
 * @param {Array.<{path: ?string, contents: string}>} files
 * @param {Object} io See `run`.
 * @returns {void}
 */
function writeOutputs(files, io) {
  var writeFile = io.writeFile || function (file, contents) {
    fs.writeFileSync(file, contents);
  };
  var i;
  for (i = 0; i < files.length; i++) {
    if (files[i].path === null) {
      io.stdout(files[i].contents);
    } else {
      writeFile(files[i].path, files[i].contents);
    }
  }
}

/**
 * Runs the command-line interface.
 *
 * @param {Array.<string>} args Arguments (`process.argv.slice(2)`).
 * @param {{stdout: function(string), stderr: function(string),
 *          readFile: (function(string): string|undefined),
 *          writeFile: (function(string, string)|undefined)}} io
 *   Output writers; diagnostics always go to `stderr` (D-021). `readFile`
 *   and `writeFile` default to the file system; tests replace them.
 *   Output files with a null path are the bundle written to `stdout`.
 * @returns {number} Exit code: 0 success, 1 compilation errors, 2 usage.
 */
function run(args, io) {
  var parsed = parseArgs(args);
  var options = parsed.options;
  var usage;
  var validation;
  var result;
  var i;

  if (!parsed.errors.length && options.help) {
    io.stdout(help.getHelpText());
    return EXIT_SUCCESS;
  }
  if (!parsed.errors.length && options.version) {
    io.stdout(help.getVersionText());
    return EXIT_SUCCESS;
  }

  validation = parsed.errors.length ? { errors: [], warnings: [] } : validateOptions(options);
  // Usage warnings follow the same -w / -Werror policy as compiler warnings.
  usage = new DiagnosticBag({
    warningsAsErrors: options.warningsAsErrors && !options.ignoreWarnings,
    ignoreWarnings: options.ignoreWarnings && !options.warningsAsErrors
  });
  for (i = 0; i < parsed.errors.length; i++) {
    usage.error(parsed.errors[i]);
  }
  for (i = 0; i < validation.errors.length; i++) {
    usage.error(validation.errors[i]);
  }
  for (i = 0; i < validation.warnings.length; i++) {
    usage.warning(validation.warnings[i]);
  }
  printDiagnostics(usage, options.quiet, io.stderr);
  if (usage.hasErrors()) {
    io.stderr('Try \'cpp2js --help\' for more information.\n');
    return EXIT_USAGE;
  }

  if (io.readFile) {
    options.readFile = io.readFile;
  }
  result = compiler.compile(options);
  printDiagnostics(result.diagnostics, options.quiet, io.stderr);
  if (result.success) {
    writeOutputs(result.files, io);
  }
  if (!options.quiet) {
    io.stderr(format.formatSummary(result.diagnostics.errorCount,
      result.diagnostics.warningCount));
  }
  return result.success ? EXIT_SUCCESS : EXIT_COMPILE_ERROR;
}

module.exports = {
  EXIT_SUCCESS: EXIT_SUCCESS,
  EXIT_COMPILE_ERROR: EXIT_COMPILE_ERROR,
  EXIT_USAGE: EXIT_USAGE,
  run: run
};
