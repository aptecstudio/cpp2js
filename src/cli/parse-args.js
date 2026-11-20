'use strict';

/**
 * Command-line argument parser (D-021, D-028). No third-party library.
 *
 * Accepted forms:
 *   - long options with a separate or attached value: `--target es6`,
 *     `--target=es6`;
 *   - `-o`, `-I`, `-D`, `-U` with a separate or attached value: `-o out.js`,
 *     `-oout.js`, `-Idir`, `-DNAME=1`;
 *   - `--source-map` takes an optional value: `--source-map=inline`, or the
 *     next argument if it is exactly `external` or `inline`;
 *   - `--` ends the options: every following argument is an input file.
 *
 * Single-valued options repeated on the command line keep the last value;
 * list options (`-I`, `-D`, `-U`, inputs) accumulate in order.
 */

/**
 * Description of every option. `kind` is one of:
 *   - `flag`: no value;
 *   - `value`: mandatory value;
 *   - `optional`: optional value restricted to `choices`.
 * `choices`, when present, restricts the accepted values.
 */
var OPTIONS = {
  '-o': { key: 'output', kind: 'value' },
  '--output': { key: 'output', kind: 'value' },
  '--target': { key: 'target', kind: 'value', choices: ['es5', 'es6'] },
  '--platform': { key: 'platform', kind: 'value', choices: ['browser', 'node', 'mixed'] },
  '--exports': { key: 'exports', kind: 'value', choices: ['exports', 'global', 'both'] },
  '--minify': { key: 'minify', kind: 'flag' },
  '--source-map': { key: 'sourceMap', kind: 'optional', choices: ['external', 'inline'],
    implicit: 'external' },
  '--embed-std': { key: 'embedStd', kind: 'flag' },
  '--std-out': { key: 'stdOut', kind: 'value' },
  '-I': { key: 'includePaths', kind: 'value', list: true },
  '-D': { key: 'macros', kind: 'value', list: true, macro: 'define' },
  '-U': { key: 'macros', kind: 'value', list: true, macro: 'undefine' },
  '--check': { key: 'check', kind: 'flag' },
  '-Werror': { key: 'warningsAsErrors', kind: 'flag' },
  '-w': { key: 'ignoreWarnings', kind: 'flag' },
  '--error-limit': { key: 'errorLimit', kind: 'value' },
  '--quiet': { key: 'quiet', kind: 'flag' },
  '--verbose': { key: 'verbose', kind: 'flag' },
  '-h': { key: 'help', kind: 'flag' },
  '--help': { key: 'help', kind: 'flag' },
  '-v': { key: 'version', kind: 'flag' },
  '--version': { key: 'version', kind: 'flag' }
};

// Short options whose value may be attached (`-Idir`).
var ATTACHABLE = ['-o', '-I', '-D', '-U'];

var IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Returns the options object with every default applied. Defaults that
 * depend on other options (`exports`, `stdOut`) are resolved later by
 * `validateOptions`.
 *
 * @returns {Object}
 */
function createDefaultOptions() {
  return {
    inputs: [],
    output: null,
    target: 'es5',
    platform: 'browser',
    exports: null,
    minify: false,
    sourceMap: null,
    embedStd: false,
    stdOut: null,
    includePaths: [],
    macros: [],
    check: false,
    warningsAsErrors: false,
    ignoreWarnings: false,
    errorLimit: '20',
    quiet: false,
    verbose: false,
    help: false,
    version: false
  };
}

/**
 * Parses a `-D` or `-U` value into a macro operation.
 *
 * @param {string} kind `define` or `undefine`.
 * @param {string} text Value given on the command line.
 * @param {Array.<string>} errors Accumulator of usage errors.
 * @returns {?{kind: string, name: string, value: ?string}}
 */
function parseMacro(kind, text, errors) {
  var eq = kind === 'define' ? text.indexOf('=') : -1;
  var name = eq === -1 ? text : text.slice(0, eq);
  if (!IDENTIFIER.test(name)) {
    errors.push('macro name must be an identifier: \'' + name + '\'');
    return null;
  }
  if (kind === 'undefine') {
    return { kind: kind, name: name, value: null };
  }
  // As in gcc and clang, `-DNAME` defines NAME as 1.
  return { kind: kind, name: name, value: eq === -1 ? '1' : text.slice(eq + 1) };
}

/**
 * Stores a value into the options, applying the option's constraints.
 *
 * @param {Object} options Options being built.
 * @param {string} name Option as written by the user (for messages).
 * @param {Object} spec Entry of OPTIONS.
 * @param {string} value
 * @param {Array.<string>} errors
 * @returns {void}
 */
function storeValue(options, name, spec, value, errors) {
  var macro;
  if (spec.choices && spec.choices.indexOf(value) === -1) {
    errors.push('invalid value \'' + value + '\' for \'' + name + '\' (expected ' +
      spec.choices.join(', ') + ')');
    return;
  }
  if (value === '' && spec.kind === 'value') {
    errors.push('missing argument to \'' + name + '\'');
    return;
  }
  if (spec.macro) {
    macro = parseMacro(spec.macro, value, errors);
    if (macro) {
      options.macros.push(macro);
    }
  } else if (spec.list) {
    options[spec.key].push(value);
  } else {
    options[spec.key] = value;
  }
}

/**
 * Parses command-line arguments.
 *
 * @param {Array.<string>} args Arguments without the node executable and
 *   the script path (`process.argv.slice(2)`).
 * @returns {{options: Object, errors: Array.<string>}} The parsed options
 *   and the usage errors found (empty on success).
 */
function parseArgs(args) {
  var options = createDefaultOptions();
  var errors = [];
  var endOfOptions = false;
  var i;
  var arg;
  var name;
  var value;
  var eq;
  var spec;
  var j;

  for (i = 0; i < args.length; i++) {
    arg = args[i];
    if (endOfOptions || arg.charAt(0) !== '-' || arg === '-') {
      if (arg === '-' && !endOfOptions) {
        errors.push('reading from standard input is not supported');
      } else {
        options.inputs.push(arg);
      }
      continue;
    }
    if (arg === '--') {
      endOfOptions = true;
      continue;
    }

    name = arg;
    value = null;
    if (arg.slice(0, 2) === '--') {
      eq = arg.indexOf('=');
      if (eq !== -1) {
        name = arg.slice(0, eq);
        value = arg.slice(eq + 1);
      }
    } else if (!OPTIONS.hasOwnProperty(arg)) {
      for (j = 0; j < ATTACHABLE.length; j++) {
        if (arg.indexOf(ATTACHABLE[j]) === 0) {
          name = ATTACHABLE[j];
          value = arg.slice(name.length);
          break;
        }
      }
    }

    if (!OPTIONS.hasOwnProperty(name)) {
      errors.push('unknown option \'' + arg + '\'');
      continue;
    }
    spec = OPTIONS[name];

    if (spec.kind === 'flag') {
      if (value !== null) {
        errors.push('option \'' + name + '\' does not take a value');
      } else {
        options[spec.key] = true;
      }
    } else if (spec.kind === 'optional') {
      if (value === null && i + 1 < args.length && spec.choices.indexOf(args[i + 1]) !== -1) {
        value = args[++i];
      }
      storeValue(options, name, spec, value === null ? spec.implicit : value, errors);
    } else {
      if (value === null) {
        if (i + 1 >= args.length) {
          errors.push('missing argument to \'' + name + '\'');
          continue;
        }
        value = args[++i];
      }
      storeValue(options, name, spec, value, errors);
    }
  }

  return { options: options, errors: errors };
}

module.exports = {
  parseArgs: parseArgs,
  createDefaultOptions: createDefaultOptions
};
