'use strict';

/**
 * Helper for parser tests: preprocesses, lexes and parses a source string.
 */

var SourceFile = require('../../src/source/source-file');
var DiagnosticBag = require('../../src/diagnostics/diagnostic-bag');
var Preprocessor = require('../../src/preprocessor/preprocessor').Preprocessor;
var Lexer = require('../../src/lexer/lexer').Lexer;
var Parser = require('../../src/parser/parser').Parser;
var dump = require('../../src/ast/dump').dump;

/**
 * @param {string} text C++ source.
 * @returns {{unit: Object, dump: string, errors: Array.<string>,
 *   warnings: Array.<string>, bag: DiagnosticBag, parser: Parser}}
 */
function parse(text) {
  var bag = new DiagnosticBag();
  var source = new SourceFile('t.cpp', text);
  var pp = new Preprocessor({ diagnostics: bag, readFile: function () { throw new Error(); },
    systemIncludePaths: [] }).run(source);
  var tokens = new Lexer(bag).lex(pp.tokens, source);
  var parser = new Parser(tokens, bag, source);
  var unit = parser.parseTranslationUnit();
  return {
    unit: unit,
    dump: dump(unit),
    errors: bag.getAll().filter(function (d) { return d.severity === 'error'; })
      .map(function (d) { return d.message; }),
    warnings: bag.getAll().filter(function (d) { return d.severity === 'warning'; })
      .map(function (d) { return d.message; }),
    bag: bag,
    parser: parser
  };
}

/**
 * Dump lines of the top-level declarations (without the TranslationUnit
 * line and with one indentation level removed).
 */
function topLevel(text) {
  return parse(text).dump.split('\n').slice(1).filter(function (line) {
    return line.length;
  }).map(function (line) {
    return line.slice(2);
  });
}

module.exports = {
  parse: parse,
  topLevel: topLevel
};
