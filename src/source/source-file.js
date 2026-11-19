'use strict';

/**
 * A source file: its path, its text and the mapping between character
 * offsets and 1-based line/column positions.
 *
 * Offsets are 0-based indexes into `text` (UTF-16 code units, as in every
 * JavaScript string). Lines and columns are 1-based. Line terminators are
 * `\n`, `\r\n` and a lone `\r`; the terminator belongs to the line it ends.
 *
 * @constructor
 * @param {string} path Path of the file as it should appear in diagnostics.
 * @param {string} text Full content of the file.
 */
function SourceFile(path, text) {
  this.path = path;
  this.text = text;
  this._lineStarts = null;
  // Mappings set by #line, sorted by physical line (see addLineMapping).
  this._lineMappings = [];
}

/**
 * Returns the offsets at which each line starts, computing them on first use.
 *
 * @returns {Array.<number>}
 */
SourceFile.prototype._getLineStarts = function () {
  var starts;
  var text;
  var i;
  var ch;
  if (this._lineStarts === null) {
    starts = [0];
    text = this.text;
    for (i = 0; i < text.length; i++) {
      ch = text.charCodeAt(i);
      if (ch === 13) {
        if (text.charCodeAt(i + 1) === 10) {
          i++;
        }
        starts.push(i + 1);
      } else if (ch === 10) {
        starts.push(i + 1);
      }
    }
    this._lineStarts = starts;
  }
  return this._lineStarts;
};

/**
 * Returns the number of lines. A file ending with a terminator has a final
 * empty line, as editors show it.
 *
 * @returns {number}
 */
SourceFile.prototype.getLineCount = function () {
  return this._getLineStarts().length;
};

/**
 * Converts an offset to a 1-based line/column position. Offsets past the end
 * are clamped to the end of the text.
 *
 * @param {number} offset 0-based character offset.
 * @returns {{line: number, column: number}}
 * @throws {RangeError} If the offset is negative or not an integer.
 */
SourceFile.prototype.getPosition = function (offset) {
  var starts = this._getLineStarts();
  var low = 0;
  var high = starts.length - 1;
  var mid;
  if (offset !== Math.floor(offset) || offset < 0) {
    throw new RangeError('Invalid offset: ' + offset);
  }
  if (offset > this.text.length) {
    offset = this.text.length;
  }
  // Binary search for the last line starting at or before the offset.
  while (low < high) {
    mid = (low + high + 1) >> 1;
    if (starts[mid] <= offset) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return { line: low + 1, column: offset - starts[low] + 1 };
};

/**
 * Converts a 1-based line/column position to an offset. Columns past the end
 * of the line are clamped to the line end (before its terminator).
 *
 * @param {number} line 1-based line number.
 * @param {number} column 1-based column number.
 * @returns {number}
 * @throws {RangeError} If the line or column is out of range.
 */
SourceFile.prototype.getOffset = function (line, column) {
  var starts = this._getLineStarts();
  var start;
  var length;
  if (line < 1 || line > starts.length || line !== Math.floor(line)) {
    throw new RangeError('Invalid line: ' + line);
  }
  if (column < 1 || column !== Math.floor(column)) {
    throw new RangeError('Invalid column: ' + column);
  }
  start = starts[line - 1];
  length = this.getLineText(line).length;
  return start + Math.min(column - 1, length);
};

/**
 * Returns the text of a line, without its terminator.
 *
 * @param {number} line 1-based line number.
 * @returns {string}
 * @throws {RangeError} If the line is out of range.
 */
SourceFile.prototype.getLineText = function (line) {
  var starts = this._getLineStarts();
  var end;
  if (line < 1 || line > starts.length || line !== Math.floor(line)) {
    throw new RangeError('Invalid line: ' + line);
  }
  end = line < starts.length ? starts[line] : this.text.length;
  return this.text.slice(starts[line - 1], end).replace(/\r?\n$|\r$/, '');
};

/**
 * Records a `#line` directive: from `physicalLine` on, lines are presumed
 * to be numbered from `presumedLine` in the file `presumedPath`.
 *
 * @param {number} physicalLine 1-based line following the directive.
 * @param {number} presumedLine Number given to that line.
 * @param {?string} presumedPath New file name, or null to keep the current
 *   presumed name.
 * @returns {void}
 */
SourceFile.prototype.addLineMapping = function (physicalLine, presumedLine, presumedPath) {
  var previous = this._lineMappings.length ?
    this._lineMappings[this._lineMappings.length - 1] : null;
  this._lineMappings.push({
    physicalLine: physicalLine,
    presumedLine: presumedLine,
    presumedPath: presumedPath !== null ? presumedPath :
      (previous ? previous.presumedPath : this.path)
  });
};

/**
 * Returns the position as presumed after `#line` directives: the file name
 * and line number that `__FILE__`, `__LINE__` and diagnostics show. The
 * column is always the physical one.
 *
 * @param {number} offset 0-based character offset.
 * @returns {{path: string, line: number, column: number}}
 */
SourceFile.prototype.getPresumedLocation = function (offset) {
  var pos = this.getPosition(offset);
  var mapping = null;
  var i;
  for (i = this._lineMappings.length - 1; i >= 0; i--) {
    if (this._lineMappings[i].physicalLine <= pos.line) {
      mapping = this._lineMappings[i];
      break;
    }
  }
  if (!mapping) {
    return { path: this.path, line: pos.line, column: pos.column };
  }
  return {
    path: mapping.presumedPath,
    line: mapping.presumedLine + (pos.line - mapping.physicalLine),
    column: pos.column
  };
};

module.exports = SourceFile;
