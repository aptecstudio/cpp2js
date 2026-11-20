'use strict';

/**
 * Scopes and name lookup (C++11 3.3, 3.4, 10.2), D-041.
 *
 * A scope maps names to the declarations (AST nodes, D-040) introduced in
 * it, in declaration order. Namespace and class scopes belong to their
 * declaration (`entity`, whose `scope` points back).
 *
 * Lookup results are `{decls, ambiguous}`: `decls` is empty when nothing
 * is found and holds several functions for an overload set.
 */

var ScopeKind = {
  NAMESPACE: 'namespace',
  CLASS: 'class',
  ENUM: 'enum',
  FUNCTION: 'function',
  BLOCK: 'block',
  PROTOTYPE: 'prototype',
  TEMPLATE: 'template'
};

/**
 * @constructor
 * @param {string} kind A ScopeKind.
 * @param {?Scope} parent Enclosing scope.
 * @param {?Object} entity The declaration owning a namespace, class, enum or
 *   function scope.
 */
function Scope(kind, parent, entity) {
  this.kind = kind;
  this.parent = parent;
  this.entity = entity || null;
  this.usingDirectives = [];
  this.decls = [];
  this._names = Object.create(null);
}

/**
 * Adds a declaration under a name.
 *
 * @param {string} name
 * @param {Object} decl
 * @returns {void}
 */
Scope.prototype.declare = function (name, decl) {
  if (!this._names[name]) {
    this._names[name] = [];
  }
  this._names[name].push(decl);
  this.decls.push(decl);
};

/**
 * Removes the declarations of a name from this scope.
 *
 * @param {string} name
 * @returns {void}
 */
Scope.prototype.forget = function (name) {
  var own = this._names[name] || [];
  this.decls = this.decls.filter(function (d) { return own.indexOf(d) === -1; });
  delete this._names[name];
};

/**
 * Records `using namespace N;` in this scope.
 *
 * @param {Object} namespaceDecl
 * @returns {void}
 */
Scope.prototype.addUsingDirective = function (namespaceDecl) {
  if (this.usingDirectives.indexOf(namespaceDecl) === -1) {
    this.usingDirectives.push(namespaceDecl);
  }
};

/**
 * Declarations of a name in this scope only. Using-declarations are
 * replaced by their targets; inline namespaces contribute their members to
 * the enclosing namespace (C++11 7.3.1/8).
 *
 * @param {string} name
 * @returns {Array.<Object>}
 */
Scope.prototype.lookupLocal = function (name) {
  var out = [];
  var own = this._names[name] || [];
  var i;
  var j;
  for (i = 0; i < own.length; i++) {
    if (own[i].kind === 'UsingDecl') {
      for (j = 0; j < own[i].targets.length; j++) {
        pushUnique(out, own[i].targets[j]);
      }
    } else {
      pushUnique(out, own[i]);
    }
  }
  if (this.kind === ScopeKind.NAMESPACE) {
    for (i = 0; i < this.decls.length; i++) {
      if (this.decls[i].kind === 'NamespaceDecl' && this.decls[i].isInline &&
          this.decls[i].scope !== this) {
        appendUnique(out, this.decls[i].scope.lookupLocal(name));
      }
    }
  }
  return out;
};

function pushUnique(list, item) {
  if (list.indexOf(item) === -1) {
    list.push(item);
  }
}

function appendUnique(list, items) {
  var i;
  for (i = 0; i < items.length; i++) {
    pushUnique(list, items[i]);
  }
}

// ---------------------------------------------------------------------------
// Helpers on declarations.

/** Class and enumeration names (they can be hidden by other names). */
function isTag(decl) {
  return decl.kind === 'RecordDecl' || decl.kind === 'EnumDecl';
}

function isFunction(decl) {
  return decl.kind === 'FunctionDecl' || (decl.kind === 'TemplateDecl' &&
    decl.templateKind === 'function');
}

/**
 * Applies C++11 3.3.10/2: a class or enumeration name is hidden by a
 * variable, data member, function or enumerator of the same name in the
 * same scope.
 *
 * @param {Array.<Object>} decls
 * @param {boolean} tagsOnly Keep only tag names (elaborated specifiers such
 *   as `struct S`).
 * @returns {Array.<Object>}
 */
function applyTagHiding(decls, tagsOnly) {
  var tags = decls.filter(isTag);
  var others = decls.filter(function (d) { return !isTag(d); });
  if (tagsOnly) {
    return tags;
  }
  return others.length ? others : tags;
}

/**
 * Two results from different places are ambiguous unless they denote the
 * same entities or are all functions (they form one overload set).
 */
function isAmbiguous(decls) {
  var i;
  if (decls.length < 2) {
    return false;
  }
  for (i = 0; i < decls.length; i++) {
    if (!isFunction(decls[i])) {
      return true;
    }
  }
  return false;
}

/** Enclosing namespace declaration of a scope. */
function enclosingNamespace(scope) {
  while (scope && scope.kind !== ScopeKind.NAMESPACE) {
    scope = scope.parent;
  }
  return scope ? scope.entity : null;
}

/** Namespace declarations from `ns` up to the global namespace. */
function namespaceChain(ns) {
  var chain = [];
  while (ns) {
    chain.push(ns);
    ns = ns.parent;
  }
  return chain;
}

/** Nearest namespace enclosing (or equal to) both `a` and `b`. */
function commonNamespace(a, b) {
  var chain = namespaceChain(a);
  while (b) {
    if (chain.indexOf(b) !== -1) {
      return b;
    }
    b = b.parent;
  }
  return null;
}

/**
 * Namespaces nominated by using-directives, transitively (C++11 7.3.4/4).
 */
function nominatedClosure(directives) {
  var out = [];
  var queue = directives.slice();
  var ns;
  while (queue.length) {
    ns = queue.shift();
    if (out.indexOf(ns) === -1) {
      out.push(ns);
      queue = queue.concat(ns.scope.usingDirectives);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Member lookup in classes (C++11 10.2).

/**
 * Looks a name up in a class and its bases. A name found in the class
 * hides the bases; names found in several bases are ambiguous unless they
 * are the same declarations (e.g. reached through a virtual base or a
 * static member).
 *
 * @param {Object} record RecordDecl with `scope` and `bases` (whose `type`
 *   is a record type).
 * @param {string} name
 * @returns {{decls: Array.<Object>, ambiguous: boolean, owner: ?Object}}
 *   `owner` is the class where the name was found.
 */
function lookupMember(record, name) {
  var local = record.scope ? record.scope.lookupLocal(name) : [];
  var found = null;
  var result;
  var i;
  var bases = record.bases || [];
  if (local.length) {
    return { decls: local, ambiguous: false, owner: record };
  }
  for (i = 0; i < bases.length; i++) {
    if (!bases[i].type || !bases[i].type.decl) {
      continue;
    }
    result = lookupMember(bases[i].type.decl, name);
    if (!result.decls.length) {
      continue;
    }
    if (result.ambiguous) {
      return result;
    }
    if (!found) {
      found = result;
    } else if (!sameDeclarations(found.decls, result.decls)) {
      return { decls: found.decls.concat(result.decls), ambiguous: true, owner: null };
    }
  }
  return found || { decls: [], ambiguous: false, owner: null };
}

function sameDeclarations(a, b) {
  var i;
  if (a.length !== b.length) {
    return false;
  }
  for (i = 0; i < a.length; i++) {
    if (b.indexOf(a[i]) === -1) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Qualified lookup in namespaces (C++11 3.4.3.2).

/**
 * Looks a name up as a member of a namespace: its own members (and those of
 * its inline namespaces); if none, the members of the namespaces it
 * nominates with using-directives, recursively.
 *
 * @param {Object} ns NamespaceDecl.
 * @param {string} name
 * @param {Object} [options] `tagsOnly`.
 * @returns {{decls: Array.<Object>, ambiguous: boolean}}
 */
function lookupInNamespace(ns, name, options) {
  var tagsOnly = !!(options && options.tagsOnly);
  var visited = [];
  var decls = [];

  function search(current) {
    var local;
    var found = [];
    var i;
    if (visited.indexOf(current) !== -1) {
      return [];
    }
    visited.push(current);
    local = applyTagHiding(current.scope.lookupLocal(name), tagsOnly);
    if (local.length) {
      return local;
    }
    for (i = 0; i < current.scope.usingDirectives.length; i++) {
      appendUnique(found, search(current.scope.usingDirectives[i]));
    }
    return found;
  }

  decls = search(ns);
  return { decls: decls, ambiguous: isAmbiguous(decls) };
}

/**
 * Qualified lookup `Q::name`, where Q is a namespace, a class or a scoped
 * enumeration.
 *
 * @param {Object} qualifier NamespaceDecl, RecordDecl or EnumDecl.
 * @param {string} name
 * @param {Object} [options] `tagsOnly`.
 * @returns {{decls: Array.<Object>, ambiguous: boolean}}
 */
function lookupQualified(qualifier, name, options) {
  var result;
  if (qualifier.kind === 'NamespaceDecl') {
    return lookupInNamespace(qualifier, name, options);
  }
  if (qualifier.kind === 'RecordDecl') {
    result = lookupMember(qualifier, name);
    return {
      decls: applyTagHiding(result.decls, !!(options && options.tagsOnly)),
      ambiguous: result.ambiguous
    };
  }
  if (qualifier.kind === 'EnumDecl') {
    return { decls: qualifier.scope ? qualifier.scope.lookupLocal(name) : [], ambiguous: false };
  }
  return { decls: [], ambiguous: false };
}

// ---------------------------------------------------------------------------
// Unqualified lookup (C++11 3.4.1).

/**
 * Looks a name up from a scope outwards. The first scope where the name is
 * found ends the search. Members of a namespace nominated by a
 * using-directive count as declared in the nearest namespace enclosing both
 * the directive and the nominated namespace (C++11 7.3.4/2).
 *
 * @param {Scope} scope Innermost scope of the use.
 * @param {string} name
 * @param {Object} [options] `tagsOnly`: only class and enum names
 *   (elaborated type specifiers).
 * @returns {{decls: Array.<Object>, ambiguous: boolean, scope: ?Scope}}
 */
function lookupUnqualified(scope, name, options) {
  var tagsOnly = !!(options && options.tagsOnly);
  var active = [];
  var current;
  var decls;
  var member;
  var i;
  var nominated;
  var from;

  for (current = scope; current; current = current.parent) {
    // Using-directives of this scope become active for the namespaces
    // further out.
    if (current.usingDirectives.length) {
      from = enclosingNamespace(current);
      nominated = nominatedClosure(current.usingDirectives);
      for (i = 0; i < nominated.length; i++) {
        active.push({ ns: nominated[i], at: commonNamespace(from, nominated[i]) });
      }
    }

    decls = applyTagHiding(current.lookupLocal(name), tagsOnly);

    if (!decls.length && current.kind === ScopeKind.CLASS && current.entity &&
        !current.noMemberLookup) {
      member = lookupMember(current.entity, name);
      if (member.ambiguous) {
        return { decls: member.decls, ambiguous: true, scope: current };
      }
      decls = applyTagHiding(member.decls, tagsOnly);
    }

    if (current.kind === ScopeKind.NAMESPACE) {
      for (i = 0; i < active.length; i++) {
        if (active[i].at === current.entity && active[i].ns !== current.entity) {
          appendUnique(decls, applyTagHiding(active[i].ns.scope.lookupLocal(name), tagsOnly));
        }
      }
    }

    if (decls.length) {
      return { decls: decls, ambiguous: isAmbiguous(decls), scope: current };
    }
  }
  return { decls: [], ambiguous: false, scope: null };
}

module.exports = {
  ScopeKind: ScopeKind,
  Scope: Scope,
  isTag: isTag,
  applyTagHiding: applyTagHiding,
  lookupMember: lookupMember,
  lookupInNamespace: lookupInNamespace,
  lookupQualified: lookupQualified,
  lookupUnqualified: lookupUnqualified
};
