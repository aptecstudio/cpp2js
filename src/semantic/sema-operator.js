'use strict';

/**
 * Overloaded operators and user-defined conversions (C++11 13.3.1.2,
 * 13.5, 12.3), extends Sema.prototype, D-053.
 *
 * An operator expression with an operand of class or enumeration type
 * looks for `operator@` as a member of the left operand's class and as a
 * non-member (ordinary lookup plus the namespaces of the operands' classes,
 * a simplified argument-dependent lookup). Built-in candidates are not
 * mixed in: when no user operator is viable the built-in rules apply.
 *
 * User-defined conversions: a converting (non-explicit) constructor of the
 * target class, or a conversion function `operator T()` of the source
 * class, followed by a standard conversion.
 */

var T = require('./types');
var scopes = require('./scope');
var conv = require('./conversions');
var Sema = require('./sema').Sema;

/** Operators that may be overloaded, with their allowed arity (13.5). */
var OVERLOADABLE = {
  '+': [1, 2], '-': [1, 2], '*': [1, 2], '/': [2], '%': [2], '^': [2], '&': [1, 2], '|': [2],
  '~': [1], '!': [1], '=': [2], '<': [2], '>': [2], '+=': [2], '-=': [2], '*=': [2],
  '/=': [2], '%=': [2], '^=': [2], '&=': [2], '|=': [2], '<<': [2], '>>': [2], '>>=': [2],
  '<<=': [2], '==': [2], '!=': [2], '<=': [2], '>=': [2], '&&': [2], '||': [2], '++': [1, 2],
  '--': [1, 2], ',': [2], '->*': [2], '->': [1], '()': null, '[]': [2], 'new': null,
  'delete': null, 'new[]': null, 'delete[]': null
};

/** Operators that must be non-static members (13.5.3-13.5.6). */
var MEMBER_ONLY = { '=': true, '()': true, '[]': true, '->': true };

// ---------------------------------------------------------------------------
// Declarations of operator functions.

/**
 * Checks a declaration of `operator@` (member or not): arity and the
 * requirement of a class or enumeration parameter for non-members.
 *
 * @param {Object} decl FunctionDecl named `operator@`.
 * @param {string} op The operator.
 * @param {boolean} isMember
 */
Sema.prototype.checkOperatorDeclaration = function (decl, op, isMember) {
  var arity = OVERLOADABLE[op];
  var params = decl.type.params.length + (isMember && !decl.isStatic ? 1 : 0);
  var hasClass;
  if (arity === undefined) {
    this.error('\'' + op + '\' cannot be overloaded', decl.range);
    return;
  }
  decl.overloadedOperator = op;
  if (op === 'new' || op === 'delete' || op === 'new[]' || op === 'delete[]') {
    this.error('overloading \'operator ' + op + '\' is not supported yet', decl.range);
    return;
  }
  if (MEMBER_ONLY[op] && !isMember) {
    this.error('overloaded \'operator' + op + '\' must be a non-static member function',
      decl.range);
    return;
  }
  if (decl.type.variadic && op !== '()') {
    this.error('overloaded \'operator' + op + '\' cannot be variadic', decl.range);
  }
  if (arity && arity.indexOf(params) === -1) {
    this.error('overloaded \'operator' + op + '\' must be ' + (arity.length === 2 ?
      'a unary or binary' : arity[0] === 1 ? 'a unary' : 'a binary') + ' operator (has ' +
      params + ' parameter' + (params === 1 ? '' : 's') + ')', decl.range);
    return;
  }
  if ((op === '++' || op === '--') && params === 2 &&
      decl.type.params[decl.type.params.length - 1] !== this.types.builtin('int')) {
    this.error('parameter of overloaded post-' + (op === '++' ? 'increment' : 'decrement') +
      ' operator must have type \'int\' (not ' +
      this.quote(decl.type.params[decl.type.params.length - 1]) + ')', decl.range);
  }
  if (!isMember) {
    hasClass = decl.type.params.some(function (p) {
      var t = T.removeReference(p);
      return T.isRecord(t) || T.isEnum(t);
    });
    if (!hasClass) {
      this.error('overloaded \'operator' + op + '\' must have at least one parameter of ' +
        'class or enumeration type', decl.range);
    }
  }
};

/** Conversion function `operator T()` (12.3.2). */
Sema.prototype.checkConversionFunction = function (decl, target) {
  decl.conversionType = target;
  decl.methodKind = 'conversion';
  if (decl.type.params.length || decl.type.variadic) {
    this.error('conversion function cannot have any parameters', decl.range);
  }
  if (T.isFunction(target) || T.isArray(target)) {
    this.error('conversion function cannot convert to ' + (T.isFunction(target) ?
      'a function type' : 'an array type'), decl.range);
  }
};

// ---------------------------------------------------------------------------
// Operator expressions.

/** Whether an operand calls for overloaded-operator lookup. */
function needsOverload(expr) {
  var t = expr && expr.type ? T.removeReference(expr.type) : null;
  return !!t && (T.isRecord(t) || T.isEnum(t));
}

/** Associated namespaces of a class (simplified ADL, 3.4.2). */
Sema.prototype._associatedNamespaces = function (types) {
  var out = [];
  types.forEach(function (t) {
    var decl;
    t = t ? T.removeReference(t) : null;
    if (t && T.isPointer(t)) {
      t = t.pointee;
    }
    if (!t || !(T.isRecord(t) || T.isEnum(t))) {
      return;
    }
    decl = t.decl.parent;
    while (decl && decl.kind !== 'NamespaceDecl') {
      decl = decl.parent;
    }
    if (decl && out.indexOf(decl) === -1) {
      out.push(decl);
    }
  });
  return out;
};

/**
 * Candidate functions named `name` for a call or operator: ordinary
 * unqualified lookup plus the associated namespaces of the argument types.
 */
Sema.prototype.adlCandidates = function (name, args) {
  var found = scopes.lookupUnqualified(this.scope, name).decls.filter(function (d) {
    return d.kind === 'FunctionDecl' && !d.isMethod;
  });
  var namespaces = this._associatedNamespaces(args.map(function (a) { return a.type; }));
  namespaces.forEach(function (ns) {
    scopes.lookupInNamespace(ns, name).decls.forEach(function (d) {
      if (d.kind === 'FunctionDecl' && found.indexOf(d) === -1) {
        found.push(d);
      }
    });
  });
  return require('./sema-expr').uniqueFunctions(found);
};

/**
 * Tries an overloaded operator for `op` with the given operands.
 *
 * @param {string} op Operator spelling ('+', '[]', '()', '++', ...).
 * @param {Array.<Object>} operands One or two operands (postfix `++`
 *   passes an extra int literal).
 * @param {Object} range
 * @returns {?Object|undefined} The call, null after an error, or
 *   undefined when no user operator applies (use the built-in rules).
 */
Sema.prototype.tryOverloadedOperator = function (op, operands, range) {
  var name = 'operator' + op;
  var left = operands[0];
  var leftType = left && left.type ? T.removeReference(left.type) : null;
  var members = [];
  var nonMembers;
  var all = [];
  var checked = [];
  var viable = [];
  var i;
  var c;
  var best;
  var diag;
  if (!operands.some(needsOverload)) {
    return undefined;
  }
  if (leftType && T.isRecord(leftType) && leftType.decl.complete) {
    members = scopes.lookupMember(leftType.decl, name).decls.filter(function (d) {
      return d.kind === 'FunctionDecl';
    });
    members = require('./sema-expr').uniqueFunctions(members);
  }
  nonMembers = MEMBER_ONLY[op] ? [] : this.adlCandidates(name, operands);
  for (i = 0; i < members.length; i++) {
    c = this._checkMethodCandidate(members[i], leftType, operands.slice(1));
    c.isMember = true;
    checked.push(c);
  }
  for (i = 0; i < nonMembers.length; i++) {
    c = this._checkCandidate(nonMembers[i], operands);
    checked.push(c);
  }
  all = checked;
  viable = all.filter(function (x) { return x.viable; });
  if (!viable.length) {
    if (!all.length || op === '=' || op === '&' || op === ',' || op === '->') {
      return undefined;
    }
    // A class operand with no viable user operator may still work with
    // the built-in rules after a conversion; report only if it cannot.
    return undefined;
  }
  best = this._bestCandidate(viable);
  if (!best) {
    diag = this.error('use of overloaded operator \'' + op + '\' is ambiguous (with operand ' +
      'types ' + operands.map(function (o) { return this.quote(o.type); }, this).join(' and ') +
      ')', range);
    viable.forEach(function (v) {
      this.note(diag, 'candidate function', v.decl.range);
    }, this);
    return null;
  }
  if (!this.checkNotDeleted(best.decl, range)) {
    return null;
  }
  return this._buildOperatorCall(op, best, operands, range);
};

/** Checks a member operator candidate with its implicit object argument. */
Sema.prototype._checkMethodCandidate = function (method, objType, args) {
  var objectConv = this._objectConversion(method, objType);
  var c;
  if (!objectConv) {
    return { decl: method, viable: false, conversions: [], reason: 'object type' };
  }
  c = this._checkCandidate(method, args);
  if (c.viable) {
    c.conversions = [objectConv].concat(c.conversions);
  }
  return c;
};

Sema.prototype._bestCandidate = function (viable) {
  var i;
  var j;
  for (i = 0; i < viable.length; i++) {
    for (j = 0; j < viable.length; j++) {
      if (i !== j && !this._compareAligned(viable[i], viable[j])) {
        break;
      }
    }
    if (j === viable.length) {
      return viable[i];
    }
  }
  return null;
};

/**
 * Compares a member and a non-member candidate argument by argument; the
 * member's implicit object argument lines up with the first operand.
 */
Sema.prototype._compareAligned = function (a, b) {
  var better = false;
  var i;
  var cmp;
  var n = Math.max(a.conversions.length, b.conversions.length);
  for (i = 0; i < n; i++) {
    if (!a.conversions[i] || !b.conversions[i]) {
      continue;
    }
    cmp = conv.compareConversions(a.conversions[i], b.conversions[i]);
    if (cmp > 0) {
      return false;
    }
    if (cmp < 0) {
      better = true;
    }
  }
  return better;
};

/** Builds the CallExpr of an overloaded operator. */
Sema.prototype._buildOperatorCall = function (op, best, operands, range) {
  var decl = best.decl;
  var args;
  var callee;
  var call;
  if (best.isMember) {
    best.conversions = best.conversions.slice(1);
    args = this._applyCandidate(best, operands.slice(1), range);
    callee = this._expr('MemberExpr', range, { object: operands[0], member: decl,
      isArrow: false }, decl.type, 'prvalue');
  } else {
    args = this._applyCandidate(best, operands, range);
    callee = this.rvalue(this.selectOverload(this._expr('DeclRefExpr', range, { decl: decl },
      decl.type, 'lvalue'), decl));
  }
  if (args.indexOf(null) !== -1) {
    return null;
  }
  call = this._expr('CallExpr', range, { callee: callee, args: args, 'function': decl },
    T.isReference(decl.type.returnType) ? decl.type.returnType.referee :
      (T.isRecord(decl.type.returnType) ? decl.type.returnType :
        decl.type.returnType.unqualified),
    decl.type.returnType.kind === T.TypeKind.LVALUE_REF ? 'lvalue' :
      decl.type.returnType.kind === T.TypeKind.RVALUE_REF ? 'xvalue' : 'prvalue');
  call.overloadedOperator = op;
  call.isVirtualCall = !!decl.isVirtual && best.isMember;
  return call;
};

// ---------------------------------------------------------------------------
// User-defined conversions (C++11 13.3.3.1.2).

/**
 * Finds a user-defined conversion sequence from `expr` to `toType`: a
 * converting constructor of the target class or a conversion function of
 * the source class, each followed by a standard conversion.
 *
 * @param {boolean} [allowExplicit] Direct-initialization contexts.
 * @returns {?Object} A conversion sequence of kind 'user', or null; an
 *   ambiguity is reported through `out.ambiguous`.
 */
Sema.prototype.userConversion = function (expr, toType, allowExplicit, out) {
  var target = T.removeReference(toType).unqualified;
  var source = T.removeReference(expr.type);
  var found = [];
  var self = this;
  var placeholder;
  if (this._inUserConversion) {
    // At most one user-defined conversion in a sequence (13.3.3.1/4).
    return null;
  }
  this._inUserConversion = true;
  try {
    if (T.isRecord(target) && target.decl.complete) {
      (target.decl.constructors || []).forEach(function (ctor) {
        var params = ctor.type.params;
        var second;
        var required = ctor.params.length;
        while (required > 1 && ctor.params[required - 1].defaultArg) {
          required--;
        }
        if ((ctor.isExplicit && !allowExplicit) || !params.length || required > 1 ||
            ctor.isDeleted || ctor.special === 'copy' || ctor.special === 'move') {
          return;
        }
        second = conv.computeConversion(self, expr, params[0]);
        if (second && second.kind !== 'user') {
          found.push({ via: ctor, first: second, rank: second.rank, kind: 'constructor' });
        }
      });
    }
    if (T.isRecord(source) && source.decl.complete) {
      self._conversionFunctions(source.decl).forEach(function (fn) {
        var result;
        var second;
        if (self._objectConversion(fn, source) === null || (fn.isExplicit && !allowExplicit)) {
          return;
        }
        result = fn.conversionType;
        placeholder = { type: T.removeReference(result), valueCategory:
          result.kind === T.TypeKind.LVALUE_REF ? 'lvalue' : 'prvalue', kind: 'CallExpr',
          range: expr.range };
        second = conv.computeConversion(self, placeholder, toType);
        if (second && second.kind !== 'user') {
          found.push({ via: fn, second: second, rank: second.rank, kind: 'function' });
        }
      });
    }
  } finally {
    this._inUserConversion = false;
  }
  if (!found.length) {
    return null;
  }
  // Prefer the candidate whose second standard conversion is best.
  found.sort(function (a, b) { return a.rank - b.rank; });
  if (found.length > 1 && found[0].rank === found[1].rank) {
    if (out) {
      out.ambiguous = found;
    }
    return null;
  }
  return { kind: 'user', rank: 3, steps: [{ castKind: 'UserDefinedConversion', type: target,
    valueCategory: 'prvalue', user: found[0], toType: toType }], isBoolean: false,
    target: toType, reference: null, userFunction: found[0].via };
};

/** Conversion functions of a class and its bases. */
Sema.prototype._conversionFunctions = function (record) {
  var own = record.members.filter(function (m) {
    return m.kind === 'FunctionDecl' && m.methodKind === 'conversion';
  });
  var bases = record.bases || [];
  var self = this;
  bases.forEach(function (b) {
    own = own.concat(self._conversionFunctions(b.type.decl));
  });
  return own;
};

/**
 * Applies a user-defined conversion: constructs the target, or calls the
 * conversion function, then the second standard conversion.
 */
Sema.prototype.applyUserConversion = function (expr, step) {
  var user = step.user;
  var result;
  var first;
  if (user.kind === 'constructor') {
    first = conv.applyConversion(this, expr, user.first);
    if (!first) {
      return null;
    }
    result = this._expr('ConstructExpr', expr.range, { constructorDecl: user.via,
      args: [first] }, T.removeReference(step.toType).unqualified, 'prvalue');
    if (T.isReference(step.toType)) {
      result = this.implicitCast(result, 'MaterializeTemporary', step.toType.referee,
        step.toType.kind === T.TypeKind.LVALUE_REF ? 'lvalue' : 'xvalue');
    }
    return result;
  }
  result = this._expr('CallExpr', expr.range, {
    callee: this._expr('MemberExpr', expr.range, { object: expr, member: user.via,
      isArrow: false }, user.via.type, 'prvalue'),
    args: [],
    'function': user.via
  }, T.removeReference(user.via.conversionType), user.via.conversionType.kind ===
    T.TypeKind.LVALUE_REF ? 'lvalue' : 'prvalue');
  return conv.applyConversion(this, result, user.second);
};

module.exports = {
  OVERLOADABLE: OVERLOADABLE
};
