'use strict';

/**
 * C++11 preprocessor (translation phase 4), D-033.
 *
 * Reads one translation unit and produces its preprocessing tokens:
 * directives are executed, files are included and macros are expanded.
 *
 * Macro expansion follows Prosser's algorithm: every token carries a
 * *hide set*, the names of the macros it was produced by; a macro name
 * whose own name is in its hide set is not expanded again. This gives the
 * exact rescanning rules of C++11 16.3.4.
 *
 * Every token keeps its spelling position (`source`, `start`, `end`) and,
 * when produced by a macro, an `expansion` record `{site, macro}` linking to
 * the token that invoked the macro. Diagnostics and source maps walk this
 * chain up to the position in the user's file.
 */

var path = require('path');
var SourceFile = require('../source/source-file');
var DiagnosticBag = require('../diagnostics/diagnostic-bag');
var ppLexer = require('./pp-lexer');
var evaluate = require('./expression').evaluate;
var pkg = require('../../package.json');

var TokenKind = ppLexer.TokenKind;
var PPLexer = ppLexer.PPLexer;

var MAX_INCLUDE_DEPTH = 200;
var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov',
  'Dec'];

/** Directory of the headers shipped with cpp2js (D-033). */
var SYSTEM_INCLUDE_DIR = path.join(__dirname, '..', '..', 'include');

var PLACEMARKER = { kind: 'placemarker', text: '', value: '' };

// ---------------------------------------------------------------------------
// Hide sets: null or a dictionary object of macro names.

function hsHas(hs, name) {
  return hs !== null && hs[name] === true;
}

function hsCopy(hs) {
  var out = Object.create(null);
  var key;
  if (hs !== null) {
    for (key in hs) {
      out[key] = true;
    }
  }
  return out;
}

function hsAdd(hs, name) {
  var out = hsCopy(hs);
  out[name] = true;
  return out;
}

function hsUnion(a, b) {
  var out;
  var key;
  if (a === null) {
    return b;
  }
  if (b === null) {
    return a;
  }
  out = hsCopy(a);
  for (key in b) {
    out[key] = true;
  }
  return out;
}

function hsIntersect(a, b) {
  var out;
  var key;
  if (a === null || b === null) {
    return null;
  }
  out = Object.create(null);
  for (key in a) {
    if (b[key] === true) {
      out[key] = true;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Token helpers.

function copyToken(tok) {
  return {
    kind: tok.kind,
    text: tok.text,
    value: tok.value,
    source: tok.source,
    start: tok.start,
    end: tok.end,
    spaceBefore: tok.spaceBefore,
    lineStart: tok.lineStart,
    hideset: tok.hideset,
    expansion: tok.expansion
  };
}

function isPunct(tok, value) {
  return !!tok && tok.kind === TokenKind.PUNCT && tok.value === value;
}

/**
 * Returns the token in the user's file that a token comes from: itself, or
 * the outermost macro invocation that produced it.
 */
function rootOf(tok) {
  while (tok.expansion) {
    tok = tok.expansion.site;
  }
  return tok;
}

function spanOf(tok) {
  var root = rootOf(tok);
  return { source: root.source, start: root.start, end: root.end };
}

/**
 * Builds a synthetic token located at `site` (used for the results of
 * builtin macros, `defined` and `#`).
 */
function syntheticToken(kind, text, site) {
  return {
    kind: kind,
    text: text,
    value: text,
    source: site.source,
    start: site.start,
    end: site.end,
    spaceBefore: site.spaceBefore,
    lineStart: false,
    hideset: null,
    expansion: site.expansion
  };
}

function quoteString(text) {
  return '"' + text.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/**
 * Joins token spellings, with one space where whitespace separated them.
 */
function spell(tokens) {
  var out = '';
  var i;
  for (i = 0; i < tokens.length; i++) {
    if (i > 0 && tokens[i].spaceBefore) {
      out += ' ';
    }
    out += tokens[i].text;
  }
  return out;
}

function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}

/** `__CPP2JS__`: major * 10000 + minor * 100 + patch (D-033). */
function versionNumber(version) {
  var parts = version.split('.');
  return (Number(parts[0]) * 10000) + (Number(parts[1]) * 100) + Number(parts[2]);
}

// ---------------------------------------------------------------------------

/**
 * Preprocessor for one translation unit.
 *
 * @constructor
 * @param {Object} options
 * @param {DiagnosticBag} options.diagnostics Receives every diagnostic.
 * @param {function(string): string} options.readFile Reads a file; throws
 *   when it does not exist.
 * @param {Array.<string>} [options.includePaths] `-I` directories.
 * @param {Array.<string>} [options.systemIncludePaths] Directories of the
 *   headers shipped with cpp2js; defaults to the package's `include/`.
 * @param {Array.<{kind: string, name: string, value: ?string}>} [options.macros]
 *   `-D` / `-U` operations, applied in order after the predefined macros.
 * @param {string} [options.target] `es5` or `es6`.
 * @param {string} [options.platform] `browser`, `node` or `mixed`.
 * @param {Date} [options.now] Date of `__DATE__` / `__TIME__`.
 */
function Preprocessor(options) {
  this._diagnostics = options.diagnostics;
  this._readFile = options.readFile;
  this._includePaths = options.includePaths || [];
  this._systemIncludePaths = options.systemIncludePaths || [SYSTEM_INCLUDE_DIR];
  this._macros = Object.create(null);
  this._files = [];
  this._pending = [];
  this._isolated = false;
  this._inCondition = false;
  this._fatal = false;
  this._once = Object.create(null);
  this._fileCache = Object.create(null);
  this._counter = 0;
  this._now = options.now || new Date();
  this._definePredefined(options.target || 'es5', options.platform || 'browser');
  this._applyCommandLine(options.macros || []);
}

// ---------------------------------------------------------------------------
// Predefined and command-line macros.

/**
 * Defines an object-like macro from text, as if by `#define name text`.
 */
Preprocessor.prototype._defineText = function (name, text, origin) {
  var source = new SourceFile(origin, text);
  var body = ppLexer.tokenizeAll(source, this._diagnostics);
  var nameTok = syntheticToken(TokenKind.IDENTIFIER, name, {
    source: source, start: 0, end: 0, spaceBefore: false, expansion: null
  });
  this._macros[name] = {
    name: name,
    kind: 'object',
    params: [],
    variadic: false,
    body: body,
    nameToken: nameTok
  };
};

Preprocessor.prototype._defineBuiltin = function (name, expand) {
  this._macros[name] = {
    name: name,
    kind: 'builtin',
    params: [],
    variadic: false,
    body: [],
    nameToken: null,
    expand: expand
  };
};

Preprocessor.prototype._definePredefined = function (target, platform) {
  var self = this;
  var now = this._now;
  var date = MONTHS[now.getMonth()] + ' ' + (now.getDate() < 10 ? ' ' : '') + now.getDate() +
    ' ' + now.getFullYear();
  var time = pad2(now.getHours()) + ':' + pad2(now.getMinutes()) + ':' +
    pad2(now.getSeconds());
  var origin = '<built-in>';

  this._defineText('__cplusplus', '201103L', origin);
  this._defineText('__STDC_HOSTED__', '1', origin);
  this._defineText('__DATE__', quoteString(date), origin);
  this._defineText('__TIME__', quoteString(time), origin);
  this._defineText('__CPP2JS__', String(versionNumber(pkg.version)), origin);
  this._defineText('__CPP2JS_TARGET_' + target.toUpperCase() + '__', '1', origin);
  this._defineText('__CPP2JS_PLATFORM_' + platform.toUpperCase() + '__', '1', origin);

  this._defineBuiltin('__FILE__', function (site) {
    var root = rootOf(site);
    return [syntheticToken(TokenKind.STRING,
      quoteString(root.source.getPresumedLocation(root.start).path), site)];
  });
  this._defineBuiltin('__LINE__', function (site) {
    var root = rootOf(site);
    return [syntheticToken(TokenKind.NUMBER,
      String(root.source.getPresumedLocation(root.start).line), site)];
  });
  this._defineBuiltin('__COUNTER__', function (site) {
    return [syntheticToken(TokenKind.NUMBER, String(self._counter++), site)];
  });
  // Defined so that `#ifdef __has_include` works; only valid inside #if.
  this._defineBuiltin('__has_include', function (site) {
    self._diagnostics.error('\'__has_include\' can only be used in #if and #elif',
      spanOf(site));
    return [];
  });
};

Preprocessor.prototype._applyCommandLine = function (macros) {
  var i;
  for (i = 0; i < macros.length; i++) {
    if (macros[i].kind === 'define') {
      this._defineText(macros[i].name, macros[i].value, '<command line>');
    } else {
      delete this._macros[macros[i].name];
    }
  }
};

// ---------------------------------------------------------------------------
// Entry point.

/**
 * Preprocesses a translation unit.
 *
 * @param {SourceFile} main The main source file.
 * @returns {{tokens: Array.<Object>, files: Array.<SourceFile>}} The
 *   resulting tokens (without end-of-file) and every file read.
 */
Preprocessor.prototype.run = function (main) {
  var tokens = [];
  var files = [main];
  var tok;
  var key;
  this._fileCache[path.resolve(main.path)] = main;
  this._pushFile(main);
  for (;;) {
    tok = this._expandNext();
    if (tok.kind === TokenKind.EOF) {
      break;
    }
    tokens.push(tok);
  }
  for (key in this._fileCache) {
    if (this._fileCache[key] && this._fileCache[key] !== main) {
      files.push(this._fileCache[key]);
    }
  }
  return { tokens: tokens, files: files };
};

Preprocessor.prototype._pushFile = function (source) {
  this._files.push({
    source: source,
    lexer: new PPLexer(source, this._diagnostics),
    conditionals: []
  });
};

Preprocessor.prototype._top = function () {
  return this._files[this._files.length - 1];
};

/** Stops the translation unit after a fatal error. */
Preprocessor.prototype._abort = function () {
  this._fatal = true;
  this._pending = [];
};

// ---------------------------------------------------------------------------
// Token reading.

/**
 * Reads the next token from the files, executing directives and leaving
 * finished included files.
 */
Preprocessor.prototype._lexRaw = function () {
  var file;
  var tok;
  var i;
  for (;;) {
    file = this._top();
    if (this._fatal) {
      return syntheticToken(TokenKind.EOF, '', { source: file.source, start: 0, end: 0,
        spaceBefore: false, expansion: null });
    }
    tok = file.lexer.next();
    if (tok.kind === TokenKind.EOF) {
      for (i = file.conditionals.length - 1; i >= 0; i--) {
        this._diagnostics.error('unterminated conditional directive',
          spanOf(file.conditionals[i].token));
      }
      file.conditionals = [];
      if (this._files.length === 1) {
        return tok;
      }
      this._files.pop();
      continue;
    }
    if (tok.lineStart && isPunct(tok, '#')) {
      this._directive();
      continue;
    }
    return tok;
  }
};

/** Returns the next unexpanded token. */
Preprocessor.prototype._next = function () {
  if (this._pending.length) {
    return this._pending.pop();
  }
  if (this._isolated) {
    return { kind: TokenKind.EOF, text: '', value: '', expansion: null };
  }
  return this._lexRaw();
};

/** Makes `tokens` the next tokens to be read. */
Preprocessor.prototype._unread = function (tokens) {
  var i;
  for (i = tokens.length - 1; i >= 0; i--) {
    this._pending.push(tokens[i]);
  }
};

/**
 * Returns the next fully macro-expanded token.
 */
Preprocessor.prototype._expandNext = function () {
  var tok;
  var macro;
  var next;
  var call;
  for (;;) {
    tok = this._next();
    if (tok.kind !== TokenKind.IDENTIFIER) {
      return tok;
    }
    if (this._inCondition && tok.value === 'defined') {
      // Also reached when `defined` comes from a macro expansion, which
      // C++ leaves undefined; GCC and Clang evaluate it, and so does cpp2js.
      return this._definedOperator(tok);
    }
    if (tok.value === '_Pragma' && !hsHas(tok.hideset, '_Pragma')) {
      this._pragmaOperator(tok);
      continue;
    }
    macro = this._macros[tok.value];
    if (!macro || hsHas(tok.hideset, macro.name)) {
      return tok;
    }
    if (macro.kind === 'builtin') {
      this._unread(this._finishExpansion(macro.expand(tok), hsAdd(tok.hideset, macro.name),
        tok));
      continue;
    }
    if (macro.kind === 'object') {
      this._unread(this._finishExpansion(this._substitute(macro, null, tok),
        hsAdd(tok.hideset, macro.name), tok));
      continue;
    }
    // A function-like macro name not followed by `(` is an ordinary name.
    next = this._next();
    if (!isPunct(next, '(')) {
      this._unread([next]);
      return tok;
    }
    call = this._collectArguments(macro, tok);
    if (call === null) {
      continue;
    }
    this._unread(this._finishExpansion(this._substitute(macro, call.args, tok),
      hsAdd(hsIntersect(tok.hideset, call.rparen.hideset), macro.name), tok));
  }
};

/**
 * Fully expands a list of tokens in isolation (macro arguments, directive
 * operands): the expansion cannot read past the end of the list.
 */
Preprocessor.prototype._expandList = function (tokens) {
  var savedPending = this._pending;
  var savedIsolated = this._isolated;
  var out = [];
  var tok;
  this._pending = [];
  this._isolated = true;
  this._unread(tokens);
  for (;;) {
    tok = this._expandNext();
    if (tok.kind === TokenKind.EOF) {
      break;
    }
    out.push(tok);
  }
  this._pending = savedPending;
  this._isolated = savedIsolated;
  return out;
};

/**
 * Adds the hide set to the substituted tokens and places the first one
 * where the macro name was.
 */
Preprocessor.prototype._finishExpansion = function (tokens, hideset, site) {
  var out = [];
  var tok;
  var i;
  for (i = 0; i < tokens.length; i++) {
    tok = copyToken(tokens[i]);
    tok.hideset = hsUnion(tok.hideset, hideset);
    out.push(tok);
  }
  if (out.length) {
    out[0].spaceBefore = site.spaceBefore;
  }
  return out;
};

// ---------------------------------------------------------------------------
// Function-like macro invocation.

Preprocessor.prototype._noteDefinition = function (diag, macro) {
  if (macro.nameToken && macro.nameToken.source.path.charAt(0) !== '<') {
    diag.addNote('macro \'' + macro.name + '\' defined here', spanOf(macro.nameToken));
  }
};

/**
 * Reads the arguments of a function-like macro invocation, after its `(`.
 *
 * @returns {?{args: Array.<Array.<Object>>, rparen: Object}} null after an
 *   error.
 */
Preprocessor.prototype._collectArguments = function (macro, site) {
  var args = [[]];
  var depth = 0;
  var tok;
  var expected = macro.params.length;
  for (;;) {
    tok = this._next();
    if (tok.kind === TokenKind.EOF) {
      this._noteDefinition(this._diagnostics.error(
        'unterminated function-like macro invocation', spanOf(site)), macro);
      this._unread([tok]);
      return null;
    }
    if (isPunct(tok, '(')) {
      depth++;
    } else if (isPunct(tok, ')')) {
      if (depth === 0) {
        break;
      }
      depth--;
    } else if (isPunct(tok, ',') && depth === 0 &&
        (!macro.variadic || args.length < expected)) {
      args.push([]);
      continue;
    }
    args[args.length - 1].push(tok);
  }

  if (expected === 0 && args.length === 1 && args[0].length === 0) {
    args = [];
  } else if (macro.variadic && args.length === expected - 1) {
    // The variadic part may be omitted entirely (as in GCC and C++20).
    args.push([]);
  }
  if (args.length !== expected) {
    this._noteDefinition(this._diagnostics.error(
      (args.length < expected ? 'too few' : 'too many') +
      ' arguments provided to function-like macro invocation', spanOf(site)), macro);
    return null;
  }
  return { args: args, rparen: tok };
};

/**
 * Replaces a macro invocation with the macro body: parameters, `#` and `##`
 * (C++11 16.3.1-16.3.3).
 *
 * @param {Object} macro
 * @param {?Array.<Array.<Object>>} args Arguments (null for object-like).
 * @param {Object} site The macro name token of the invocation.
 * @returns {Array.<Object>}
 */
Preprocessor.prototype._substitute = function (macro, args, site) {
  var body = macro.body;
  var expanded = [];
  var out = [];
  var self = this;
  var i;
  var tok;
  var index;
  var operand;
  var lhs;
  var vaIndex = macro.variadic ? macro.params.length - 1 : -1;

  function paramIndex(t) {
    return args !== null && t && t.kind === TokenKind.IDENTIFIER ?
      macro.params.indexOf(t.value) : -1;
  }

  function fromBody(t) {
    var copy = copyToken(t);
    copy.expansion = { site: site, macro: macro.name };
    return copy;
  }

  function expandedArg(n) {
    if (!expanded[n]) {
      expanded[n] = self._expandList(args[n]);
    }
    return expanded[n];
  }

  for (i = 0; i < body.length; i++) {
    tok = body[i];

    // GNU extension: `, ## __VA_ARGS__` drops the comma when the variadic
    // argument is empty.
    if (isPunct(tok, ',') && isPunct(body[i + 1], '##') && vaIndex !== -1 &&
        paramIndex(body[i + 2]) === vaIndex) {
      if (args[vaIndex].length) {
        out.push(fromBody(tok));
        out = out.concat(args[vaIndex]);
      }
      i += 2;
      continue;
    }

    if (args !== null && isPunct(tok, '#')) {
      out.push(this._stringize(args[paramIndex(body[i + 1])], fromBody(tok)));
      i++;
      continue;
    }

    if (isPunct(tok, '##')) {
      tok = body[++i];
      if (args !== null && isPunct(tok, '#')) {
        operand = [this._stringize(args[paramIndex(body[i + 1])], fromBody(tok))];
        i++;
      } else if ((index = paramIndex(tok)) !== -1) {
        operand = args[index].slice();
      } else {
        operand = [fromBody(tok)];
      }
      lhs = out.length ? out.pop() : PLACEMARKER;
      out.push(this._paste(lhs, operand.length ? operand[0] : PLACEMARKER, site));
      out = out.concat(operand.slice(1));
      continue;
    }

    index = paramIndex(tok);
    if (index !== -1) {
      if (isPunct(body[i + 1], '##')) {
        // Operand of `##`: the argument is used unexpanded.
        out = out.concat(args[index].length ? args[index] : [PLACEMARKER]);
      } else {
        operand = expandedArg(index);
        if (operand.length) {
          operand = operand.slice();
          operand[0] = copyToken(operand[0]);
          operand[0].spaceBefore = tok.spaceBefore;
        }
        out = out.concat(operand);
      }
      continue;
    }

    out.push(fromBody(tok));
  }

  return out.filter(function (t) { return t !== PLACEMARKER; });
};

/**
 * The `#` operator: spells an argument as a string literal.
 */
Preprocessor.prototype._stringize = function (arg, hashTok) {
  var parts = [];
  var i;
  var text;
  for (i = 0; i < arg.length; i++) {
    text = arg[i].text;
    if (arg[i].kind === TokenKind.STRING || arg[i].kind === TokenKind.CHAR) {
      text = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    }
    parts.push((i > 0 && arg[i].spaceBefore ? ' ' : '') + text);
  }
  return syntheticToken(TokenKind.STRING, '"' + parts.join('') + '"', hashTok);
};

/**
 * The `##` operator: pastes two tokens, which must form one valid token.
 */
Preprocessor.prototype._paste = function (lhs, rhs, site) {
  var text;
  var bag;
  var tokens;
  var result;
  if (lhs === PLACEMARKER) {
    return rhs;
  }
  if (rhs === PLACEMARKER) {
    return lhs;
  }
  text = lhs.text + rhs.text;
  bag = new DiagnosticBag();
  tokens = ppLexer.tokenizeAll(new SourceFile('<paste>', text), bag);
  if (bag.hasErrors() || tokens.length !== 1 || tokens[0].text !== text) {
    this._diagnostics.error('pasting formed \'' + text + '\', an invalid preprocessing token',
      spanOf(site));
    return lhs;
  }
  result = copyToken(lhs);
  result.kind = tokens[0].kind;
  result.text = text;
  result.value = tokens[0].value;
  result.hideset = hsIntersect(lhs.hideset, rhs.hideset);
  return result;
};

// ---------------------------------------------------------------------------
// Directives.

/**
 * Reads the remaining tokens of the directive line.
 */
Preprocessor.prototype._readLine = function () {
  var lexer = this._top().lexer;
  var out = [];
  var tok = lexer.next(true);
  while (tok.kind !== TokenKind.EOF) {
    out.push(tok);
    tok = lexer.next(true);
  }
  return out;
};

/**
 * Warns about tokens left after a directive and skips them.
 */
Preprocessor.prototype._endDirective = function (name) {
  var lexer = this._top().lexer;
  var tok;
  if (!lexer.atEndOfLine()) {
    tok = lexer.next(true);
    this._diagnostics.warning('extra tokens at end of #' + name + ' directive', spanOf(tok));
    lexer.skipLine();
  }
};

/**
 * Executes the directive whose `#` has just been read.
 */
Preprocessor.prototype._directive = function () {
  var lexer = this._top().lexer;
  var nameTok = lexer.next(true);
  if (nameTok.kind === TokenKind.EOF) {
    return;
  }
  if (nameTok.kind !== TokenKind.IDENTIFIER) {
    this._diagnostics.error('invalid preprocessing directive', spanOf(nameTok));
    lexer.skipLine();
    return;
  }
  switch (nameTok.value) {
    case 'define':
      this._define();
      return;
    case 'undef':
      this._undef();
      return;
    case 'include':
      this._include(nameTok);
      return;
    case 'if':
      this._if(nameTok, this._evaluateCondition(nameTok));
      return;
    case 'ifdef':
    case 'ifndef':
      this._ifdef(nameTok);
      return;
    case 'elif':
    case 'else':
    case 'endif':
      this._elseGroup(nameTok);
      return;
    case 'line':
      this._line(nameTok);
      return;
    case 'error':
    case 'warning':
      this._message(nameTok);
      return;
    case 'pragma':
      this._pragma(this._readLine(), nameTok);
      return;
  }
  this._diagnostics.error('invalid preprocessing directive #' + nameTok.value,
    spanOf(nameTok));
  lexer.skipLine();
};

Preprocessor.prototype._readMacroName = function (directive) {
  var lexer = this._top().lexer;
  var tok = lexer.next(true);
  if (tok.kind === TokenKind.EOF) {
    this._diagnostics.error('macro name missing', spanOf(directive || tok));
    return null;
  }
  if (tok.kind !== TokenKind.IDENTIFIER) {
    this._diagnostics.error('macro name must be an identifier', spanOf(tok));
    lexer.skipLine();
    return null;
  }
  if (tok.value === 'defined') {
    this._diagnostics.error('\'defined\' cannot be used as a macro name', spanOf(tok));
    lexer.skipLine();
    return null;
  }
  return tok;
};

/** `#define`. */
Preprocessor.prototype._define = function () {
  var lexer = this._top().lexer;
  var nameTok = this._readMacroName(null);
  var macro;
  var first;
  var tok;
  var old;
  var i;
  if (!nameTok) {
    return;
  }
  macro = {
    name: nameTok.value,
    kind: 'object',
    params: [],
    variadic: false,
    body: [],
    nameToken: nameTok
  };
  first = lexer.next(true);
  if (isPunct(first, '(') && !first.spaceBefore) {
    macro.kind = 'function';
    if (!this._readParams(macro)) {
      lexer.skipLine();
      return;
    }
    first = lexer.next(true);
  } else if (first.kind !== TokenKind.EOF && !first.spaceBefore) {
    this._diagnostics.warning('whitespace required after the macro name', spanOf(first));
  }
  tok = first;
  while (tok.kind !== TokenKind.EOF) {
    tok = copyToken(tok);
    tok.lineStart = false;
    macro.body.push(tok);
    tok = lexer.next(true);
  }
  if (!this._checkBody(macro)) {
    return;
  }
  old = this._macros[macro.name];
  if (old && !sameDefinition(old, macro)) {
    if (old.kind === 'builtin' || (old.nameToken && old.nameToken.source.path === '<built-in>')) {
      this._diagnostics.warning('redefining builtin macro \'' + macro.name + '\'',
        spanOf(nameTok));
    } else {
      i = this._diagnostics.warning('\'' + macro.name + '\' macro redefined', spanOf(nameTok));
      if (old.nameToken && old.nameToken.source.path.charAt(0) !== '<') {
        i.addNote('previous definition is here', spanOf(old.nameToken));
      }
    }
  }
  this._macros[macro.name] = macro;
};

/**
 * Reads the parameter list of a function-like macro, after its `(`.
 *
 * @returns {boolean} false after an error.
 */
Preprocessor.prototype._readParams = function (macro) {
  var lexer = this._top().lexer;
  var tok = lexer.next(true);
  if (isPunct(tok, ')')) {
    return true;
  }
  for (;;) {
    if (isPunct(tok, '...')) {
      macro.variadic = true;
      macro.params.push('__VA_ARGS__');
      tok = lexer.next(true);
      if (!isPunct(tok, ')')) {
        this._diagnostics.error('missing \')\' in macro parameter list', spanOf(tok));
        return false;
      }
      return true;
    }
    if (tok.kind !== TokenKind.IDENTIFIER) {
      this._diagnostics.error(tok.kind === TokenKind.EOF ?
        'missing \')\' in macro parameter list' : 'invalid token in macro parameter list',
        spanOf(tok));
      return false;
    }
    if (tok.value === '__VA_ARGS__') {
      this._diagnostics.error('__VA_ARGS__ can only appear in the expansion of a C++11 ' +
        'variadic macro', spanOf(tok));
      return false;
    }
    if (macro.params.indexOf(tok.value) !== -1) {
      this._diagnostics.error('duplicate macro parameter name \'' + tok.value + '\'',
        spanOf(tok));
      return false;
    }
    macro.params.push(tok.value);
    tok = lexer.next(true);
    if (isPunct(tok, ')')) {
      return true;
    }
    if (!isPunct(tok, ',')) {
      this._diagnostics.error(tok.kind === TokenKind.EOF ?
        'missing \')\' in macro parameter list' : 'expected comma in macro parameter list',
        spanOf(tok));
      return false;
    }
    tok = lexer.next(true);
  }
};

/**
 * Checks the constraints on a macro body (C++11 16.3.2, 16.3.3).
 */
Preprocessor.prototype._checkBody = function (macro) {
  var body = macro.body;
  var i;
  if (body.length && (isPunct(body[0], '##') || isPunct(body[body.length - 1], '##'))) {
    this._diagnostics.error('\'##\' cannot appear at either end of a macro expansion',
      spanOf(isPunct(body[0], '##') ? body[0] : body[body.length - 1]));
    return false;
  }
  for (i = 0; i < body.length; i++) {
    if (body[i].kind === TokenKind.IDENTIFIER && body[i].value === '__VA_ARGS__' &&
        !macro.variadic) {
      this._diagnostics.error('__VA_ARGS__ can only appear in the expansion of a C++11 ' +
        'variadic macro', spanOf(body[i]));
      return false;
    }
    if (macro.kind === 'function' && isPunct(body[i], '#') &&
        !(body[i + 1] && body[i + 1].kind === TokenKind.IDENTIFIER &&
          macro.params.indexOf(body[i + 1].value) !== -1)) {
      this._diagnostics.error('\'#\' is not followed by a macro parameter', spanOf(body[i]));
      return false;
    }
  }
  return true;
};

/**
 * Two definitions are the same if they have the same kind, parameters and
 * body spelling, including where whitespace appears (C++11 16.3/1).
 */
function sameDefinition(a, b) {
  var i;
  if (a.kind !== b.kind || a.variadic !== b.variadic || a.params.join(',') !==
      b.params.join(',') || a.body.length !== b.body.length) {
    return false;
  }
  for (i = 0; i < a.body.length; i++) {
    if (a.body[i].text !== b.body[i].text ||
        (i > 0 && a.body[i].spaceBefore !== b.body[i].spaceBefore)) {
      return false;
    }
  }
  return true;
}

/** `#undef`. */
Preprocessor.prototype._undef = function () {
  var nameTok = this._readMacroName(null);
  if (!nameTok) {
    return;
  }
  delete this._macros[nameTok.value];
  this._endDirective('undef');
};

// ---------------------------------------------------------------------------
// #include and __has_include.

/**
 * Turns the tokens of a computed include (`#include MACRO`) into a header
 * name.
 *
 * @returns {?{name: string, angled: boolean}}
 */
function headerFromTokens(tokens) {
  var last;
  if (tokens.length === 1 && tokens[0].kind === TokenKind.STRING &&
      tokens[0].text.charAt(0) === '"') {
    return { name: tokens[0].text.slice(1, -1), angled: false };
  }
  last = tokens.length - 1;
  if (tokens.length >= 2 && isPunct(tokens[0], '<') && isPunct(tokens[last], '>')) {
    tokens = tokens.slice(1, last);
    if (tokens.length) {
      tokens[0] = copyToken(tokens[0]);
      tokens[0].spaceBefore = false;
    }
    return { name: spell(tokens), angled: true };
  }
  return null;
}

/**
 * Reads the header operand of `#include` from the current directive line:
 * `<name>`, `"name"`, or tokens that expand to one of them.
 *
 * @param {Object} directive The `include` token, for locations.
 * @returns {?{name: string, angled: boolean, token: Object}}
 */
Preprocessor.prototype._readHeaderName = function (directive) {
  var lexer = this._top().lexer;
  var tok = lexer.nextHeaderName();
  var tokens;
  var header;
  if (tok) {
    return { name: tok.value, angled: true, token: tok };
  }
  tokens = this._readLine();
  if (tokens.length && tokens[0].kind === TokenKind.STRING &&
      tokens[0].text.charAt(0) === '"') {
    if (tokens.length > 1) {
      this._diagnostics.warning('extra tokens at end of #include directive',
        spanOf(tokens[1]));
    }
    return { name: tokens[0].text.slice(1, -1), angled: false, token: tokens[0] };
  }
  header = tokens.length ? headerFromTokens(this._expandList(tokens)) : null;
  if (!header) {
    this._diagnostics.error('expected "FILENAME" or <FILENAME>',
      spanOf(tokens.length ? tokens[0] : directive));
    return null;
  }
  header.token = tokens[0];
  return header;
};

/**
 * Finds an included file.
 *
 * @param {string} name Header name as written.
 * @param {boolean} angled `<...>` (true) or `"..."` (false).
 * @param {SourceFile} includer File containing the directive.
 * @returns {?SourceFile}
 */
Preprocessor.prototype._findHeader = function (name, angled, includer) {
  var dirs = [];
  var i;
  var candidate;
  var key;
  var text;
  if (!angled) {
    dirs.push(path.dirname(includer.path));
  }
  dirs = dirs.concat(this._includePaths, this._systemIncludePaths);
  for (i = 0; i < dirs.length; i++) {
    candidate = path.join(dirs[i], name);
    key = path.resolve(candidate);
    if (this._fileCache[key] === undefined) {
      try {
        text = this._readFile(candidate);
        this._fileCache[key] = new SourceFile(candidate, text);
      } catch (err) {
        this._fileCache[key] = null;
      }
    }
    if (this._fileCache[key]) {
      return this._fileCache[key];
    }
  }
  return null;
};

/** `#include`. */
Preprocessor.prototype._include = function (directive) {
  var header = this._readHeaderName(directive);
  var file;
  if (!header) {
    return;
  }
  if (header.token.kind === TokenKind.HEADER_NAME) {
    this._endDirective('include');
  }
  if (!header.name) {
    this._diagnostics.error('empty filename', spanOf(header.token));
    return;
  }
  file = this._findHeader(header.name, header.angled, this._top().source);
  if (!file) {
    // Fatal, as in GCC and Clang: later errors would only be noise.
    this._diagnostics.error('\'' + header.name + '\' file not found', spanOf(header.token));
    this._abort();
    return;
  }
  if (this._once[path.resolve(file.path)]) {
    return;
  }
  if (this._files.length >= MAX_INCLUDE_DEPTH) {
    this._diagnostics.error('#include nested too deeply', spanOf(header.token));
    this._abort();
    return;
  }
  this._pushFile(file);
};

// ---------------------------------------------------------------------------
// Conditional inclusion.

/**
 * Reads and evaluates the expression of `#if` / `#elif`.
 *
 * @returns {boolean}
 */
Preprocessor.prototype._evaluateCondition = function (directive) {
  var tokens = this._replaceHasInclude(this._readLine());
  var errors = this._diagnostics.errorCount;
  var result;
  if (tokens === null) {
    return false;
  }
  this._inCondition = true;
  tokens = this._expandList(tokens);
  this._inCondition = false;
  if (this._diagnostics.errorCount > errors) {
    return false;
  }
  result = evaluate(tokens, directive, this._diagnostics);
  return result === true;
};

/**
 * The `defined X` / `defined ( X )` operator, inside `#if` and `#elif`.
 * The operand is read unexpanded.
 *
 * @returns {Object} A `1` or `0` token.
 */
Preprocessor.prototype._definedOperator = function (tok) {
  var next = this._next();
  var paren = isPunct(next, '(');
  var name = paren ? this._next() : next;
  var close;
  if (name.kind !== TokenKind.IDENTIFIER) {
    this._diagnostics.error('macro name must be an identifier',
      spanOf(name.kind === TokenKind.EOF ? tok : name));
    return syntheticToken(TokenKind.NUMBER, '0', tok);
  }
  if (paren) {
    close = this._next();
    if (!isPunct(close, ')')) {
      this._diagnostics.error('missing \')\' after \'defined\'', spanOf(name))
        .addNote('to match this \'(\'', spanOf(next));
      return syntheticToken(TokenKind.NUMBER, '0', tok);
    }
  }
  return syntheticToken(TokenKind.NUMBER, this._macros[name.value] ? '1' : '0', tok);
};

/**
 * Replaces `__has_include(...)` with `1` or `0`. Done before macro
 * expansion, so that `<...>` and the header name are taken literally.
 *
 * @param {Array.<Object>} tokens
 * @returns {?Array.<Object>} null after an error.
 */
Preprocessor.prototype._replaceHasInclude = function (tokens) {
  var out = [];
  var i;
  var tok;
  var close;
  var header;
  for (i = 0; i < tokens.length; i++) {
    tok = tokens[i];
    if (tok.kind === TokenKind.IDENTIFIER && tok.value === 'defined') {
      // Keep `defined X` intact: X must not be mistaken for __has_include.
      out.push(tok);
      if (tokens[i + 1]) {
        out.push(tokens[++i]);
      }
    } else if (tok.kind === TokenKind.IDENTIFIER &&
        tok.value === '__has_include' && this._macros.__has_include) {
      close = -1;
      if (isPunct(tokens[i + 1], '(')) {
        for (close = i + 2; close < tokens.length && !isPunct(tokens[close], ')'); close++) {
          // Find the closing parenthesis.
        }
      }
      header = close > i + 2 && close < tokens.length ?
        headerFromTokens(tokens.slice(i + 2, close)) : null;
      if (!header) {
        this._diagnostics.error('\'__has_include\' requires a header name in parentheses',
          spanOf(tok));
        return null;
      }
      out.push(syntheticToken(TokenKind.NUMBER,
        this._findHeader(header.name, header.angled, this._top().source) ? '1' : '0', tok));
      i = close;
    } else {
      out.push(tok);
    }
  }
  return out;
};

/** `#if`, after evaluating its condition. */
Preprocessor.prototype._if = function (directive, taken) {
  this._top().conditionals.push({ token: directive, taken: taken, sawElse: false });
  if (!taken) {
    this._skipGroup();
  }
};

/** `#ifdef` / `#ifndef`. */
Preprocessor.prototype._ifdef = function (directive) {
  var nameTok = this._readMacroName(directive);
  var defined;
  if (!nameTok) {
    this._if(directive, false);
    return;
  }
  this._endDirective(directive.value);
  defined = !!this._macros[nameTok.value];
  this._if(directive, directive.value === 'ifdef' ? defined : !defined);
};

/**
 * `#elif`, `#else`, `#endif` met while a group is being processed: the
 * group ends; any following group is skipped.
 */
Preprocessor.prototype._elseGroup = function (directive) {
  var conditionals = this._top().conditionals;
  var current = conditionals[conditionals.length - 1];
  var lexer = this._top().lexer;
  if (!current) {
    this._diagnostics.error('#' + directive.value + ' without #if', spanOf(directive));
    lexer.skipLine();
    return;
  }
  if (directive.value === 'endif') {
    this._endDirective('endif');
    conditionals.pop();
    return;
  }
  if (current.sawElse) {
    this._diagnostics.error('#' + directive.value + ' after #else', spanOf(directive));
  }
  if (directive.value === 'else') {
    current.sawElse = true;
    this._endDirective('else');
  } else {
    lexer.skipLine();
  }
  // The group before was processed, so every remaining group is skipped.
  current.taken = true;
  this._skipGroup();
};

/**
 * Skips lines until the `#elif`, `#else` or `#endif` that ends the current
 * group, processing only nested conditional structure (C++11 16.1/6).
 */
Preprocessor.prototype._skipGroup = function () {
  var file = this._top();
  var lexer = file.lexer;
  var current = file.conditionals[file.conditionals.length - 1];
  var depth = 0;
  var tok;
  var name;
  var quiet = lexer.quiet;
  lexer.quiet = true;
  for (;;) {
    tok = lexer.next();
    if (tok.kind === TokenKind.EOF) {
      break;
    }
    if (!(tok.lineStart && isPunct(tok, '#'))) {
      lexer.skipLine();
      continue;
    }
    name = lexer.next(true);
    if (name.kind !== TokenKind.IDENTIFIER) {
      if (name.kind !== TokenKind.EOF) {
        lexer.skipLine();
      }
      continue;
    }
    if (name.value === 'if' || name.value === 'ifdef' || name.value === 'ifndef') {
      depth++;
      lexer.skipLine();
      continue;
    }
    if (depth > 0) {
      if (name.value === 'endif') {
        depth--;
      }
      lexer.skipLine();
      continue;
    }
    if (name.value === 'endif') {
      lexer.quiet = quiet;
      this._endDirective('endif');
      file.conditionals.pop();
      return;
    }
    if (name.value === 'else' || name.value === 'elif') {
      lexer.quiet = quiet;
      if (current.sawElse) {
        this._diagnostics.error('#' + name.value + ' after #else', spanOf(name));
      }
      if (name.value === 'else') {
        current.sawElse = true;
        this._endDirective('else');
        if (!current.taken) {
          current.taken = true;
          return;
        }
      } else if (!current.taken) {
        if (this._evaluateCondition(name)) {
          current.taken = true;
          return;
        }
      } else {
        lexer.skipLine();
      }
      lexer.quiet = true;
      continue;
    }
    lexer.skipLine();
  }
  lexer.quiet = quiet;
};

// ---------------------------------------------------------------------------
// #line, #error, #warning, #pragma, _Pragma.

/** `#line digit-sequence ["file"]`. */
Preprocessor.prototype._line = function (directive) {
  var tokens = this._expandList(this._readLine());
  var file = this._top();
  var lineTok = tokens[0];
  var nameTok = tokens[1];
  var line;
  if (!lineTok || lineTok.kind !== TokenKind.NUMBER || !/^[0-9]+$/.test(lineTok.text) ||
      Number(lineTok.text) === 0) {
    this._diagnostics.error('#line directive requires a positive integer argument',
      spanOf(lineTok || directive));
    return;
  }
  line = Number(lineTok.text);
  if (line > 2147483647) {
    this._diagnostics.error('line number out of range in #line directive', spanOf(lineTok));
    return;
  }
  if (nameTok && (nameTok.kind !== TokenKind.STRING || nameTok.text.charAt(0) !== '"')) {
    this._diagnostics.error('invalid filename for #line directive', spanOf(nameTok));
    return;
  }
  if (tokens.length > 2) {
    this._diagnostics.warning('extra tokens at end of #line directive', spanOf(tokens[2]));
  }
  file.source.addLineMapping(file.source.getPosition(directive.start).line + 1, line,
    nameTok ? nameTok.text.slice(1, -1).replace(/\\(["\\])/g, '$1') : null);
};

/** `#error` and `#warning` (D-033). */
Preprocessor.prototype._message = function (directive) {
  var lexer = this._top().lexer;
  var quiet = lexer.quiet;
  var text;
  lexer.quiet = true;
  text = spell(this._readLine());
  lexer.quiet = quiet;
  if (directive.value === 'error') {
    this._diagnostics.error('#error ' + text, spanOf(directive));
  } else {
    this._diagnostics.warning('#warning ' + text, spanOf(directive));
  }
};

/**
 * Executes a pragma. Only `once` has an effect; other pragmas are ignored,
 * as GCC and Clang do by default.
 */
Preprocessor.prototype._pragma = function (tokens, site) {
  var file = this._top();
  if (tokens.length && tokens[0].kind === TokenKind.IDENTIFIER && tokens[0].value === 'once') {
    if (this._files.length === 1) {
      this._diagnostics.warning('#pragma once in main file', spanOf(site));
    }
    this._once[path.resolve(file.source.path)] = true;
  }
};

/** The `_Pragma("...")` operator (C++11 16.9). */
Preprocessor.prototype._pragmaOperator = function (site) {
  var open = this._next();
  var str = isPunct(open, '(') ? this._next() : open;
  var close = str !== open ? this._next() : str;
  var text;
  if (!isPunct(open, '(') || str.kind !== TokenKind.STRING || !/^L?"/.test(str.text) ||
      !isPunct(close, ')')) {
    this._diagnostics.error('_Pragma takes a parenthesized string literal', spanOf(site));
    return;
  }
  text = str.text.replace(/^L/, '').slice(1, -1).replace(/\\(["\\])/g, '$1');
  this._pragma(ppLexer.tokenizeAll(new SourceFile('<_Pragma>', text), this._diagnostics), site);
};

module.exports = {
  SYSTEM_INCLUDE_DIR: SYSTEM_INCLUDE_DIR,
  Preprocessor: Preprocessor,
  spell: spell
};
