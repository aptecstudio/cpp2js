'use strict';

var diagnostic = require('./diagnostic');

var Severity = diagnostic.Severity;
var Diagnostic = diagnostic.Diagnostic;

/**
 * Collects the diagnostics produced during a compilation and applies the
 * warning policy chosen on the command line (D-021): `-w` drops warnings,
 * `-Werror` turns them into errors.
 *
 * @constructor
 * @param {{warningsAsErrors: (boolean|undefined),
 *          ignoreWarnings: (boolean|undefined)}} [options]
 * @throws {Error} If both options are set (they are mutually exclusive).
 */
function DiagnosticBag(options) {
  options = options || {};
  if (options.warningsAsErrors && options.ignoreWarnings) {
    throw new Error('warningsAsErrors and ignoreWarnings are mutually exclusive');
  }
  this._warningsAsErrors = !!options.warningsAsErrors;
  this._ignoreWarnings = !!options.ignoreWarnings;
  this._items = [];
  this.errorCount = 0;
  this.warningCount = 0;
}

/**
 * Records a diagnostic, applying the warning policy. Notes cannot be
 * reported on their own: attach them to an error or a warning.
 *
 * @param {Diagnostic} diag The diagnostic to record.
 * @returns {?Diagnostic} The recorded diagnostic, or null if it was dropped.
 * @throws {TypeError} If `diag` is a note.
 */
DiagnosticBag.prototype.report = function (diag) {
  if (diag.severity === Severity.NOTE) {
    throw new TypeError('Notes must be attached to an error or a warning');
  }
  if (diag.severity === Severity.WARNING) {
    if (this._ignoreWarnings) {
      return null;
    }
    if (this._warningsAsErrors) {
      diag.severity = Severity.ERROR;
      diag.promoted = true;
    }
  }
  if (diag.severity === Severity.ERROR) {
    this.errorCount++;
  } else {
    this.warningCount++;
  }
  this._items.push(diag);
  return diag;
};

/**
 * Creates and records an error.
 *
 * @param {string} message Text of the error.
 * @param {?Object} [span] Location, as accepted by `Diagnostic`.
 * @returns {Diagnostic} The new error, so that notes can be attached.
 */
DiagnosticBag.prototype.error = function (message, span) {
  return this.report(new Diagnostic(Severity.ERROR, message, span));
};

/**
 * Creates and records a warning. When warnings are ignored the warning is
 * still returned, so that callers can attach notes unconditionally, but it
 * is not recorded.
 *
 * @param {string} message Text of the warning.
 * @param {?Object} [span] Location, as accepted by `Diagnostic`.
 * @returns {Diagnostic} The new warning.
 */
DiagnosticBag.prototype.warning = function (message, span) {
  var diag = new Diagnostic(Severity.WARNING, message, span);
  this.report(diag);
  return diag;
};

/**
 * Returns whether at least one error was recorded.
 *
 * @returns {boolean}
 */
DiagnosticBag.prototype.hasErrors = function () {
  return this.errorCount > 0;
};

/**
 * Returns the recorded diagnostics in reporting order.
 *
 * @returns {Array.<Diagnostic>}
 */
DiagnosticBag.prototype.getAll = function () {
  return this._items.slice();
};

module.exports = DiagnosticBag;
