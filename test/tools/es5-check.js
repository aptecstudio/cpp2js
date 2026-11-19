'use strict';

/**
 * Lightweight checker that rejects ES2015+ syntax and built-ins in the
 * project's own JavaScript (rule 1 of AGENTS.md). Modern Node versions
 * accept ES2015+ silently, so without this check a slip would only surface
 * when running on an old engine.
 *
 * It is a heuristic scanner, not a parser: comments, strings and regular
 * expression literals are skipped, then identifiers and punctuators are
 * matched against a deny list. It does not detect every ES2015+ construct
 * (e.g. shorthand methods, computed keys, destructuring), only the common
 * ones.
 */

var FORBIDDEN_WORDS = {
  'let': 'let declaration',
  'const': 'const declaration',
  'class': 'class syntax',
  'import': 'ES module syntax',
  'export': 'ES module syntax',
  'Map': 'Map built-in',
  'Set': 'Set built-in',
  'WeakMap': 'WeakMap built-in',
  'WeakSet': 'WeakSet built-in',
  'Promise': 'Promise built-in',
  'Symbol': 'Symbol built-in',
  'Proxy': 'Proxy built-in',
  'Reflect': 'Reflect built-in',
  'BigInt': 'BigInt built-in',
  'globalThis': 'globalThis (ES2020)'
};

// ES2015+ static members, checked as `Object.member`.
var FORBIDDEN_STATICS = {
  'Object': ['assign', 'is', 'setPrototypeOf', 'getOwnPropertySymbols', 'entries', 'values'],
  'Array': ['from', 'of'],
  'Number': ['isInteger', 'isNaN', 'isFinite', 'isSafeInteger', 'EPSILON',
    'parseFloat', 'parseInt', 'MAX_SAFE_INTEGER', 'MIN_SAFE_INTEGER'],
  'Math': ['imul', 'fround', 'trunc', 'sign', 'log2', 'log10', 'cbrt', 'hypot',
    'clz32', 'expm1', 'log1p', 'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh'],
  'String': ['raw', 'fromCodePoint'],
  'Buffer': ['from', 'alloc', 'allocUnsafe']
};

// ES2015+ prototype methods, checked as `.name(`. Names that are common in
// user-defined APIs (find, fill, keys...) are deliberately left out.
var FORBIDDEN_METHODS = {
  'startsWith': true,
  'endsWith': true,
  'includes': true,
  'repeat': true,
  'padStart': true,
  'padEnd': true,
  'codePointAt': true,
  'findIndex': true,
  'copyWithin': true
};

// Tokens after which a `/` starts a regular expression rather than a division.
var REGEX_PRECEDING_WORDS = {
  'return': true, 'typeof': true, 'instanceof': true, 'in': true, 'of': true,
  'new': true, 'delete': true, 'void': true, 'throw': true, 'case': true,
  'do': true, 'else': true
};

function isIdentStart(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch === '$';
}

function isIdentPart(ch) {
  return isIdentStart(ch) || (ch >= '0' && ch <= '9');
}

/**
 * Splits JavaScript source into significant tokens, dropping comments and
 * the content of strings and regular expressions.
 *
 * @param {string} text JavaScript source.
 * @returns {Array.<{type: string, value: string, line: number}>}
 */
function tokenize(text) {
  var tokens = [];
  var line = 1;
  var i = 0;
  var ch;
  var start;
  var quote;
  var inClass;
  var prev;

  function push(type, value, tokenLine) {
    tokens.push({ type: type, value: value, line: tokenLine });
  }

  function regexAllowed() {
    if (!prev) {
      return true;
    }
    if (prev.type === 'word') {
      return REGEX_PRECEDING_WORDS.hasOwnProperty(prev.value);
    }
    if (prev.type === 'number' || prev.type === 'string' || prev.type === 'regex') {
      return false;
    }
    return prev.value !== ')' && prev.value !== ']' && prev.value !== '}';
  }

  while (i < text.length) {
    ch = text.charAt(i);
    prev = tokens.length ? tokens[tokens.length - 1] : null;
    if (ch === '\n') {
      line++;
      i++;
    } else if (ch === ' ' || ch === '\t' || ch === '\r') {
      i++;
    } else if (ch === '/' && text.charAt(i + 1) === '/') {
      while (i < text.length && text.charAt(i) !== '\n') {
        i++;
      }
    } else if (ch === '/' && text.charAt(i + 1) === '*') {
      i += 2;
      while (i < text.length && !(text.charAt(i) === '*' && text.charAt(i + 1) === '/')) {
        if (text.charAt(i) === '\n') {
          line++;
        }
        i++;
      }
      i += 2;
    } else if (ch === '\'' || ch === '"') {
      quote = ch;
      start = line;
      i++;
      while (i < text.length && text.charAt(i) !== quote && text.charAt(i) !== '\n') {
        i += text.charAt(i) === '\\' ? 2 : 1;
      }
      i++;
      push('string', '', start);
    } else if (ch === '`') {
      push('punct', '`', line);
      i++;
    } else if (ch === '/' && regexAllowed()) {
      start = line;
      inClass = false;
      i++;
      while (i < text.length && text.charAt(i) !== '\n') {
        ch = text.charAt(i);
        if (ch === '\\') {
          i += 2;
          continue;
        }
        if (ch === '[') {
          inClass = true;
        } else if (ch === ']') {
          inClass = false;
        } else if (ch === '/' && !inClass) {
          break;
        }
        i++;
      }
      i++;
      while (i < text.length && isIdentPart(text.charAt(i))) {
        i++;
      }
      push('regex', '', start);
    } else if (isIdentStart(ch)) {
      start = i;
      while (i < text.length && isIdentPart(text.charAt(i))) {
        i++;
      }
      push('word', text.slice(start, i), line);
    } else if (ch >= '0' && ch <= '9') {
      start = i;
      while (i < text.length && (isIdentPart(text.charAt(i)) || text.charAt(i) === '.')) {
        i++;
      }
      push('number', text.slice(start, i), line);
    } else if (text.substr(i, 3) === '...') {
      push('punct', '...', line);
      i += 3;
    } else if (text.substr(i, 2) === '=>' || text.substr(i, 2) === '**') {
      push('punct', text.substr(i, 2), line);
      i += 2;
    } else {
      push('punct', ch, line);
      i++;
    }
  }
  return tokens;
}

/**
 * Finds ES2015+ constructs in a JavaScript source.
 *
 * @param {string} text JavaScript source.
 * @returns {Array.<{line: number, message: string}>} Violations, in order.
 */
function checkSource(text) {
  var tokens = tokenize(text);
  var problems = [];
  var i;
  var tok;
  var before;
  var after;
  var next;
  var statics;

  for (i = 0; i < tokens.length; i++) {
    tok = tokens[i];
    before = i > 0 ? tokens[i - 1] : null;
    after = i + 1 < tokens.length ? tokens[i + 1] : null;
    next = i + 2 < tokens.length ? tokens[i + 2] : null;
    if (tok.type === 'punct') {
      if (tok.value === '`') {
        problems.push({ line: tok.line, message: 'template literal' });
      } else if (tok.value === '=>') {
        problems.push({ line: tok.line, message: 'arrow function' });
      } else if (tok.value === '...') {
        problems.push({ line: tok.line, message: 'spread/rest syntax' });
      } else if (tok.value === '**') {
        problems.push({ line: tok.line, message: 'exponentiation operator' });
      }
      continue;
    }
    if (tok.type !== 'word') {
      continue;
    }
    // Property names (`obj.let`, `{ class: 1 }`) are fine in ES5.
    if (before && before.value === '.') {
      if (FORBIDDEN_METHODS.hasOwnProperty(tok.value) && after && after.value === '(') {
        problems.push({ line: tok.line, message: 'ES2015+ method .' + tok.value + '()' });
      }
      continue;
    }
    if (after && after.value === ':' && before && (before.value === '{' || before.value === ',')) {
      continue;
    }
    if (FORBIDDEN_STATICS.hasOwnProperty(tok.value) && after && after.value === '.' && next &&
        next.type === 'word' && FORBIDDEN_STATICS[tok.value].indexOf(next.value) !== -1) {
      problems.push({ line: tok.line, message: 'ES2015+ built-in ' + tok.value + '.' + next.value });
      continue;
    }
    if (FORBIDDEN_WORDS.hasOwnProperty(tok.value)) {
      problems.push({ line: tok.line, message: FORBIDDEN_WORDS[tok.value] });
    }
  }
  return problems;
}

module.exports = {
  tokenize: tokenize,
  checkSource: checkSource
};
