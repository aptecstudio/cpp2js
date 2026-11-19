'use strict';

/**
 * Enforces rule 1 of AGENTS.md: the project's JavaScript is ES5 only.
 * Scans bin/, src/ and test/ (fixtures excluded, since they hold generated
 * output that may legitimately be ES6).
 */

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var test = require('./harness').test;
var checkSource = require('./tools/es5-check').checkSource;

var ROOT = path.join(__dirname, '..');
var SCANNED_DIRS = ['bin', 'src', 'test'];
var FIXTURES_DIR = path.join(ROOT, 'test', 'fixtures');

function collectJsFiles(dir, out) {
  var entries;
  var full;
  var i;
  if (!fs.existsSync(dir)) {
    return out;
  }
  entries = fs.readdirSync(dir).sort();
  for (i = 0; i < entries.length; i++) {
    full = path.join(dir, entries[i]);
    if (fs.statSync(full).isDirectory()) {
      if (full !== FIXTURES_DIR) {
        collectJsFiles(full, out);
      }
    } else if (/\.js$/.test(entries[i])) {
      out.push(full);
    }
  }
  return out;
}

test('project sources contain no ES2015+ constructs', function () {
  var files = [];
  var report = [];
  var problems;
  var i;
  var j;
  for (i = 0; i < SCANNED_DIRS.length; i++) {
    collectJsFiles(path.join(ROOT, SCANNED_DIRS[i]), files);
  }
  for (i = 0; i < files.length; i++) {
    problems = checkSource(fs.readFileSync(files[i], 'utf8'));
    for (j = 0; j < problems.length; j++) {
      report.push(path.relative(ROOT, files[i]) + ':' + problems[j].line + ': ' +
        problems[j].message);
    }
  }
  assert.ok(files.length > 0, 'no JavaScript files found');
  assert.deepEqual(report, []);
});

test('checker flags ES2015+ syntax', function () {
  var messages = function (src) {
    var problems = checkSource(src);
    var out = [];
    var i;
    for (i = 0; i < problems.length; i++) {
      out.push(problems[i].message);
    }
    return out;
  };
  assert.deepEqual(messages('let a = 1;'), ['let declaration']);
  assert.deepEqual(messages('const a = 1;'), ['const declaration']);
  assert.deepEqual(messages('var f = x => x;'), ['arrow function']);
  assert.deepEqual(messages('var s = `a`;'), ['template literal', 'template literal']);
  assert.deepEqual(messages('f(...args);'), ['spread/rest syntax']);
  assert.deepEqual(messages('var m = new Map();'), ['Map built-in']);
  assert.deepEqual(messages('Object.assign({}, a);'), ['ES2015+ built-in Object.assign']);
  assert.deepEqual(messages('s.startsWith("a");'), ['ES2015+ method .startsWith()']);
  assert.deepEqual(messages('class A {}'), ['class syntax']);
  assert.deepEqual(messages('var b = Buffer.from(s);'), ['ES2015+ built-in Buffer.from']);
});

test('checker ignores comments, strings, regexes and property names', function () {
  assert.deepEqual(checkSource('// let const => `\nvar a = 1;'), []);
  assert.deepEqual(checkSource('/* class Map\n => */ var a;'), []);
  assert.deepEqual(checkSource('var s = \'let `x` => ...\';'), []);
  assert.deepEqual(checkSource('var s = "const";'), []);
  assert.deepEqual(checkSource('var r = /`=>/g;'), []);
  assert.deepEqual(checkSource('var o = { class: 1, let: 2 }; o.const = 3;'), []);
  assert.deepEqual(checkSource('var q = a / b / c;'), []);
  assert.deepEqual(checkSource('Math.floor(x); Object.create(p);'), []);
});

test('checker reports line numbers', function () {
  var problems = checkSource('var a;\n/* x\n y */\nlet b;');
  assert.equal(problems.length, 1);
  assert.equal(problems[0].line, 4);
});
