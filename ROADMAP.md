# ROADMAP.md

Progress tracker of the `cpp2js` project: what has been done and what is
still to do, both globally and phase by phase.

> Update this file at the end of every task: tick completed items, add newly
> discovered work, and keep the status table in sync. See `AGENTS.md`.

Legend: `[x]` done · `[~]` in progress · `[ ]` to do

---

## Overall status

| #   | Phase                                   | Status       | Progress |
| --- | --------------------------------------- | ------------ | -------- |
| 0   | Project setup                           | In progress  | 5 / 8    |
| 1   | Scope definition                        | In progress  | 9 / 12   |
| 2   | Infrastructure (CLI, diagnostics, tests)| Not started  | 0 / 8    |
| 3   | Preprocessor                            | Not started  | 0 / 9    |
| 4   | Lexer                                   | Not started  | 0 / 6    |
| 5   | Parser and AST                          | Not started  | 0 / 11   |
| 6   | Semantic analysis                       | Not started  | 0 / 12   |
| 7   | Lowering and code generation            | Not started  | 0 / 11   |
| 8   | Printer, minifier, source maps          | Not started  | 0 / 7    |
| 9   | Bundler                                 | Not started  | 0 / 6    |
| 10  | Runtime and standard library            | Not started  | 0 / 9    |
| 11  | Quality, documentation, release         | Not started  | 0 / 7    |

**Overall: 14 / 106 items done.**

---

## Phase 0 — Project setup

- [x] Create the repository `cpp2js` with `main` as the only branch.
- [x] Write `AGENTS.md` (rules for agents and humans).
- [x] Write `MEMORY.md` (decisions, structure, conventions).
- [x] Write `ROADMAP.md` (this file).
- [x] Write `README.md` and add the GPL-3.0 `LICENSE`.
- [ ] Add `package.json` (no dependencies; `bin` entry, `engines` field).
- [ ] Add `.gitignore` and `.editorconfig`.
- [ ] Create the empty source tree described in `MEMORY.md`.

## Phase 1 — Scope definition

Decisions to take with the owner before writing the compiler core.

- [x] Reference C++ standard and supported language subset — basic C++11 (D-010).
- [x] Standard library policy — separate, tree-shaken, platform-aware bundle (D-013).
- [x] Standard library header order — all headers, most used first (D-017).
- [x] Platform selection — CLI flags only (D-015).
- [x] `extern "C"` exports in mixed contexts — chosen by a CLI flag (D-014, D-015).
- [ ] Linking of the separate standard library file to the program.
- [x] Integer and floating-point semantics — faithful to C++ (D-016).
- [ ] Pointer, reference and memory management semantics.
- [x] Technique for hiding private/protected members — obfuscated names (D-012).
- [x] Default output target — ES5 (D-011).
- [ ] Full list and names of CLI flags.
- [x] Bundle shape — executable program calling `main()` (D-011).
- [ ] Minimum supported Node.js version.

## Phase 2 — Infrastructure

- [ ] CLI entry point `bin/cpp2js.js` with argument parser (no libraries).
- [ ] `--help` and `--version`.
- [ ] Programmatic API `compile(options)` in `src/index.js`.
- [ ] Source file abstraction with line/column mapping.
- [ ] Diagnostics: errors, warnings, notes; compiler-style formatting.
- [ ] Minimal in-house test runner (`npm test`), no external framework.
- [ ] Fixture-based tests (C++ input -> expected JS output).
- [ ] Continuous integration workflow running the test suite.

## Phase 3 — Preprocessor

- [ ] `#include "..."` and `#include <...>` with include search paths (`-I`).
- [ ] Include guards and `#pragma once`.
- [ ] Object-like macros (`#define`, `#undef`).
- [ ] Function-like macros, `#` stringizing, `##` token pasting, variadics.
- [ ] Conditionals: `#if`, `#ifdef`, `#ifndef`, `#elif`, `#else`, `#endif`.
- [ ] Constant expression evaluation and `defined()`.
- [ ] `#error`, `#warning`, `#line`; predefined macros (`__FILE__`, `__LINE__`, …).
- [ ] Command-line defines (`-D`, `-U`).
- [ ] Origin tracking of every token for diagnostics and source maps.

## Phase 4 — Lexer

- [ ] Identifiers and keywords.
- [ ] Integer, floating-point, character and string literals (with escapes).
- [ ] Operators and punctuators (including `::`, `->*`, `<<=` …).
- [ ] Comments and whitespace handling.
- [ ] Token positions mapped back to original files.
- [ ] Lexical error diagnostics.

## Phase 5 — Parser and AST

- [ ] AST node definitions and visitor utilities.
- [ ] Declarations: variables, functions, typedefs, `using`.
- [ ] Namespaces.
- [ ] Classes and structs: members, access specifiers, constructors, destructors.
- [ ] Inheritance (single; multiple if in scope).
- [ ] Statements: blocks, `if`, `switch`, loops, `break`/`continue`, `return`.
- [ ] Expressions with full C++ precedence and associativity.
- [ ] Enumerations (including `enum class`).
- [ ] C++11 syntax: `auto`, `nullptr`, range-based `for`, lambdas.
- [ ] Templates (after the core works, D-010).
- [ ] Syntax error recovery and diagnostics.

## Phase 6 — Semantic analysis

- [ ] Scopes and symbol tables.
- [ ] Name lookup (qualified, unqualified, member lookup).
- [ ] Type representation (fundamental, class, pointer, reference, array, const).
- [ ] Type checking of expressions and implicit conversions.
- [ ] Function overload resolution.
- [ ] Constructors, destructors and object lifetime rules.
- [ ] Access control: `public` / `protected` / `private`.
- [ ] `friend` functions and classes.
- [ ] Virtual functions and overriding.
- [ ] `auto` type deduction and lambda captures.
- [ ] `extern "C"` linkage: no overloading, duplicate-name checks (D-014).
- [ ] Semantic diagnostics.

## Phase 7 — Lowering and code generation

- [ ] Intermediate representation oriented to JavaScript.
- [ ] Deterministic name mangling (overloads, namespaces, reserved words).
- [ ] Free functions and global variables.
- [ ] Classes -> ES5 constructor functions / ES6 classes.
- [ ] Inheritance and virtual dispatch.
- [ ] Private/protected members as obfuscated non-enumerable properties (D-012).
- [ ] Lambdas -> JavaScript closures (by-value / by-reference captures).
- [ ] Numeric semantics (integer arithmetic, division, overflow).
- [ ] Control flow (including `switch` fall-through and `goto` if in scope).
- [ ] ES5 emitter.
- [ ] ES6 emitter.

## Phase 8 — Printer, minifier, source maps

- [ ] Pretty printer (default output).
- [ ] Minifier: whitespace removal.
- [ ] Minifier: safe renaming of local identifiers.
- [ ] Source Map v3 generation (VLQ encoding).
- [ ] External `.map` file output.
- [ ] Inline source map output.
- [ ] Source maps tested against known mappings.

## Phase 9 — Bundler

- [ ] Combine multiple translation units into one output file.
- [ ] Link symbols across translation units (one definition rule checks).
- [ ] Module wrapper of the bundle (IIFE).
- [ ] Entry point: call `main()` and propagate its return code (D-011).
- [ ] Export `extern "C"` symbols: `exports` on Node.js, global object in the browser (D-014).
- [ ] Embed only the runtime helpers actually used.

## Phase 10 — Runtime and standard library

- [ ] Integer arithmetic helpers.
- [ ] Memory model helpers (pointers / references).
- [ ] Per-build generator of obfuscated member names (D-012).
- [ ] Platform layer: browser, Node.js, mixed contexts such as Electron (D-013).
- [ ] Standard library headers in JavaScript, most used first (D-017).
- [ ] Usage analysis and dead-code elimination of the standard library.
- [ ] Separate standard library bundle output.
- [ ] Flag to embed the standard library bundle in the main output.
- [ ] Runtime and standard library tests on ES5 and ES6, per platform.

## Phase 11 — Quality, documentation, release

- [ ] End-to-end tests over the `examples/` programs.
- [ ] Usage guide for every CLI flag in `README.md`.
- [ ] Documentation of the supported C++ subset and its limits.
- [ ] Contribution guide (`CONTRIBUTING.md`).
- [ ] Changelog (`CHANGELOG.md`).
- [ ] First tagged release `v0.1.0`.
- [ ] Publish on npm (optional).

---

## Change log of this roadmap

- **2026-11-12** — Roadmap created; Phase 0 started (documentation and license).
- **2026-11-12** — Phase 1: decisions D-010 to D-013 taken; Phases 5, 6, 7 and 10
  extended accordingly (C++11 features, standard library).
- **2026-11-12** — Decision D-014 (`extern "C"` exports); Phases 6 and 9 extended.
- **2026-11-12** — Decisions D-015 (platform flags), D-016 (integer semantics),
  D-017 (standard library order).
