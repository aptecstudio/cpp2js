'use strict';

var assert = require('assert');
var test = require('../harness').test;
var ast = require('../../src/ast/nodes');
var S = require('../../src/semantic/scope');

var Scope = S.Scope;
var K = S.ScopeKind;

function globalNamespace() {
  var ns = ast.createNode('NamespaceDecl', null, { name: '' });
  ns.scope = new Scope(K.NAMESPACE, null, ns);
  return ns;
}

function namespace(parent, name, isInline) {
  var ns = ast.createNode('NamespaceDecl', null, { name: name, parent: parent,
    isInline: !!isInline });
  ns.scope = new Scope(K.NAMESPACE, parent.scope, ns);
  parent.scope.declare(name, ns);
  return ns;
}

function variable(scope, name) {
  var decl = ast.createNode('VarDecl', null, { name: name });
  scope.declare(name, decl);
  return decl;
}

function fn(scope, name) {
  var decl = ast.createNode('FunctionDecl', null, { name: name });
  scope.declare(name, decl);
  return decl;
}

function record(scope, name, bases) {
  var decl = ast.createNode('RecordDecl', null, { name: name, tag: 'struct',
    bases: (bases || []).map(function (b) {
      return ast.createNode('BaseSpecifier', null, { type: { decl: b } });
    }) });
  decl.scope = new Scope(K.CLASS, scope, decl);
  scope.declare(name, decl);
  return decl;
}

function names(result) {
  return result.decls.map(function (d) { return d.kind + ':' + d.name; });
}

test('finds names in the innermost scope first', function () {
  var g = globalNamespace();
  var outer = variable(g.scope, 'x');
  var block = new Scope(K.BLOCK, g.scope, null);
  var inner = new Scope(K.BLOCK, block, null);
  var hidden = variable(block, 'x');
  assert.strictEqual(S.lookupUnqualified(inner, 'x').decls[0], hidden);
  assert.strictEqual(S.lookupUnqualified(g.scope, 'x').decls[0], outer);
  assert.deepEqual(S.lookupUnqualified(inner, 'y').decls, []);
  assert.strictEqual(S.lookupUnqualified(inner, 'x').scope, block);
});

test('returns overload sets and hides tags behind other names', function () {
  var g = globalNamespace();
  var s = record(g.scope, 'stat');
  fn(g.scope, 'stat');
  fn(g.scope, 'stat');
  assert.deepEqual(names(S.lookupUnqualified(g.scope, 'stat')),
    ['FunctionDecl:stat', 'FunctionDecl:stat']);
  assert.equal(S.lookupUnqualified(g.scope, 'stat').ambiguous, false);
  assert.strictEqual(S.lookupUnqualified(g.scope, 'stat', { tagsOnly: true }).decls[0], s);
});

test('looks into namespaces nominated by using-directives', function () {
  var g = globalNamespace();
  var std = namespace(g, 'std');
  var cout = variable(std.scope, 'cout');
  var block = new Scope(K.BLOCK, g.scope, null);
  block.addUsingDirective(std);
  assert.strictEqual(S.lookupUnqualified(block, 'cout').decls[0], cout);
  assert.deepEqual(S.lookupUnqualified(g.scope, 'cout').decls, []);
});

test('treats using-directive names as declared in the common namespace', function () {
  // namespace A { int i; } int i; void f() { using namespace A; i; } -> ambiguous
  var g = globalNamespace();
  var a = namespace(g, 'A');
  var block = new Scope(K.BLOCK, g.scope, null);
  var local = new Scope(K.BLOCK, block, null);
  variable(a.scope, 'i');
  variable(g.scope, 'i');
  block.addUsingDirective(a);
  assert.equal(S.lookupUnqualified(block, 'i').ambiguous, true);
  // A local declaration still hides both.
  variable(local, 'i');
  assert.equal(S.lookupUnqualified(local, 'i').ambiguous, false);
  assert.equal(S.lookupUnqualified(local, 'i').scope, local);
});

test('follows using-directives transitively', function () {
  var g = globalNamespace();
  var a = namespace(g, 'A');
  var b = namespace(g, 'B');
  var target = variable(b.scope, 'deep');
  a.scope.addUsingDirective(b);
  g.scope.addUsingDirective(a);
  assert.strictEqual(S.lookupUnqualified(g.scope, 'deep').decls[0], target);
  assert.strictEqual(S.lookupInNamespace(a, 'deep').decls[0], target);
});

test('qualified namespace lookup prefers own members', function () {
  // C++11 3.4.3.2/2 example, simplified.
  var g = globalNamespace();
  var a = namespace(g, 'A');
  var b = namespace(g, 'B');
  var ab = namespace(a, 'AB');
  var own = variable(a.scope, 'x');
  variable(b.scope, 'x');
  a.scope.addUsingDirective(b);
  variable(ab.scope, 'y');
  assert.strictEqual(S.lookupInNamespace(a, 'x').decls[0], own);
  assert.equal(S.lookupInNamespace(a, 'x').ambiguous, false);
  g.scope.addUsingDirective(a);
  g.scope.addUsingDirective(b);
  assert.equal(S.lookupInNamespace(g, 'x').ambiguous, true);
  assert.deepEqual(S.lookupInNamespace(a, 'y').decls, []);
});

test('inline namespaces contribute members to the enclosing namespace', function () {
  var g = globalNamespace();
  var lib = namespace(g, 'lib');
  var v1 = namespace(lib, 'v1', true);
  var f = fn(v1.scope, 'f');
  assert.strictEqual(S.lookupInNamespace(lib, 'f').decls[0], f);
  assert.strictEqual(S.lookupQualified(lib, 'f').decls[0], f);
});

test('expands using-declarations', function () {
  var g = globalNamespace();
  var std = namespace(g, 'std');
  var f1 = fn(std.scope, 'swap');
  var f2 = fn(std.scope, 'swap');
  var use = ast.createNode('UsingDecl', null, { name: 'swap', targets: [f1, f2] });
  g.scope.declare('swap', use);
  assert.deepEqual(S.lookupUnqualified(g.scope, 'swap').decls, [f1, f2]);
});

test('looks members up in classes and their bases', function () {
  var g = globalNamespace();
  var base = record(g.scope, 'Base');
  var baseMember = variable(base.scope, 'value');
  var derived = record(g.scope, 'Derived', [base]);
  var method = new Scope(K.FUNCTION, derived.scope, null);
  var r = S.lookupMember(derived, 'value');
  assert.strictEqual(r.decls[0], baseMember);
  assert.strictEqual(r.owner, base);
  assert.strictEqual(S.lookupUnqualified(method, 'value').decls[0], baseMember);
  assert.strictEqual(S.lookupQualified(derived, 'value').decls[0], baseMember);
  // A member of the derived class hides the base one.
  var own = variable(derived.scope, 'value');
  assert.strictEqual(S.lookupMember(derived, 'value').decls[0], own);
});

test('detects ambiguous members of several bases', function () {
  var g = globalNamespace();
  var a = record(g.scope, 'A');
  var b = record(g.scope, 'B');
  var shared = record(g.scope, 'V');
  var viaA;
  var viaB;
  var c;
  var d;
  variable(a.scope, 'm');
  variable(b.scope, 'm');
  c = record(g.scope, 'C', [a, b]);
  assert.equal(S.lookupMember(c, 'm').ambiguous, true);
  // The same declaration reached through two paths is not ambiguous.
  variable(shared.scope, 's');
  viaA = record(g.scope, 'VA', [shared]);
  viaB = record(g.scope, 'VB', [shared]);
  d = record(g.scope, 'D', [viaA, viaB]);
  assert.equal(S.lookupMember(d, 's').ambiguous, false);
});

test('looks enumerators up in scoped enumerations', function () {
  var g = globalNamespace();
  var e = ast.createNode('EnumDecl', null, { name: 'Color', scoped: true });
  var red = ast.createNode('EnumeratorDecl', null, { name: 'red' });
  e.scope = new Scope(K.ENUM, g.scope, e);
  e.scope.declare('red', red);
  g.scope.declare('Color', e);
  assert.strictEqual(S.lookupQualified(e, 'red').decls[0], red);
  assert.deepEqual(S.lookupUnqualified(g.scope, 'red').decls, []);
});
