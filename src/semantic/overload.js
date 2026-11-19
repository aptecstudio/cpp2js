'use strict';

/**
 * Overload resolution for calls to named functions (C++11 13.3), D-047.
 *
 * Candidates are the functions found by name lookup. A candidate is viable
 * if the argument count fits (default arguments and `...` considered) and
 * every argument has an implicit conversion sequence to its parameter.
 * The best viable function is better than every other one for at least
 * one argument and not worse for any (13.3.3).
 */

var T = require('./types');
var conv = require('./conversions');
var Sema = require('./sema').Sema;

var ORDINALS = ['1st', '2nd', '3rd'];

function ordinal(n) {
  return n <= 3 ? ORDINALS[n - 1] : n + 'th';
}

function requiredParams(decl) {
  var required = decl.params.length;
  while (required > 0 && decl.params[required - 1].defaultArg) {
    required--;
  }
  return required;
}

/**
 * Checks one candidate.
 *
 * @returns {{decl: Object, viable: boolean, conversions: Array.<Object>,
 *   reason: ?string}}
 */
Sema.prototype._checkCandidate = function (decl, args) {
  var type = decl.type;
  var params = type.params;
  var required = requiredParams(decl);
  var conversions = [];
  var conversion;
  var i;
  if (args.length < required || (args.length > params.length && !type.variadic)) {
    return { decl: decl, viable: false, conversions: [], reason: 'requires ' +
      (required !== params.length ? (args.length < required ? 'at least ' : 'at most ') +
        (args.length < required ? required : params.length) : params.length) +
      ' argument' + ((args.length < required ? required : params.length) === 1 ? '' : 's') +
      ', but ' + args.length + ' ' + (args.length === 1 ? 'was' : 'were') + ' provided' };
  }
  for (i = 0; i < args.length; i++) {
    if (i >= params.length) {
      conversions.push({ kind: 'ellipsis', rank: 3, steps: [], isBoolean: false,
        target: null, reference: null });
      continue;
    }
    conversion = conv.computeConversion(this, args[i], params[i]);
    if (!conversion) {
      return { decl: decl, viable: false, conversions: [], reason: 'no known conversion from ' +
        this.quote(args[i].type) + ' to ' + this.quote(params[i]) + ' for ' + ordinal(i + 1) +
        ' argument' };
    }
    conversions.push(conversion);
  }
  return { decl: decl, viable: true, conversions: conversions, reason: null };
};

/**
 * Whether candidate `a` is better than `b` (13.3.3/1, standard sequences
 * only; user-defined conversions come with classes).
 */
function isBetter(a, b) {
  var better = false;
  var i;
  var cmp;
  for (i = 0; i < a.conversions.length; i++) {
    cmp = conv.compareConversions(a.conversions[i], b.conversions[i]);
    if (cmp > 0) {
      return false;
    }
    if (cmp < 0) {
      better = true;
    }
  }
  return better;
}

/**
 * Resolves a call to an overload set and converts the arguments.
 *
 * @param {Array.<Object>} candidates FunctionDecls.
 * @param {Array.<Object>} args Argument expressions.
 * @param {Object} range Range of the call.
 * @param {string} name Function name, for messages.
 * @returns {?{decl: Object, args: Array.<Object>}} null after an error.
 */
Sema.prototype.resolveOverload = function (candidates, args, range, name) {
  var checked = [];
  var viable = [];
  var best = null;
  var ambiguous = [];
  var diag;
  var i;
  var j;
  if (candidates.length === 1) {
    // A single function gets Clang's direct messages (wrong count, or the
    // conversion error of the argument).
    return this._callSingle(candidates[0], args, range);
  }
  for (i = 0; i < candidates.length; i++) {
    checked.push(this._checkCandidate(candidates[i], args));
    if (checked[i].viable) {
      viable.push(checked[i]);
    }
  }
  if (!viable.length) {
    diag = this.error('no matching function for call to \'' + name + '\'', range);
    for (i = 0; i < checked.length; i++) {
      this.note(diag, 'candidate function not viable: ' + checked[i].reason,
        checked[i].decl.range);
    }
    return null;
  }
  for (i = 0; i < viable.length; i++) {
    for (j = 0; j < viable.length; j++) {
      if (i !== j && !isBetter(viable[i], viable[j])) {
        break;
      }
    }
    if (j === viable.length) {
      best = viable[i];
      break;
    }
  }
  if (!best) {
    for (i = 0; i < viable.length; i++) {
      ambiguous.push(viable[i]);
    }
    diag = this.error('call to \'' + name + '\' is ambiguous', range);
    for (i = 0; i < ambiguous.length; i++) {
      this.note(diag, 'candidate function', ambiguous[i].decl.range);
    }
    return null;
  }
  if (!this.checkNotDeleted(best.decl, range)) {
    return null;
  }
  return { decl: best.decl, args: this._applyCandidate(best, args, range) };
};

/**
 * Overload resolution for member functions: the implicit object argument
 * takes part as an extra first argument (C++11 13.3.1/2-5).
 *
 * @param {Array.<Object>} candidates Methods.
 * @param {Object} objType Type of the object expression.
 * @returns {?{decl: Object, args: Array.<Object>}}
 */
Sema.prototype.resolveMethodOverload = function (candidates, objType, args, range, name) {
  var checked = [];
  var viable = [];
  var best = null;
  var diag;
  var c;
  var objectConv;
  var i;
  var j;
  for (i = 0; i < candidates.length; i++) {
    objectConv = candidates[i].isStatic ? { kind: 'standard', rank: 0, steps: [],
      isBoolean: false, target: null, reference: null } :
      this._objectConversion(candidates[i], objType);
    if (!objectConv) {
      checked.push({ decl: candidates[i], viable: false, conversions: [],
        reason: '\'this\' argument has type ' + this.quote(objType) + ', but method is not ' +
          'marked ' + (objType.isConst ? 'const' : 'volatile') });
      continue;
    }
    c = this._checkCandidate(candidates[i], args);
    if (c.viable) {
      c.conversions = [objectConv].concat(c.conversions);
      viable.push(c);
    }
    checked.push(c);
  }
  if (!viable.length) {
    if (candidates.length === 1 && checked[0].reason &&
        /^'this' argument/.test(checked[0].reason)) {
      diag = this.error('\'this\' argument to member function \'' + name + '\' has type ' +
        this.quote(objType) + ', but function is not marked ' +
        (objType.isConst ? 'const' : 'volatile'), range);
      this.note(diag, '\'' + name + '\' declared here', candidates[0].range);
      return null;
    }
    if (candidates.length === 1) {
      return this._callSingle(candidates[0], args, range);
    }
    diag = this.error('no matching member function for call to \'' + name + '\'', range);
    for (i = 0; i < checked.length; i++) {
      this.note(diag, 'candidate function not viable: ' + checked[i].reason,
        checked[i].decl.range);
    }
    return null;
  }
  for (i = 0; i < viable.length; i++) {
    for (j = 0; j < viable.length; j++) {
      if (i !== j && !isBetter(viable[i], viable[j])) {
        break;
      }
    }
    if (j === viable.length) {
      best = viable[i];
      break;
    }
  }
  if (!best) {
    diag = this.error('call to member function \'' + name + '\' is ambiguous', range);
    for (i = 0; i < viable.length; i++) {
      this.note(diag, 'candidate function', viable[i].decl.range);
    }
    return null;
  }
  best.conversions = best.conversions.slice(1);
  if (name !== 'operator=' && !this.checkNotDeleted(best.decl, range)) {
    return null;
  }
  return { decl: best.decl, args: this._applyCandidate(best, args, range) };
};

/** Whether candidate `a` is better than `b` (for constructors). */
Sema.prototype._candidateBetter = function (a, b) {
  return isBetter(a, b);
};

Sema.prototype._callSingle = function (decl, args, range) {
  var converted;
  if (!this.checkNotDeleted(decl, range)) {
    return null;
  }
  converted = this._convertArguments(decl.type, decl, args, range);
  return converted ? { decl: decl, args: converted } : null;
};

/** Converts the arguments for the chosen candidate. */
Sema.prototype._applyCandidate = function (candidate, args, range) {
  var out = [];
  var params = candidate.decl.type.params;
  var i;
  for (i = 0; i < args.length; i++) {
    out.push(i < params.length ? conv.applyConversion(this, args[i],
      candidate.conversions[i]) : this.defaultArgumentPromotion(args[i]));
  }
  for (i = args.length; i < params.length; i++) {
    out.push(this._expr('DefaultArgExpr', range, { param: candidate.decl.params[i] },
      T.removeReference(params[i]), 'prvalue'));
  }
  return out;
};

module.exports = {};
