#!/usr/bin/env node
'use strict';

var run = require('../src/cli/main').run;

var code = run(process.argv.slice(2), {
  stdout: function (text) {
    process.stdout.write(text);
  },
  stderr: function (text) {
    process.stderr.write(text);
  }
});

// Only exit explicitly on failure: on success the process ends by itself
// once standard output is flushed, so a bundle written to a pipe is never
// truncated. Failures only write short messages to standard error.
if (code !== 0) {
  process.exit(code);
}
