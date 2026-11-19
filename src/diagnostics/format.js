'use strict';

/**
 * Text formatting of diagnostics, in the familiar compiler style (MEMORY.md
 * section 3.4):
 *
 *     file.cpp:12:5: error: message
 *         int x = y;
 *                 ^
 *
 * The source line is printed as is; the marker line repeats the tabs found
 * before the start column so that the caret stays aligned in any editor.
 * A range is underlined with `~` up to its end or the end of the line.
 */

/** Name used as prefix when a diagnostic has no location. */
var TOOL_NAME = 'cpp2js';

/**
 * Builds the `file:line:column` (or `file` or tool name) prefix.
 *
 * @param {Diagnostic} diag
 * @returns {string}
 */
function formatLocation(diag) {
  var pos;
  if (!diag.source) {
    return TOOL_NAME;
  }
  if (diag.start === null) {
    return diag.source.path;
  }
  pos = diag.source.getPosition(diag.start);
  return diag.source.path + ':' + pos.line + ':' + pos.column;
}

/**
 * Builds the source excerpt (line + marker) of a located diagnostic.
 *
 * @param {Diagnostic} diag
 * @returns {string} The excerpt, ending with a newline, or '' if none.
 */
function formatExcerpt(diag) {
  var pos;
  var lineText;
  var marker = '';
  var startIndex;
  var endIndex;
  var i;
  if (!diag.source || diag.start === null) {
    return '';
  }
  pos = diag.source.getPosition(diag.start);
  lineText = diag.source.getLineText(pos.line);
  startIndex = Math.min(pos.column - 1, lineText.length);
  // The underline stops at the end of the start line.
  endIndex = Math.min(startIndex + (diag.end - diag.start), lineText.length);
  for (i = 0; i < startIndex; i++) {
    marker += lineText.charAt(i) === '\t' ? '\t' : ' ';
  }
  marker += '^';
  for (i = startIndex + 1; i < endIndex; i++) {
    marker += '~';
  }
  return lineText + '\n' + marker + '\n';
}

/**
 * Formats a single diagnostic (without its notes).
 *
 * @param {Diagnostic} diag
 * @returns {string} One or more lines, each ending with a newline.
 */
function formatOne(diag) {
  var text = formatLocation(diag) + ': ' + diag.severity + ': ' + diag.message;
  if (diag.promoted) {
    text += ' [-Werror]';
  }
  return text + '\n' + formatExcerpt(diag);
}

/**
 * Formats a diagnostic followed by its notes.
 *
 * @param {Diagnostic} diag
 * @returns {string} Text ending with a newline, ready for standard error.
 */
function formatDiagnostic(diag) {
  var text = formatOne(diag);
  var i;
  for (i = 0; i < diag.notes.length; i++) {
    text += formatOne(diag.notes[i]);
  }
  return text;
}

/**
 * Formats the closing summary line, e.g. `2 warnings and 1 error generated.`
 *
 * @param {number} errorCount
 * @param {number} warningCount
 * @returns {string} The summary ending with a newline, or '' if both are 0.
 */
function formatSummary(errorCount, warningCount) {
  var parts = [];
  if (warningCount) {
    parts.push(warningCount + (warningCount === 1 ? ' warning' : ' warnings'));
  }
  if (errorCount) {
    parts.push(errorCount + (errorCount === 1 ? ' error' : ' errors'));
  }
  if (!parts.length) {
    return '';
  }
  return parts.join(' and ') + ' generated.\n';
}

module.exports = {
  TOOL_NAME: TOOL_NAME,
  formatDiagnostic: formatDiagnostic,
  formatSummary: formatSummary
};
