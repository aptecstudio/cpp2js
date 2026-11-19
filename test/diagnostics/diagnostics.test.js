'use strict';

var assert = require('assert');
var test = require('../harness').test;
var SourceFile = require('../../src/source/source-file');
var diagnostic = require('../../src/diagnostics/diagnostic');
var DiagnosticBag = require('../../src/diagnostics/diagnostic-bag');
var format = require('../../src/diagnostics/format');

var Severity = diagnostic.Severity;
var Diagnostic = diagnostic.Diagnostic;

var SOURCE = new SourceFile('main.cpp', 'int main() {\n  return y;\n}\n');

test('creates diagnostics with and without a location', function () {
  var located = new Diagnostic(Severity.ERROR, 'msg', { source: SOURCE, start: 22, end: 23 });
  var bare = new Diagnostic(Severity.WARNING, 'msg');
  assert.equal(located.source, SOURCE);
  assert.equal(located.start, 22);
  assert.equal(located.end, 23);
  assert.equal(bare.source, null);
  assert.equal(bare.start, null);
  assert.equal(new Diagnostic(Severity.NOTE, 'm', { source: SOURCE, start: 3 }).end, 3);
});

test('rejects unknown severities and reversed spans', function () {
  assert.throws(function () { new Diagnostic('fatal', 'm'); }, TypeError);
  assert.throws(function () {
    new Diagnostic(Severity.ERROR, 'm', { source: SOURCE, start: 5, end: 2 });
  }, RangeError);
});

test('formats a located error with caret and underline', function () {
  var diag = new Diagnostic(Severity.ERROR, 'use of undeclared identifier \'y\'',
    { source: SOURCE, start: 22, end: 23 });
  assert.equal(format.formatDiagnostic(diag),
    'main.cpp:2:10: error: use of undeclared identifier \'y\'\n' +
    '  return y;\n' +
    '         ^\n');
  diag = new Diagnostic(Severity.WARNING, 'w', { source: SOURCE, start: 15, end: 21 });
  assert.equal(format.formatDiagnostic(diag),
    'main.cpp:2:3: warning: w\n' +
    '  return y;\n' +
    '  ^~~~~~\n');
});

test('keeps tabs in the marker line and clips multi-line ranges', function () {
  var file = new SourceFile('t.cpp', '\tint\tx;\nfoo');
  var diag = new Diagnostic(Severity.ERROR, 'e', { source: file, start: 5, end: 11 });
  assert.equal(format.formatDiagnostic(diag),
    't.cpp:1:6: error: e\n' +
    '\tint\tx;\n' +
    '\t   \t^~\n');
});

test('formats file-level and location-less diagnostics', function () {
  assert.equal(format.formatDiagnostic(new Diagnostic(Severity.ERROR, 'e', { source: SOURCE })),
    'main.cpp: error: e\n');
  assert.equal(format.formatDiagnostic(new Diagnostic(Severity.ERROR, 'no input files')),
    'cpp2js: error: no input files\n');
});

test('prints notes after their diagnostic', function () {
  var diag = new Diagnostic(Severity.ERROR, 'redefinition of \'main\'',
    { source: SOURCE, start: 4, end: 8 });
  diag.addNote('previous definition is here', { source: SOURCE, start: 0, end: 3 });
  assert.equal(format.formatDiagnostic(diag),
    'main.cpp:1:5: error: redefinition of \'main\'\n' +
    'int main() {\n' +
    '    ^~~~\n' +
    'main.cpp:1:1: note: previous definition is here\n' +
    'int main() {\n' +
    '^~~\n');
});

test('formats the summary line', function () {
  assert.equal(format.formatSummary(0, 0), '');
  assert.equal(format.formatSummary(1, 0), '1 error generated.\n');
  assert.equal(format.formatSummary(0, 1), '1 warning generated.\n');
  assert.equal(format.formatSummary(3, 2), '2 warnings and 3 errors generated.\n');
});

test('bag counts errors and warnings in order', function () {
  var bag = new DiagnosticBag();
  assert.equal(bag.hasErrors(), false);
  bag.warning('w1');
  bag.error('e1').addNote('n1');
  bag.warning('w2');
  assert.equal(bag.errorCount, 1);
  assert.equal(bag.warningCount, 2);
  assert.equal(bag.hasErrors(), true);
  assert.deepEqual(bag.getAll().map(function (d) { return d.message; }), ['w1', 'e1', 'w2']);
  assert.equal(bag.getAll()[1].notes[0].message, 'n1');
});

test('bag drops warnings with ignoreWarnings (-w)', function () {
  var bag = new DiagnosticBag({ ignoreWarnings: true });
  var warning = bag.warning('w').addNote('still chainable');
  assert.equal(warning.notes.length, 1);
  bag.error('e');
  assert.equal(bag.warningCount, 0);
  assert.equal(bag.errorCount, 1);
  assert.equal(bag.getAll().length, 1);
});

test('bag promotes warnings with warningsAsErrors (-Werror)', function () {
  var bag = new DiagnosticBag({ warningsAsErrors: true });
  var diag = bag.warning('unused variable \'x\'');
  assert.equal(diag.severity, Severity.ERROR);
  assert.equal(bag.errorCount, 1);
  assert.equal(bag.warningCount, 0);
  assert.equal(format.formatDiagnostic(diag),
    'cpp2js: error: unused variable \'x\' [-Werror]\n');
});

test('bag rejects bare notes and conflicting options', function () {
  assert.throws(function () {
    new DiagnosticBag().report(new Diagnostic(Severity.NOTE, 'n'));
  }, TypeError);
  assert.throws(function () {
    new DiagnosticBag({ warningsAsErrors: true, ignoreWarnings: true });
  }, Error);
});
