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
      if (node.access && (node.kind === 'FieldDecl' || node.isMethod)) {
        parts.push(node.access);
      }
      if (node.isMutable) {
        parts.push('mutable');
      }
      if (node.width !== null && node.width !== undefined) {
        parts.push(':' + node.width);
      }
      if (node.methodKind === 'constructor' || node.methodKind === 'destructor') {
        parts.push(node.methodKind);
      }
      if (node.isExplicit) {
        parts.push('explicit');
      }
      if (node.isVirtual) {
        parts.push('virtual');
      }
      if (node.isPure) {
        parts.push('pure');
      }
      if (node.isOverride) {
        parts.push('override');
      }
      if (node.isFinal) {
        parts.push('final');
      }
      if (node.isDeleted) {
        parts.push('deleted');
      }
      if (node.isDefaulted && !node.isImplicit) {
        parts.push('defaulted');
      }
      if (node.initStyle) {
        parts.push(node.initStyle + '-init');
      }
      break;
    case 'CtorInitializer':
      parts.push(node.isDelegating ? '<delegating>' : node.base ?
        'base ' + T.typeToString(node.base.type) : node.member.name);
      break;
    case 'ConstructExpr':
      parts.push(quote(node.type), node.valueCategory, quote(node.constructorDecl.type),
        node.constructorDecl.isImplicit ? node.constructorDecl.special : 'user');
      if (node.isListInit) {
        parts.push('list');
      }
      break;
    case 'NamespaceDecl':
      parts.push(node.name || '<anonymous>');
      if (node.isInline) {
        parts.push('inline');
      }
      if (node.jsModule) {
        parts.push('module "' + node.jsModule + '"');
      }
      if (node.previous) {
        parts.push('reopened');
      }
      break;
    case 'NamespaceAliasDecl':
      parts.push(node.name, '->', node.target.name);
      break;
    case 'UsingDirectiveDecl':
      parts.push(node.namespace.name);
      break;
    case 'UsingDecl':
      parts.push(node.name);
      break;
    case 'LinkageSpecDecl':
      parts.push('"' + node.language + '"');
      break;
    case 'EnumDecl':
      parts.push(node.name || '<anonymous>');
      if (node.scoped) {
        parts.push('class');
      }
      if (node.underlyingType) {
        parts.push(quote(node.underlyingType));
      }
      if (!node.isDefined) {
        parts.push('opaque');
      }
      break;
    case 'EnumeratorDecl':
      parts.push(node.name, quote(node.type), node.value ?
        I.toString(node.value, !T.isUnsigned(node.parent.underlyingType)) : '?');
      break;
    case 'RecordDecl':
      parts.push(node.tag, node.name || '<anonymous>');
      if (node.complete) {
        parts.push('size=' + node.size, 'align=' + node.align);
        if (node.isPolymorphic) {
          parts.push('polymorphic');
        }
        if (node.isAbstract) {
          parts.push('abstract');
        }
      } else {
        parts.push('incomplete');
      }
      break;
    case 'CallExpr':
      if (node.overloadedOperator) {
        parts.push('operator' + node.overloadedOperator);
      }
      parts.push(quote(node.type), node.valueCategory);
      if (node.isVirtualCall) {
        parts.push('virtual');
      }
      break;
    case 'LambdaExpr':
      parts.push(quote(node.type), node.valueCategory, quote(node.returnType));
      if (node.captureDefault) {
        parts.push('[' + node.captureDefault + ']');
      }
      if (node.isMutable) {
        parts.push('mutable');
      }
      break;
    case 'LambdaCapture':
      parts.push((node.byReference ? '&' : '') + node.variable.name);
      break;
    case 'BaseSpecifier':
      parts.push(node.access, T.typeToString(node.type));
      break;
    case 'MemberExpr':
      parts.push((node.isArrow ? '->' : '.') + node.member.name, quote(node.type),
        node.valueCategory);
      break;
    case 'ThisExpr':
      parts.push(quote(node.type), node.valueCategory);
      if (node.isImplicit) {
        parts.push('implicit');
      }
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
      if (node.isCapture) {
        parts.push(node.capturedByCopy ? 'captured-copy' : 'captured-ref');
      }
      break;
    case 'CastExpr':
      parts.push(quote(node.type), node.valueCategory, '<' + node.conversion + '>');
      if (node.written) {
        parts.push(node.castKind);
      }
      break;
    case 'UnaryExpr':
    case 'BinaryExpr':
      parts.push('\'' + node.operator + '\'' + (node.isPostfix ? ' postfix' : ''),
        quote(node.type), node.valueCategory);
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
