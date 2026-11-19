# MEMORY.md

Long-term memory of the `cpp2js` project: decisions taken (and why), code
structure, syntax conventions and the stylistic traits of everything the
project produces.

> Update this file at the end of every task that introduces or changes a
> decision. Never delete a decision: mark it as **Superseded by D-xxx** and
> explain why. See `AGENTS.md` for the full rules.

---

## 1. Decision log

Each entry: **ID — title**, status, decision, reason, discarded alternatives.

### D-001 — Implementation language: JavaScript ES5

- **Status**: Accepted (project brief).
- **Decision**: every source file of the transpiler is plain ES5.
- **Reason**: maximum backward compatibility; the tool must run on old
  JavaScript engines and Node.js versions.
- **Consequences**: no `let`/`const`, arrow functions, classes, template
  literals, destructuring, `Map`/`Set`/`WeakMap`, `Symbol`, Promises or ES
  modules in the transpiler sources. Modules use CommonJS
  (`require`/`module.exports`). Dictionaries use `Object.create(null)`.

### D-002 — Command-line tool

- **Status**: Accepted (project brief).
- **Decision**: the transpiler is a CLI program with flags controlling its
  behaviour. The CLI is a thin layer on top of a programmatic API, so the
  core can be reused (tests, other hosts).
- **Reason**: required by the brief; separating API and CLI keeps the core
  testable without spawning processes.

### D-003 — Output targets ES5 and ES6

- **Status**: Accepted (project brief).
- **Decision**: the generated code targets ES5 or ES6 (ES2015), selected by a
  flag. The default output is pretty-printed and readable; a flag enables
  minified output.
- **Reason**: required by the brief. Readable output is the default because
  it makes the transpiler's behaviour easy to inspect and debug.
- **Default target**: **ES5** (decided in D-011).

### D-004 — Optional source maps

- **Status**: Accepted (project brief).
- **Decision**: source maps (Source Map Revision 3, VLQ-encoded mappings)
  are generated on demand, either as a separate `.map` file or inline.
- **Reason**: lets users debug the generated JavaScript against the original
  C++ sources.

### D-005 — Self-contained bundle, no external tools

- **Status**: Accepted (project brief).
- **Decision**: all translation units given as input are combined into a
  single JavaScript bundle by the transpiler itself. No webpack, rollup,
  esbuild, Babel or any other third-party library — neither at build time
  nor inside the generated bundle.
- **Reason**: required by the brief; keeps the project dependency-free and
  fully understandable.

### D-006 — Full front-end responsibility

- **Status**: Accepted (project brief).
- **Decision**: the transpiler performs preprocessing (`#include`, macros,
  conditional compilation), syntax checking, type checking, name and include
  resolution, and access control (`public` / `protected` / `private`).
  Invalid programs are rejected with diagnostics, as a C++ compiler would.
- **Reason**: required by the brief; the generated JavaScript can then rely
  on the program being well-formed and well-typed.

### D-007 — Protection of private and protected members

- **Status**: Accepted (project brief); technique chosen in D-012.
- **Decision**: private and protected members must not be directly
  reachable from code outside the bundle; only public members are exposed
  directly.
- **Reason**: required by the brief; preserves the C++ encapsulation
  guarantees at runtime.

### D-008 — Language and style of the repository

- **Status**: Accepted (project brief).
- **Decision**: everything in the repository is written in English; chat
  with the owner is in Italian. Code follows standard JavaScript conventions
  (section 3).

### D-009 — Single branch, GPL-3.0

- **Status**: Accepted (project brief).
- **Decision**: all work on `main`; the project is licensed GPL-3.0 (full
  text in `LICENSE`).

### D-010 — Reference standard: basic C++11

- **Status**: Accepted (owner, 2026-11-12).
- **Decision**: the first goal is a basic C++11 subset: classes, single
  inheritance, virtual functions, namespaces, overloading, enums, plus the
  C++11 features `auto`, `nullptr`, `enum class`, range-based `for` and
  lambdas. Templates, exceptions and multiple inheritance are planned but
  come after the core works.
- **Discarded**: C++98/03 only (too limiting for modern code), C-like subset
  (too small to be useful).

### D-011 — Bundle runs as a program; default target ES5

- **Status**: Accepted (owner, 2026-11-12).
- **Decision**: the generated bundle is an executable program: it calls
  `main()` when loaded. If no target flag is given, the output is ES5.
- **Reason**: mirrors how a C++ program is built and run; ES5 default is
  consistent with the project's backward-compatibility goal.
- **Discarded**: library-style bundle exporting the public API (may be added
  later behind a flag); ES6 as default.

### D-012 — Private/protected members: obfuscated names

- **Status**: Accepted (owner, 2026-11-12). Implements D-007.
- **Decision**: private and protected members are renamed to opaque names
  generated per build and defined as **non-enumerable** properties
  (`Object.defineProperty`, `enumerable: false`). The mapping from C++ names
  to obfuscated names exists only at compile time. The same technique is used
  on both targets.
- **Reason**: simple, fast, works identically on ES5 and ES6, no per-instance
  closures and no `WeakMap` requirement. Protected members and `friend`
  access are resolved at compile time, so derived classes and friends use the
  obfuscated names directly.
- **Known limit**: this is obfuscation, not hard privacy. The members do not
  appear in `for…in`, `Object.keys` or `JSON.stringify` and their names are
  unpredictable, but they can still be discovered via
  `Object.getOwnPropertyNames`. Accepted by the owner.
- **Discarded**: `WeakMap`/closure storage (hybrid), per-instance closures.

### D-013 — Standard library as a separate, tree-shaken, platform-aware bundle

- **Status**: Accepted (owner, 2026-11-12).
- **Decision**:
  - the C++ standard library is implemented in JavaScript by the project
    (no third-party code);
  - when a target is generated, the transpiler also produces a **separate
    standard library bundle** containing **only the parts actually used** by
    the program (dead-code elimination at the level of headers, classes and
    functions);
  - a flag allows **embedding** that bundle inside the main output instead of
    emitting it as a separate file;
  - the library **adapts to the execution context**: browser, Node.js, and
    mixed environments such as Electron (Node + browser). Context-dependent
    parts (console/streams, file system, timers, process exit…) are isolated
    behind a small platform layer.
- **Reason**: owner requirement; keeps output small and lets several programs
  share one standard library file.
- **Header order and platform selection**: see D-015 and D-017.
- **Linking of the separate library file**: see D-019.

### D-014 — `extern "C"` symbols become the bundle's public exports

- **Status**: Accepted (owner, 2026-11-12).
- **Decision**: functions and variables declared with C linkage
  (`extern "C" { ... }` or `extern "C" void f();`) are exported from the
  bundle under their **unmangled** C name:
  - **Node.js** target: on `exports` (`module.exports`);
  - **browser** target: on the global object — `globalThis`, falling back to
    `window` (and `self` in workers) where `globalThis` is not available,
    since `globalThis` is not part of ES5.
- **Reason**: owner requirement; `extern "C"` is the natural C++ way to mark
  a stable, unmangled interface, so it maps cleanly to the JavaScript side.
  This complements D-011: the bundle still runs `main()`, and additionally
  exposes its C-linkage API.
- **Consequences**: `extern "C"` functions cannot be overloaded (as in C++);
  the semantic phase reports duplicate C-linkage names across translation
  units. Exported names must be valid JavaScript identifiers.
- **Mixed contexts (Electron)**: the destination is chosen with a CLI flag
  (D-015).

### D-015 — Execution platform chosen only by CLI flags

- **Status**: Accepted (owner, 2026-11-12).
- **Decision**: the execution context is fixed at compile time with a flag
  (working name `--platform browser|node|mixed`); the generated code does
  **not** detect the context at runtime. For `mixed` (Electron and similar),
  a further flag (working name `--exports exports|global|both`) chooses where
  `extern "C"` symbols are exported. Final flag names are fixed in the CLI
  design task.
- **Reason**: owner choice; smaller and more predictable bundles, since only
  the platform layer for the selected context is emitted.
- **Discarded**: runtime detection only; flag plus runtime `auto` mode.

### D-016 — Faithful C++ integer semantics

- **Status**: Accepted (owner, 2026-11-12).
- **Decision**: integer types keep C++ behaviour in the generated code:
  32-bit `int`/`unsigned` with wrap-around (`| 0`, `>>> 0`, `Math.imul`),
  division truncated toward zero, `char`/`short` truncated to their width,
  `long long` implemented by a 64-bit runtime helper (ES5 has no `BigInt`).
  `float`/`double` map to JavaScript numbers (`float` rounded with a
  `Math.fround` polyfill on ES5).
- **Reason**: programs must produce the same results as when compiled
  natively.
- **Discarded**: plain JavaScript numbers everywhere (faster and more
  readable, but different overflow and division results).

### D-017 — Full standard library, most-used headers first

- **Status**: Accepted (owner, 2026-11-12).
- **Decision**: the goal is to implement **all** standard library headers
  that are meaningful in JavaScript, in order of real-world usage. Planned
  order (to be refined): `<iostream>`, `<string>`, `<vector>`, `<cmath>`,
  `<cstdlib>`, `<cstdio>`, `<cstring>`, `<algorithm>`, `<map>`, `<set>`,
  `<unordered_map>`, `<unordered_set>`, `<sstream>`, `<utility>`, `<memory>`,
  `<functional>`, `<stdexcept>`, `<fstream>`, `<iomanip>`, `<list>`,
  `<deque>`, `<queue>`, `<stack>`, `<array>`, `<tuple>`, `<chrono>`,
  `<random>`, `<limits>`, `<climits>`, `<cctype>`, `<numeric>`, `<iterator>`,
  then the remaining headers.
- **Reason**: owner requirement; implementing by usage gives useful programs
  as early as possible.
- **Notes**: many headers depend on templates, so templates (D-010) are a
  prerequisite for containers and algorithms. Headers that cannot work in a
  given context (e.g. `<fstream>` in the browser) report a compile-time
  diagnostic for that platform.

### D-018 — Pointers and references as JavaScript references

- **Status**: Accepted (owner, 2026-11-12).
- **Decision**:
  - pointers and references to class objects become plain JavaScript object
    references; `nullptr` becomes `null`;
  - pointers and references to primitive values, and pointer arithmetic over
    arrays, use a small runtime helper (a *cell*: backing array + offset);
  - `new` creates the object, `delete` calls the destructor; memory itself is
    reclaimed by the JavaScript garbage collector. `new[]`/`delete[]` work on
    arrays the same way.
- **Reason**: keeps the output readable and fast while preserving the
  observable behaviour of well-formed programs.
- **Discarded**: simulated linear heap on `ArrayBuffer` (maximum fidelity,
  but unreadable output and `ArrayBuffer` is not guaranteed in ES5 engines).
- **Known limit**: casts between unrelated pointer types and
  `reinterpret_cast` on memory layout cannot be supported faithfully; they
  are reported as compile-time errors.

### D-019 — Separate standard library linked through a global object

- **Status**: Accepted (owner, 2026-11-12).
- **Decision**: when the standard library is emitted as a separate file, it
  always registers itself on the global object (working name `cpp2jsStd`) in
  every context (browser, Node.js, mixed), and the program reads it from
  there. The library file must therefore be loaded before the program
  (`<script>` order in the browser, `require` of the library first in
  Node.js). When the library is embedded (D-013), no global is created.
- **Reason**: owner choice; one linking mechanism for every platform.
- **Discarded**: platform-dependent linking (`require` on Node.js, global in
  the browser).

### D-020 — Minimum Node.js version for the CLI: 0.10

- **Status**: Accepted (owner, 2026-11-12).
- **Decision**: the transpiler CLI must run on Node.js **0.10 and later**.
  Only APIs available in Node 0.10 are used (`fs.*Sync`, `path`,
  `process.argv`, `process.exit`, `process.stdout.write`); no `fs.mkdirSync`
  with `recursive`, no `Buffer.from` (use `new Buffer` guarded by a helper).
- **Reason**: consistent with the ES5-only implementation (D-001).

### D-021 — Command-line interface

- **Status**: Accepted (owner, 2026-11-12). Fixes the names announced as
  "working names" in D-015 and D-019.
- **Synopsis**: `cpp2js [options] <file.cpp>...`

| Flag | Meaning | Default |
| ---- | ------- | ------- |
| `<file.cpp>...` | Translation units to compile and bundle | required |
| `-o`, `--output <file>` | Output bundle path | **standard output** |
| `--target <es5\|es6>` | JavaScript language level of the output | `es5` |
| `--platform <browser\|node\|mixed>` | Execution context (D-015) | **`browser`** |
| `--exports <exports\|global\|both>` | Where `extern "C"` symbols go (D-014) | `exports` on node, `global` on browser, `both` on mixed |
| `--minify` | Minified instead of pretty output | off |
| `--source-map [external\|inline]` | Emit a source map; bare flag means `external` | off |
| `--embed-std` | Embed the standard library in the bundle (D-013) | off |
| `--std-out <file>` | Path of the separate standard library file | ~~`<output>.std.js`~~ `stdlib.js` next to the bundle (D-028) |
| `-I <dir>` | Add an include search path (repeatable) | — |
| `-D <name>[=<value>]` | Define a macro (repeatable) | — |
| `-U <name>` | Undefine a macro (repeatable) | — |
| `--check` | Only syntax and type checking, no output | off |
| `-Werror` | Treat warnings as errors | off |
| `-w` | Suppress warnings | off |
| `--quiet` | Only errors are printed | off |
| `--verbose` | Print the phases and the files written | off |
| `-h`, `--help` | Show usage | — |
| `-v`, `--version` | Show version | — |

- **Rules**:
  - when the bundle goes to standard output (no `-o`), the files that need a
    path must get one explicitly: the separate standard library requires
    `--std-out` (or `--embed-std`), an `external` source map is not allowed
    (use `inline`). Otherwise the CLI stops with a usage error (exit code 2);
  - `--exports` is accepted on every platform; on `browser` the value
    `exports` is a usage error;
  - `-Werror` and `-w` together are a usage error; so are `--quiet` and
    `--verbose`;
  - diagnostics always go to standard error, never mixed with the bundle.
- **Reason**: owner choices for defaults (browser platform, stdout output,
  separate standard library) and for the extra flags (`--check`, `-Werror`,
  `-w`, `--quiet`, `--verbose`).
- **Discarded**: `-E` (preprocess only) for now; `a.js` as default output;
  `node` as default platform.

### D-028 — Command-line details: syntax, defaults, conflicts

- **Status**: Accepted (owner, 2026-11-19). Amends D-021 (default of
  `--std-out`, which is superseded) and completes it.
- **Decision**:
  - **standard library file name**: the default is **`stdlib.js` in the same
    directory as the bundle** (`-o dist/app.js` -> `dist/stdlib.js`), no
    longer `<output>.std.js`. If it would coincide with the bundle path, it
    is a usage error;
  - **standard output without a library destination**: D-021 is applied
    literally. Without `-o`, `--std-out` or `--embed-std` is always required
    (even if the program does not use the standard library); otherwise exit
    code 2. Not required with `--check`, which writes nothing;
  - **options without effect** (`--std-out` with `--embed-std`; `-o`,
    `--minify`, `--source-map`, `--embed-std`, `--std-out` with `--check`):
    a warning, and the compilation goes on. These usage warnings follow
    `-w`, `-Werror` (then exit 2) and `--quiet` like compiler warnings;
  - **repeated single-valued options**: the last value wins (as gcc/clang);
    `-I`, `-D`, `-U` and inputs accumulate; `-D`/`-U` keep their relative
    order and `-DNAME` means `NAME=1`;
  - **syntax**: `--opt value` and `--opt=value` for long options; attached
    values for `-o`, `-I`, `-D`, `-U` (`-Idir`); `--source-map` takes the
    next argument only if it is `external` or `inline`; `--` ends the
    options; a lone `-` (stdin) is rejected;
  - `--help` / `--version` win over every other option, unless an argument
    cannot be parsed; usage errors end with
    `Try 'cpp2js --help' for more information.`;
  - `bin/cpp2js.js` calls `process.exit()` only on failure, so that a bundle
    written to a pipe is never truncated (stdout may be asynchronous).
- **Reason**: owner choices for the file name, the stdout rule, conflicts
  and repeated options; the syntax matches what gcc/clang users expect.
- **Discarded**: `<output>.std.js` (owner preferred a fixed name shared by
  the programs of a directory); error only when the library is really used,
  or automatic embedding on stdout; usage errors for options without effect;
  errors for repeated options; separate-value syntax only.
- **Consequence to revisit**: two programs built into the same directory
  share `stdlib.js`, but each build writes only the parts its program uses
  (D-013); the second build overwrites the first. To be solved in Phase 9-10
  (see section 5).

### D-022 — In-house test runner

- **Status**: Accepted (agent, 2026-11-19; owner approved proceeding).
- **Decision**: `npm test` runs `test/run.js`, which loads every `*.test.js`
  under `test/` (except `test/fixtures/`) in sorted order. Test files
  register cases with `test(name, fn)` from `test/harness.js` and assert with
  Node's built-in `assert` module. Cases are synchronous; one `ok -` /
  `not ok -` line is printed per case, then a summary. Exit code 1 on any
  failure or on a file that cannot be loaded. An optional argument filters
  cases by the label `file > name`.
- **Reason**: rule 2 of AGENTS.md forbids external frameworks; a flat
  `test()` API is enough for a compiler whose phases are synchronous, and
  runs unchanged on Node 0.10 (D-020).
- **Discarded**: `describe`/`it` nesting (more code, no current need);
  asynchronous cases (none of the phases is asynchronous; can be added
  later if the CLI tests need it).

### D-023 — Diagnostic model and text format

- **Status**: Accepted (agent, 2026-11-19).
- **Decision**:
  - `src/source/source-file.js`: `SourceFile(path, text)` maps 0-based
    offsets (UTF-16 units) to 1-based line/column and back; `\n`, `\r\n`
    and lone `\r` all end a line;
  - `src/diagnostics/diagnostic.js`: `Diagnostic(severity, message, span)`
    with severities `error`, `warning`, `note`; a span is
    `{source, start, end}` (end exclusive), a whole file (no `start`) or
    absent; notes are attached with `addNote()`;
  - `src/diagnostics/diagnostic-bag.js`: `DiagnosticBag` collects and counts
    diagnostics and applies `-w` (drop warnings) and `-Werror` (promote
    warnings to errors, shown with a ` [-Werror]` suffix);
  - `src/diagnostics/format.js`: clang-like text. First line
    `file:line:col: severity: message` (`file: …` without a position,
    `cpp2js: …` without a file), then the source line and a marker line
    with `^` at the start and `~` up to the end of the range, clipped to the
    first line. Tabs before the column are copied into the marker line so
    the caret stays aligned. Summary: `N warnings and M errors generated.`
- **Reason**: the familiar compiler format (section 3.4) is understood by
  editors and users; copying tabs avoids guessing a tab width.
- **Discarded**: gcc's `12 | ` gutter (noisier, no benefit at this stage);
  colored output (may be added later behind a flag, after deciding on TTY
  detection).

### D-024 — Automatic ES5 check of the project's sources

- **Status**: Accepted (agent, 2026-11-19; proposed to the owner before the
  task).
- **Decision**: `test/es5.test.js` scans every `.js` file under `bin/`,
  `src/` and `test/` (fixtures excluded) with the heuristic scanner in
  `test/tools/es5-check.js` and fails on ES2015+ constructs: `let`, `const`,
  `class`, `import`/`export`, arrow functions, template literals, spread,
  `**`, ES2015+ globals (`Map`, `Set`, `Promise`, `Symbol`, `globalThis`, …),
  ES2015+ statics (`Object.assign`, `Math.imul`, `Buffer.from`, …) and common
  ES2015+ string/array methods (`.startsWith()`, `.includes()`, …).
- **Reason**: development happens on recent Node versions that accept
  ES2015+ silently; without the check, violations of rule 1 would only
  appear on old engines.
- **Limits**: it is a scanner, not a parser: shorthand methods, computed
  keys and destructuring are not detected, and method names common in
  user-defined APIs (`find`, `fill`, `keys`) are not checked.
- **Discarded**: running the suite on Node 0.10 only (not available locally;
  left to CI); a full ES5 parser (too much code for a test helper).

### D-025 — JavaScript binding headers: ES5 DOM, ES6 DOM, Node.js

- **Status**: Accepted (owner, 2026-11-19). Design details still open
  (section 5).
- **Decision**: besides the C++ standard library, the project provides
  headers that let C++ code use the JavaScript host APIs directly:
  - a header for the **DOM as available in ES5** browsers;
  - a header for the **DOM as available in ES6** browsers (ES2015+ APIs);
  - a header for the **Node.js** API.
  They declare C++ types and functions that the transpiler maps onto the
  corresponding JavaScript objects, instead of implementing them.
- **Reason**: owner requirement; a program running in a browser or in
  Node.js must be able to reach its host environment, not only the C++
  standard library.
- **Relations**: ties to `--target` (D-021: ES6 DOM requires `es6`) and to
  `--platform` (D-015: DOM on `browser`/`mixed`, Node.js on `node`/`mixed`);
  misuse should be a compile-time diagnostic, as for `<fstream>` (D-017).

### D-026 — `__js__`: inline JavaScript, like `__asm__`

- **Status**: Accepted (owner, 2026-11-19). Syntax still open (section 5).
- **Decision**: the language gains a `__js__` construct, the counterpart of
  `__asm__`/`asm` in C++ compilers: it embeds JavaScript code verbatim in the
  generated output, at the point where it appears in the C++ source.
- **Reason**: owner requirement; as inline assembly gives access to the
  machine, `__js__` gives access to the JavaScript platform for anything the
  transpiler or the binding headers (D-025) do not cover.
- **Notes**: identifiers starting with `__` are reserved to the
  implementation in C++, so `__js__` cannot clash with user names. The
  minifier (D-004, phase 8) must not break code inside `__js__`, which is a
  strong reason to pass C++ values in and out through explicit operands
  rather than by name.

### D-027 — Every question to the owner goes through an interactive poll

- **Status**: Accepted (owner, 2026-11-19).
- **Decision**: agents ask **every** question or doubt addressed to the owner
  through the interactive multiple-choice tool (poll) of the tooling, never as
  plain text in the chat. This covers design choices, ambiguities,
  confirmations ("shall I proceed?") and the choice of the next task. Each
  poll states the context briefly, offers concrete options with their
  trade-offs and marks the recommended one; the owner can always answer
  with free text.
- **Reason**: owner requirement; it makes decisions quick to take and easy to
  trace. It strengthens step 3 of the AGENTS.md workflow ("whenever the
  tooling allows it") into a rule for any question.
- **Fallback**: only if the tooling has no interactive tool, the question is
  asked in text with numbered options.

---

## 2. Source tree structure (planned)

This is the planned layout; it will be updated as the code is written.
Directories that are still empty contain a `.gitkeep` file, to be removed as
soon as the directory gets its first real file.

```
cpp2js/
├── bin/
│   └── cpp2js.js            # CLI entry point (shebang, argument parsing)
├── src/
│   ├── index.js             # Programmatic API: compile(options)
│   ├── cli/                 # parse-args, validate-options, help, main (D-028)
│   ├── diagnostics/         # Error/warning objects, formatting, source excerpts (D-023)
│   ├── source/              # Source files, positions, line/column mapping (D-023)
│   ├── preprocessor/        # #include, #define, macros, #if/#ifdef, include paths
│   ├── lexer/               # Tokenizer for preprocessed C++
│   ├── parser/              # Recursive-descent parser -> AST
│   ├── ast/                 # AST node definitions and visitors
│   ├── semantic/            # Scopes, symbols, name lookup, type checker, access control
│   ├── lowering/            # C++ AST -> JS-oriented intermediate representation
│   ├── codegen/             # IR -> JavaScript AST for ES5 / ES6
│   ├── printer/             # Pretty printer and minifier
│   ├── sourcemap/           # Source Map v3 builder, VLQ encoder
│   ├── bundler/             # Combines translation units into one bundle
│   ├── runtime/             # Small JS helpers embedded in the bundle when needed
│   └── stdlib/              # C++ standard library in JS, split per header (D-013)
│       └── platform/        # Context layer: browser, node, mixed (Electron)
├── test/                    # Unit tests (no external test framework)
│   ├── run.js               # Test runner (D-022)
│   ├── harness.js           # test(name, fn) registry
│   ├── tools/               # Test helpers (es5-check.js, D-024)
│   └── fixtures/            # C++ inputs and expected JS outputs
├── examples/                # Sample C++ programs
├── .editorconfig            # Mirrors the conventions of section 3.1
├── .gitignore
├── package.json             # No dependencies; "bin", "engines": node >=0.10
├── AGENTS.md
├── MEMORY.md
├── ROADMAP.md
├── README.md
└── LICENSE
```

### Compilation pipeline

```
C++ sources
  -> preprocessor   (includes, macros, conditionals; keeps origin locations)
  -> lexer          (tokens with source positions)
  -> parser         (AST)
  -> semantic       (symbols, types, overloads, access control, diagnostics)
  -> lowering       (JS-oriented IR: classes, members, mangled names)
  -> codegen        (ES5 or ES6 JavaScript AST)
  -> printer        (pretty or minified text + source map segments)
  -> bundler        (single output file + optional .map)
```

---

## 3. Conventions

### 3.1 Transpiler source code (ES5)

- `'use strict';` at the top of every file.
- CommonJS modules: `var x = require('./x');`, `module.exports = ...`.
- Indentation: **2 spaces**, no tabs. Line length: **100 columns** max.
- Strings: **single quotes**. Semicolons: always.
- Naming:
  - `camelCase` for variables, functions and methods;
  - `PascalCase` for constructor functions;
  - `UPPER_SNAKE_CASE` for constants;
  - a leading underscore (`_name`) for internal members not part of a
    module's API;
  - file names in `kebab-case.js`.
- Classes are constructor functions with methods on the prototype;
  inheritance via `Object.create` + resetting `constructor`.
- Every exported function and constructor has a **JSDoc** comment
  (`@param`, `@returns`, `@throws` where relevant). Inline comments explain
  *why*, not *what*.
- Always use `===` / `!==`. No implicit globals. No `eval` or `with`.
- Errors in the user's C++ code are reported as diagnostics, never as raw
  JavaScript exceptions.

### 3.2 Generated JavaScript

- Pretty mode: 2-space indentation, single quotes, semicolons, one statement
  per line, a short header comment naming the generator and its version.
- Identifiers keep the C++ names when possible; names that collide with
  JavaScript reserved words or with other symbols are mangled
  deterministically.
- Minified mode: whitespace removal and safe local renaming; public API names
  are never renamed.

### 3.3 Commits

- English, imperative mood, first line under 72 characters
  (e.g. `Add tokenizer for C++ literals`).
- One logical change per commit, always on `main`.

### 3.4 CLI output style

- Diagnostics follow the familiar compiler format:
  `file.cpp:12:5: error: message`, followed by the source line and a caret.
- Exit code `0` on success, `1` on compilation errors, `2` on invalid usage.

---

## 4. Notes and research

### Techniques considered for hiding private/protected members (D-007)

1. **Closure-scoped storage** keyed by instance: real privacy, needs a hidden
   instance key in ES5.
2. **`WeakMap`** (ES6 only): real privacy, no leaks.
3. **Obfuscated, non-enumerable properties**: chosen (D-012).
4. **Hybrid** of 2 and 1/3.

Protected members must stay accessible from derived classes in the same
bundle; `friend` declarations must be honoured. Both are resolved at compile
time and simply use the obfuscated names.

---

## 5. Open questions (to discuss with the owner)

To be asked through interactive polls (D-027).

- **`__js__` syntax (D-026)**: statement only, or also expression? Plain
  string (`__js__("...")`), raw block, or GCC-style operands
  (`__js__("..." : outputs : inputs)`) to bind C++ variables? Is the
  JavaScript checked (parsed, validated against `--target`) or copied
  blindly?
- **Binding headers (D-025)**: header names and layout (e.g. `<js/dom5>`,
  `<js/dom6>`, `<js/node>`); does the ES6 DOM header extend the ES5 one;
  how JavaScript objects, callbacks and strings are typed on the C++ side;
  what happens when a header is used with an incompatible target/platform
  (error or warning).
- **Shared `stdlib.js` (D-028)**: programs built into the same directory
  share the default `stdlib.js`, but each build only writes what its own
  program uses. Options: merge with the existing file, always emit the
  parts needed by all builds of a directory, or warn on overwrite.
