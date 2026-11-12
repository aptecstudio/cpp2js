# cpp2js

**cpp2js** is a command-line transpiler that turns C++ source code into a
single, self-contained JavaScript bundle targeting **ES5** or **ES6**.

> **Status: early development.** The project has just been initialized and
> no functionality is available yet. See [`ROADMAP.md`](ROADMAP.md) for
> progress and planned work.

## Goals

- **Real C++ front end** — preprocessing (`#include`, macros, conditional
  compilation), syntax checking, type checking and access control are
  performed before any code is generated. Invalid programs are rejected with
  clear, compiler-style diagnostics.
- **Readable output by default** — the generated JavaScript is pretty-printed
  and easy to read; a flag produces minified output instead.
- **Two targets** — choose between ES5 (maximum compatibility) and ES6 output
  with a command-line flag.
- **Optional source maps** — debug the generated JavaScript against the
  original C++ files.
- **Single bundle, zero dependencies** — all input files are linked into one
  JavaScript file. No webpack, rollup, Babel or any other external tool or
  library is used, neither by the transpiler nor by the output.
- **Encapsulation preserved** — `private` and `protected` members are
  protected in the generated code, so that external code can only access the
  public members directly.
- **Runs anywhere** — the transpiler itself is written entirely in
  JavaScript ES5 for broad backward compatibility.

## Planned usage

The interface below is designed but not implemented yet.

```sh
# Browser bundle (ES5, readable) plus the separate standard library app.std.js
cpp2js main.cpp shape.cpp -I include -o dist/app.js

# Node.js bundle, ES6, minified, with an external source map
cpp2js main.cpp --platform node --target es6 --minify --source-map -o dist/app.js

# Only check syntax and types
cpp2js main.cpp --check
```

| Option | Description |
| ------ | ----------- |
| `-o, --output <file>` | Output file (default: standard output) |
| `--target <es5\|es6>` | Output language level (default: `es5`) |
| `--platform <browser\|node\|mixed>` | Execution context (default: `browser`) |
| `--exports <exports\|global\|both>` | Where `extern "C"` functions are exported |
| `--minify` | Minified output instead of readable code |
| `--source-map [external\|inline]` | Generate a source map |
| `--embed-std` | Put the standard library inside the bundle |
| `--std-out <file>` | Path of the separate standard library file |
| `-I <dir>`, `-D <name>[=<value>]`, `-U <name>` | Preprocessor options |
| `--check` | Check syntax and types without generating output |
| `-Werror`, `-w` | Warnings as errors / no warnings |
| `--quiet`, `--verbose` | Output verbosity |
| `-h, --help`, `-v, --version` | Help and version |

A C++ program becomes a JavaScript program: the bundle runs `main()` when it
is loaded. Functions declared `extern "C"` are also exported, on `exports` in
Node.js or on the global object in the browser.

## How it works

```
C++ sources -> preprocessor -> lexer -> parser -> semantic analysis
            -> lowering -> code generation (ES5/ES6) -> printer -> bundle (+ source map)
```

Architecture details and design decisions are documented in
[`MEMORY.md`](MEMORY.md).

## Contributing

The project is a hobby project open to everyone. Before contributing — human
or AI agent — please read [`AGENTS.md`](AGENTS.md), which describes the rules
of the repository, then [`MEMORY.md`](MEMORY.md) and
[`ROADMAP.md`](ROADMAP.md).

In short:

- all code and documentation are written in English;
- the transpiler is written in plain JavaScript ES5 with no dependencies;
- all work happens on the `main` branch.

## License

cpp2js is free software, released under the
[GNU General Public License v3.0](LICENSE).
