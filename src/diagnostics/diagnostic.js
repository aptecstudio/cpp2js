'use strict';

/**
 * Severity levels of a diagnostic.
 *
 * @enum {string}
 */
var Severity = {
  ERROR: 'error',
  // Stops the compilation (the error limit was reached).
  FATAL: 'fatal error',
  WARNING: 'warning',
  NOTE: 'note'
};

/**
 * Checks a span and returns a normalized copy.
 *
 * @param {?{source: SourceFile, start: (number|undefined), end: (number|undefined)}} span
 * @returns {{source: ?SourceFile, start: ?number, end: ?number}}
 * @throws {RangeError} If `end` precedes `start`.
 */
function normalizeSpan(span) {
  var start;
  var end;
  if (!span || !span.source) {
    return { source: null, start: null, end: null };
  }
  start = typeof span.start === 'number' ? span.start : null;
  end = typeof span.end === 'number' ? span.end : start;
  if (start === null) {
    end = null;
  } else if (end < start) {
    throw new RangeError('Diagnostic span ends before it starts');
  }
  return { source: span.source, start: start, end: end };
}

/**
 * A message about the user's input: an error, a warning or a note.
 *
 * A diagnostic may point to a range of a source file (`source`, `start`,
 * `end`, with `end` exclusive), to a whole file (`start` null) or to nothing
 * (e.g. usage errors). Errors and warnings may carry notes that give extra
 * context, such as the location of a previous declaration.
 *
 * @constructor
 * @param {Severity} severity Severity level.
 * @param {string} message Text of the message, without a trailing period.
 * @param {?{source: SourceFile, start: (number|undefined), end: (number|undefined)}} [span]
 *   Location the diagnostic refers to.
 * @throws {TypeError} If the severity is unknown.
 */
function Diagnostic(severity, message, span) {
  var normalized = normalizeSpan(span);
  if (severity !== Severity.ERROR && severity !== Severity.WARNING &&
      severity !== Severity.NOTE && severity !== Severity.FATAL) {
    throw new TypeError('Unknown diagnostic severity: ' + severity);
  }
  this.severity = severity;
  this.message = message;
  this.source = normalized.source;
  this.start = normalized.start;
  this.end = normalized.end;
  this.notes = [];
  // Set when a warning was turned into an error by -Werror.
  this.promoted = false;
}

/**
 * Attaches a note to this diagnostic.
 *
 * @param {string} message Text of the note.
 * @param {?{source: SourceFile, start: (number|undefined), end: (number|undefined)}} [span]
 * @returns {Diagnostic} This diagnostic, for chaining.
 */
Diagnostic.prototype.addNote = function (message, span) {
  this.notes.push(new Diagnostic(Severity.NOTE, message, span));
  return this;
};

module.exports = {
  Severity: Severity,
  Diagnostic: Diagnostic
};
