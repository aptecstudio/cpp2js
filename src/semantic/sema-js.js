'use strict';

/**
 * Inline JavaScript: `__js__` statements and expressions (D-026, D-058),
 * extends Sema.prototype.
 *
 *   __js__("code" : "=" (out), "+" (inout) : (in1), (in2));
 *   T value = __js__<T>("expression" : (in1));
 *
 * In the code, `%N` (N decimal) is operand N, outputs first then inputs,
 * as in GCC's extended asm; `%%` is a literal `%`. A `%` not followed by a
 * digit is kept as is, so JavaScript's `a % b` needs no escaping.
 */

var ast = require('../ast/nodes');
var T = require('./types');
var Sema = require('./sema').Sema;

/** Decodes the UTF-8 units of a narrow string literal into a JS string. */
function decodeUtf8(units) {
  var out = '';
  var i = 0;
  var c;
  var code;
  while (i < units.length) {
    c = units[i];
    if (c < 0x80) {
      code = c;
      i += 1;
    } else if (c < 0xe0) {
      code = ((c & 0x1f) << 6) | (units[i + 1] & 0x3f);
      i += 2;
    } else if (c < 0xf0) {
      code = ((c & 0x0f) << 12) | ((units[i + 1] & 0x3f) << 6) | (units[i + 2] & 0x3f);
      i += 3;
    } else {
      code = ((c & 0x07) << 18) | ((units[i + 1] & 0x3f) << 12) |
        ((units[i + 2] & 0x3f) << 6) | (units[i + 3] & 0x3f);
      i += 4;
    }
    if (code > 0xffff) {
      code -= 0x10000;
      out += String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff));
    } else {
      out += String.fromCharCode(code);
    }
  }
  return out;
}

/**
 * Splits the code into text and operand references.
 *
 * @returns {?Array.<(string|number)>} Text pieces and operand indexes, or
 *   null after an error.
 */
Sema.prototype._parseJsTemplate = function (code, operandCount, range) {
  var parts = [];
  var text = '';
  var i = 0;
  var match;
  var index;
  while (i < code.length) {
    if (code.charAt(i) === '%' && code.charAt(i + 1) === '%') {
      text += '%';
      i += 2;
      continue;
    }
    if (code.charAt(i) === '%' && /[0-9]/.test(code.charAt(i + 1))) {
      match = /^[0-9]+/.exec(code.slice(i + 1));
      index = Number(match[0]);
      if (index >= operandCount) {
        this.error('invalid operand number %' + index + ' in inline JavaScript: ' +
          (operandCount ? 'operands are %0 to %' + (operandCount - 1) : 'there are no ' +
            'operands'), range);
        return null;
      }
      if (text) {
        parts.push(text);
        text = '';
      }
      parts.push(index);
      i += 1 + match[0].length;
      continue;
    }
    text += code.charAt(i);
    i++;
  }
  if (text) {
    parts.push(text);
  }
  return parts;
};

/** The code of a `__js__` from its string literal token value. */
Sema.prototype._jsCode = function (literal, range) {
  if (literal.encoding !== '' && literal.encoding !== 'u8') {
    this.error('inline JavaScript must be a narrow string literal', range);
    return null;
  }
  return decodeUtf8(literal.units);
};

/** Converts the inputs: scalars as rvalues, class objects as they are. */
Sema.prototype._jsInputs = function (inputs) {
  var self = this;
  return inputs.map(function (input) {
    if (!input) {
      return null;
    }
    if (T.isRecord(input.type)) {
      return input;
    }
    if (T.isVoid(input.type)) {
      self.error('inline JavaScript operand cannot have type \'void\'', input.range);
      return null;
    }
    return self.rvalue(input);
  });
};

/**
 * `__js__("code" : outputs : inputs);`
 *
 * @param {Object} literal Decoded string literal value.
 * @param {Array.<{constraint: string, expr: Object, range: Object}>} outputs
 * @param {Array.<Object>} inputs
 * @returns {Object} JsStmt.
 */
Sema.prototype.actOnJsStatement = function (literal, outputs, inputs, range) {
  var code = this._jsCode(literal, range);
  var self = this;
  var outs = [];
  var ins;
  var constraints = [];
  var parts;
  outputs.forEach(function (o) {
    if (o.constraint !== '=' && o.constraint !== '+') {
      self.error('output constraint must be \'=\' or \'+\'', o.range);
      return;
    }
    if (o.expr && self.checkModifiable(o.expr, o.expr.range)) {
      outs.push(o.expr);
      constraints.push(o.constraint);
    }
  });
  ins = this._jsInputs(inputs);
  // An invalid output leaves the statement without code (already reported).
  parts = code === null || outs.length !== outputs.length ? null :
    this._parseJsTemplate(code, outputs.length + inputs.length, range);
  return ast.createNode('JsStmt', range, { code: parts, outputs: outs, inputs: ins,
    constraints: constraints });
};

/**
 * `__js__<T>("expression" : inputs)`: a prvalue of type T computed by
 * JavaScript code.
 */
Sema.prototype.actOnJsExpression = function (type, literal, inputs, range) {
  var code = this._jsCode(literal, range);
  var parts;
  if (T.isReference(type)) {
    this.error('result type of inline JavaScript cannot be a reference', range);
    return null;
  }
  if (T.isArray(type) || T.isFunction(type)) {
    this.error('result type of inline JavaScript cannot be ' + (T.isArray(type) ?
      'an array' : 'a function') + ' type ' + this.quote(type), range);
    return null;
  }
  if (!T.isVoid(type) && !T.isComplete(type)) {
    this.error('result type of inline JavaScript has incomplete type ' + this.quote(type),
      range);
    return null;
  }
  parts = code === null ? null : this._parseJsTemplate(code, inputs.length, range);
  if (parts === null) {
    return null;
  }
  return this._expr('JsExpr', range, { code: parts, inputs: this._jsInputs(inputs) },
    T.isRecord(type) ? type.unqualified : type.unqualified, 'prvalue');
};

module.exports = {
  decodeUtf8: decodeUtf8
};
