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
- **Open points**: which headers are supported first; whether the platform is
  chosen by a flag, detected at runtime, or both; how the separate library
  file is linked to the program (global object, `require`, script order).

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
- **Open point**: behaviour in mixed contexts (Electron) — export to
  `exports`, to the global object, or both.

---

## 2. Source tree structure (planned)

This is the planned layout; it will be updated as the code is written.

```
cpp2js/
├── bin/
│   └── cpp2js.js            # CLI entry point (shebang, argument parsing)
├── src/
│   ├── index.js             # Programmatic API: compile(options)
│   ├── cli/                 # Flag parsing, help text, exit codes
│   ├── diagnostics/         # Error/warning objects, formatting, source excerpts
│   ├── source/              # Source files, positions, line/column mapping
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
│   └── fixtures/            # C++ inputs and expected JS outputs
├── examples/                # Sample C++ programs
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

- Semantics of numeric types (32-bit integer wrap-around via `| 0`, 64-bit
  integers, `char`), pointers and references, manual memory management.
- Standard library: first headers to support; platform selection (flag,
  runtime detection, or both); how the separate library file is linked.
- Full list and names of CLI flags.
- Minimum Node.js version supported by the CLI.
