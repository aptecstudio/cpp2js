'use strict';

var assert = require('assert');
var test = require('../harness').test;
var cli = require('../../src/cli/main');
var help = require('../../src/cli/help');
var pkg = require('../../package.json');

/**
 * Runs the CLI with in-memory streams and files.
 *
 * @param {Array.<string>} args
 * @param {Object.<string, string>} [files] Virtual file system.
 * @returns {{code: number, stdout: string, stderr: string}}
 */
function runCli(args, files) {
  var out = { code: 0, stdout: '', stderr: '' };
  files = files || {};
  out.code = cli.run(args, {
    stdout: function (text) { out.stdout += text; },
    stderr: function (text) { out.stderr += text; },
    readFile: function (file) {
      var err;
      if (!files.hasOwnProperty(file)) {
        err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
      return files[file];
    }
  });
  return out;
}

test('--help prints usage on stdout and exits 0', function () {
  var r = runCli(['--help']);
  assert.equal(r.code, cli.EXIT_SUCCESS);
  assert.equal(r.stdout, help.getHelpText());
  assert.equal(r.stderr, '');
  assert.ok(r.stdout.indexOf('Usage: cpp2js [options] <file.cpp>...') === 0);
  assert.equal(runCli(['-h', 'a.cpp', '-Werror', '-w']).code, cli.EXIT_SUCCESS);
});

test('--version prints the package version', function () {
  var r = runCli(['-v']);
  assert.equal(r.code, cli.EXIT_SUCCESS);
  assert.equal(r.stdout, 'cpp2js ' + pkg.version + '\n');
});

test('help text fits in 80 columns', function () {
  var lines = help.getHelpText().split('\n');
  var i;
  for (i = 0; i < lines.length; i++) {
    assert.ok(lines[i].length <= 80, 'line too long: ' + lines[i]);
  }
});

test('usage errors go to stderr with exit code 2', function () {
  var r = runCli(['--bogus', 'a.cpp']);
  assert.equal(r.code, cli.EXIT_USAGE);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, 'cpp2js: error: unknown option \'--bogus\'\n' +
    'Try \'cpp2js --help\' for more information.\n');
  assert.equal(runCli([]).code, cli.EXIT_USAGE);
  assert.equal(runCli(['a.cpp']).code, cli.EXIT_USAGE);
  assert.equal(runCli(['--help', '--bogus']).code, cli.EXIT_USAGE);
});

test('usage warnings follow -w, -Werror and --quiet', function () {
  var files = { 'a.cpp': 'int main() { return 0; }\n' };
  var args = ['a.cpp', '--check', '--minify'];
  var warning = 'cpp2js: warning: \'--minify\' has no effect with \'--check\'\n';
  assert.ok(runCli(args, files).stderr.indexOf(warning) === 0);
  assert.equal(runCli(args.concat(['-w']), files).stderr.indexOf('warning'), -1);
  assert.equal(runCli(args.concat(['--quiet']), files).stderr.indexOf('warning'), -1);
  assert.equal(runCli(args.concat(['-Werror']), files).code, cli.EXIT_USAGE);
});

test('missing input files are compilation errors', function () {
  var r = runCli(['missing.cpp', '--check']);
  assert.equal(r.code, cli.EXIT_COMPILE_ERROR);
  assert.equal(r.stderr, 'cpp2js: error: cannot read \'missing.cpp\': ' +
    'no such file or directory\n1 error generated.\n');
});

test('reports that the pipeline is not implemented yet', function () {
  var r = runCli(['a.cpp', '--check'], { 'a.cpp': 'int main() {}\n' });
  assert.equal(r.code, cli.EXIT_COMPILE_ERROR);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, 'cpp2js: error: compilation is not implemented yet\n' +
    '1 error generated.\n');
  assert.equal(runCli(['a.cpp', '--check', '--quiet'], { 'a.cpp': '' }).stderr,
    'cpp2js: error: compilation is not implemented yet\n');
});
