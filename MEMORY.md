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
- **Open point**: the default target (ES5 or ES6) is still to be decided
  with the owner (see section 5).

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

- **Status**: Accepted (project brief) — **implementation strategy open**.
- **Decision**: private and protected members must not be directly
  reachable from code outside the bundle; only public members are exposed
  directly.
- **Reason**: required by the brief; preserves the C++ encapsulation
  guarantees at runtime.
- **Open point**: the concrete technique is to be decided with the owner
  (see section 5). Candidate techniques are listed in section 4.

### D-008 — Language and style of the repository

- **Status**: Accepted (project brief).
- **Decision**: everything in the repository is written in English; chat
  with the owner is in Italian. Code follows standard JavaScript conventions
  (section 3).

### D-009 — Single branch, GPL-3.0

- **Status**: Accepted (project brief).
- **Decision**: all work on `main`; the project is licensed GPL-3.0 (full
  text in `LICENSE`).

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
│   └── runtime/             # Small JS helpers embedded in the bundle when needed
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

### Candidate techniques for hiding private/protected members (D-007)

1. **Closure-scoped storage**: private state stored in a per-class closure
   keyed by instance; truly unreachable from outside. In ES5 this needs an
   instance-to-storage association without `WeakMap` (e.g. a hidden key).
2. **`WeakMap` (ES6 target)**: real privacy, no memory leaks; not available
   in ES5.
3. **Mangled, non-enumerable properties**: members renamed to opaque,
   per-build random names and defined with `Object.defineProperty`
   (`enumerable: false`). Simple and fast, but only obfuscation: a determined
   caller can still find them via `Object.getOwnPropertyNames`.
4. **Hybrid**: technique 2 for ES6, technique 1 or 3 for ES5.

Protected members additionally need to be accessible from derived classes
compiled in the same bundle; `friend` declarations must also be honoured.

---

## 5. Open questions (to discuss with the owner)

- Default output target: ES5 or ES6?
- Supported C++ subset and reference standard (C++98/03, C++11, …):
  templates, operator overloading, multiple inheritance, exceptions,
  namespaces, lambdas.
- Standard library: is "pure C++" without the STL, or should a subset
  (`<iostream>`, `<string>`, `<vector>`) be provided by a runtime?
- Semantics of numeric types (32-bit integer wrap-around via `| 0`, 64-bit
  integers, `char`), pointers and references, manual memory management.
- Program entry point: does the bundle call `main()` automatically, or does
  it export the public API as a library (CommonJS, global, both)?
- Technique for protecting private/protected members (section 4).
- Minimum Node.js version supported by the CLI.
