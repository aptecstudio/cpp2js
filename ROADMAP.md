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
| 1   | Scope definition                        | Not started  | 0 / 7    |
| 2   | Infrastructure (CLI, diagnostics, tests)| Not started  | 0 / 8    |
| 3   | Preprocessor                            | Not started  | 0 / 9    |
| 4   | Lexer                                   | Not started  | 0 / 6    |
| 5   | Parser and AST                          | Not started  | 0 / 10   |
| 6   | Semantic analysis                       | Not started  | 0 / 10   |
| 7   | Lowering and code generation            | Not started  | 0 / 10   |
| 8   | Printer, minifier, source maps          | Not started  | 0 / 7    |
| 9   | Bundler                                 | Not started  | 0 / 5    |
| 10  | Runtime support                         | Not started  | 0 / 5    |
| 11  | Quality, documentation, release         | Not started  | 0 / 7    |

**Overall: 5 / 92 items done.**

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

- [ ] Reference C++ standard and supported language subset.
- [ ] Standard library policy (none, or a runtime subset).
- [ ] Numeric, pointer and reference semantics in JavaScript.
- [ ] Technique for hiding private/protected members (per target).
- [ ] Default output target (ES5 or ES6) and full list of CLI flags.
- [ ] Bundle shape: executable program (`main`) vs library exports.
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
- [ ] Enumerations.
- [ ] Templates (if in scope).
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
- [ ] Semantic diagnostics.

## Phase 7 — Lowering and code generation

- [ ] Intermediate representation oriented to JavaScript.
- [ ] Deterministic name mangling (overloads, namespaces, reserved words).
- [ ] Free functions and global variables.
- [ ] Classes -> ES5 constructor functions / ES6 classes.
- [ ] Inheritance and virtual dispatch.
- [ ] Private/protected member protection (technique from Phase 1).
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
- [ ] Module wrapper of the bundle (IIFE; export format from Phase 1).
- [ ] Entry point handling (`main` or exported API).
- [ ] Embed only the runtime helpers actually used.

## Phase 10 — Runtime support

- [ ] Integer arithmetic helpers.
- [ ] Memory model helpers (pointers / references, if in scope).
- [ ] Private member storage helpers.
- [ ] Standard library subset (if in scope).
- [ ] Runtime tests on both ES5 and ES6 targets.

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
