'use strict';

var pkg = require('../../package.json');

var HELP_LINES = [
  'Usage: cpp2js [options] <file.cpp>...',
  '',
  'Transpiles C++ translation units into a single JavaScript bundle.',
  '',
  'Output:',
  '  -o, --output <file>    Write the bundle to <file> (default: stdout)',
  '  --target <es5|es6>     JavaScript level of the output (default: es5)',
  '  --platform <name>      browser, node or mixed (default: browser)',
  '  --exports <where>      Where extern "C" symbols go: exports, global or',
  '                         both (default: global on browser, exports on',
  '                         node, both on mixed)',
  '  --minify               Minified instead of pretty output',
  '  --source-map [kind]    Emit a source map: external (default) or inline',
  '  --embed-std            Embed the standard library in the bundle',
  '  --std-out <file>       Path of the separate standard library file',
  '                         (default: stdlib.js next to the bundle)',
  '',
  'Preprocessor:',
  '  -I <dir>               Add an include search path (repeatable)',
  '  -D <name>[=<value>]    Define a macro, value 1 by default (repeatable)',
  '  -U <name>              Undefine a macro (repeatable)',
  '',
  'Diagnostics:',
  '  --check                Only syntax and type checking, no output',
  '  -Werror                Treat warnings as errors',
  '  -w                     Suppress warnings',
  '  --quiet                Print errors only',
  '  --verbose              Print the phases and the files written',
  '',
  'Information:',
  '  -h, --help             Show this help',
  '  -v, --version          Show the version',
  '',
  'Exit codes: 0 success, 1 compilation errors, 2 invalid usage.'
];

/**
 * Returns the `--help` text.
 *
 * @returns {string} Text ending with a newline.
 */
function getHelpText() {
  return HELP_LINES.join('\n') + '\n';
}

/**
 * Returns the `--version` text.
 *
 * @returns {string} Text ending with a newline.
 */
function getVersionText() {
  return 'cpp2js ' + pkg.version + '\n';
}

module.exports = {
  getHelpText: getHelpText,
  getVersionText: getVersionText
};
