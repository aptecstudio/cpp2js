'use strict';

/**
 * Text dump of an AST, in the spirit of `clang -ast-dump` (D-042): one line
 * per node, two spaces of indentation per level, with the name, type and
 * value category where relevant. Used by tests and for debugging.
 */

var nodes = require('./nodes');
var T = require('../semantic/types');
var I = require('../util/int64');

function quote(type) {
  return type ? '\'' + T.typeToString(type) + '\'' : '\'<null>\'';
}

/** Spells string literal units with C escapes for non-printable units. */
function spellUnits(units) {
  var out = '';
  var i;
  var u;
  for (i = 0; i < units.length; i++) {
    u = units[i];
    if (u === 34 || u === 92) {
      out += '\\' + String.fromCharCode(u);
    } else if (u === 10) {
      out += '\\n';
    } else if (u >= 32 && u < 127) {
      out += String.fromCharCode(u);
    } else {
      out += '\\x' + u.toString(16);
    }
  }
  return '"' + out + '"';
}

function describe(node) {
  var parts = [node.kind];
  switch (node.kind) {
    case 'VarDecl':
    case 'FieldDecl':
    case 'ParamDecl':
    case 'FunctionDecl':
    case 'TypedefDecl':
      parts.push(node.name || '<anonymous>');
      parts.push(quote(node.type));
      if (node.storage) {
        parts.push(node.storage);
      }
      if (node.linkage) {
        parts.push('extern "' + node.linkage + '"');
      }
      if (node.isInline) {
        parts.push('inline');
      }
      if (node.isConstexpr) {
        parts.push('constexpr');
      }
      if (node.previous) {
        parts.push('redecl');
      }
      if (node.initStyle) {
        parts.push(node.initStyle + '-init');
      }
      break;
    case 'NamespaceDecl':
    case 'RecordDecl':
    case 'EnumDecl':
    case 'EnumeratorDecl':
      parts.push(node.name || '<anonymous>');
      break;
    case 'IntegerLiteral':
      parts.push(quote(node.type), I.toString(node.value, !T.isUnsigned(node.type)));
      break;
    case 'FloatLiteral':
    case 'CharLiteral':
    case 'BoolLiteral':
      parts.push(quote(node.type), String(node.value));
      break;
    case 'StringLiteral':
      parts.push(quote(node.type), spellUnits(node.units));
      break;
    case 'DeclRefExpr':
      parts.push(node.decl.name, quote(node.type), node.valueCategory);
      break;
    case 'UnaryExpr':
    case 'BinaryExpr':
      parts.push('\'' + node.operator + '\'', quote(node.type));
      break;
    default:
      if (nodes.isExpression(node.kind) && node.type) {
        parts.push(quote(node.type), node.valueCategory);
      }
  }
  return parts.join(' ');
}

/**
 * Dumps a node and its children.
 *
 * @param {Object} root
 * @returns {string} One line per node, each ending with a newline.
 */
function dump(root) {
  var lines = [];
  var depth = 0;
  nodes.walk(root, function (node) {
    var pad = new Array(depth + 1).join('  ');
    lines.push(pad + describe(node));
    depth++;
  }, function () {
    depth--;
  });
  return lines.join('\n') + '\n';
}

module.exports = {
  dump: dump
};
