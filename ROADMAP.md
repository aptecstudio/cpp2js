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
| 0   | Project setup                           | Done         | 8 / 8    |
| 1   | Scope definition                        | Done         | 16 / 16  |
| 2   | Infrastructure (CLI, diagnostics, tests)| In progress  | 7 / 8    |
| 3   | Preprocessor                            | Done         | 9 / 9    |
| 4   | Lexer                                   | Done         | 7 / 7    |
| 5   | Parser and AST                          | In progress  | 7 / 13   |
| 6   | Semantic analysis                       | In progress  | 3 / 14   |
| 7   | Lowering and code generation            | Not started  | 0 / 13   |
| 8   | Printer, minifier, source maps          | Not started  | 0 / 9    |
| 9   | Bundler                                 | Not started  | 0 / 6    |
| 10  | Runtime, standard library, JS bindings  | Not started  | 0 / 14   |
| 11  | Quality, documentation, release         | Not started  | 0 / 7    |

**Overall: 57 / 124 items done.**

---

## Phase 0 — Project setup

- [x] Create the repository `cpp2js` with `main` as the only branch.
- [x] Write `AGENTS.md` (rules for agents and humans).
- [x] Write `MEMORY.md` (decisions, structure, conventions).
- [x] Write `ROADMAP.md` (this file).
- [x] Write `README.md` and add the GPL-3.0 `LICENSE`.
- [x] Add `package.json` (no dependencies; `bin` entry, `engines` field).
- [x] Add `.gitignore` and `.editorconfig`.
- [x] Create the empty source tree described in `MEMORY.md`.

## Phase 1 — Scope definition

Decisions to take with the owner before writing the compiler core.

- [x] Reference C++ standard and supported language subset — basic C++11 (D-010).
- [x] Standard library policy — separate, tree-shaken, platform-aware bundle (D-013).
- [x] Standard library header order — all headers, most used first (D-017).
- [x] Platform selection — CLI flags only (D-015).
- [x] `extern "C"` exports in mixed contexts — chosen by a CLI flag (D-014, D-015).
- [x] Linking of the separate standard library file — global object (D-019).
- [x] Integer and floating-point semantics — faithful to C++ (D-016).
- [x] Pointer, reference and memory management semantics (D-018).
- [x] Technique for hiding private/protected members — obfuscated names (D-012).
- [x] Default output target — ES5 (D-011).
- [x] Full list and names of CLI flags (D-021).
- [x] Bundle shape — executable program calling `main()` (D-011).
- [x] Minimum supported Node.js version — 0.10 (D-020).
- [x] Design of the `__js__` inline JavaScript construct: syntax, operands, checks (D-026).
- [x] Design of the JavaScript binding headers: names, target/platform rules (D-025).
- [x] Third-party CommonJS modules and global objects: `extern "JS"` (D-031).

## Phase 2 — Infrastructure

- [x] CLI entry point `bin/cpp2js.js` with argument parser (no libraries) (D-028).
- [x] `--help` and `--version`; usage errors and checks of D-021 (exit code 2).
- [~] Programmatic API `compile(options)` in `src/index.js` (loads and preprocesses inputs,
  CLI writes its outputs; later phases and `--verbose` still to do).
- [x] Source file abstraction with line/column mapping (`src/source/source-file.js`).
- [x] Diagnostics: errors, warnings, notes; compiler-style formatting (D-023).
- [x] Minimal in-house test runner (`npm test`), no external framework (D-022).
- [x] Automatic ES5 check of the project's own sources, run by `npm test` (D-024).
- [x] Fixture-based tests (C++ input -> expected JS output) (D-029).
- ~~Continuous integration workflow running the test suite.~~ Dropped: no tests on GitHub
  (D-030).

## Phase 3 — Preprocessor

- [x] `#include "..."` and `#include <...>` with include search paths (`-I`).
- [x] Include guards and `#pragma once`.
- [x] Object-like macros (`#define`, `#undef`).
- [x] Function-like macros, `#` stringizing, `##` token pasting, variadics.
- [x] Conditionals: `#if`, `#ifdef`, `#ifndef`, `#elif`, `#else`, `#endif`.
- [x] Constant expression evaluation and `defined()`.
- [x] `#error`, `#warning`, `#line`; predefined macros (`__FILE__`, `__LINE__`, …).
- [x] Command-line defines (`-D`, `-U`).
- [x] Origin tracking of every token for diagnostics and source maps.

## Phase 4 — Lexer

- [x] Identifiers and keywords.
- [x] Integer, floating-point, character and string literals (with escapes) (D-034).
- [x] Operators and punctuators (including `::`, `->*`, `<<=` …, digraphs, `and`/`or`).
- [x] Comments and whitespace handling (done by the pp-lexer, D-033).
- [x] Token positions mapped back to original files (pp-lexer and expansion chain, D-033).
- [x] Lexical error diagnostics.
- [x] `__js__` keyword and its raw JavaScript payload (D-026): a keyword followed by
  ordinary (possibly raw, concatenated) string literals.

## Phase 5 — Parser and AST

Developed together with Phase 6: the parser queries semantic analysis while parsing
(D-035).

- [x] AST node definitions and visitor utilities (D-040).
- [x] Declarations: variables, functions, typedefs, `using` aliases (D-042); using-declarations
  and directives come with namespaces.
- [x] Namespaces, using-declarations/directives, aliases, linkage specifications,
  attributes (D-043).
- [~] Classes and structs: members, access specifiers (D-050); constructors, destructors (5c).
- [ ] Inheritance (single; multiple if in scope).
- [x] Statements: blocks, `if`, `switch`, loops, `break`/`continue`, `return`, `goto` (D-048).
- [x] Expressions with full C++ precedence and associativity (D-047).
- [x] Enumerations (including `enum class`) (D-049).
- [ ] C++11 syntax: `auto`, `nullptr`, range-based `for`, lambdas.
- [ ] Templates (after the core works, D-010).
- [ ] Syntax error recovery and diagnostics.
- [ ] `__js__` statements/expressions in the AST (D-026).
- [x] `extern "JS"` blocks and `[[js::module("...")]]` attributes on namespaces (D-031).

## Phase 6 — Semantic analysis

- [x] Scopes and symbol tables (D-041).
- [x] Name lookup (qualified, unqualified, member lookup) (D-041).
- [x] Type representation (fundamental, class, pointer, reference, array, const) (D-039).
- [~] Type checking of expressions and implicit conversions (D-047; class types pending).
- [~] Function overload resolution (D-047; user-defined conversions pending).
- [ ] Constructors, destructors and object lifetime rules.
- [~] Access control: `public` / `protected` / `private` (D-050; inheritance and friends
  pending).
- [ ] `friend` functions and classes.
- [ ] Virtual functions and overriding.
- [ ] `auto` type deduction and lambda captures.
- [ ] `extern "C"` linkage: no overloading, duplicate-name checks (D-014).
- [ ] Semantic diagnostics.
- [ ] `__js__`: checks of operands (lvalue outputs, types of `__js__<T>`) (D-026).
- [ ] `extern "JS"`: declarations only; module imports rejected on browser (D-031).

## Phase 7 — Lowering and code generation

- [ ] Intermediate representation oriented to JavaScript.
- [ ] Deterministic name mangling (overloads, namespaces, reserved words).
- [ ] Free functions and global variables.
- [ ] Classes -> ES5 constructor functions / ES6 classes.
- [ ] Inheritance and virtual dispatch.
- [ ] Private/protected members as obfuscated non-enumerable properties (D-012).
- [ ] Lambdas -> JavaScript closures (by-value / by-reference captures).
- [ ] Numeric semantics (integer arithmetic, division, overflow).
- [ ] Control flow (including `switch` fall-through and `goto`, hybrid technique of D-048).
- [ ] ES5 emitter.
- [ ] ES6 emitter.
- [ ] Emission of `__js__` as an isolated function with its operands bound (D-026).
- [ ] Emission of `extern "JS"` access: `require()` of modules, global objects (D-031).

## Phase 8 — Printer, minifier, source maps

- [ ] Pretty printer (default output).
- [ ] Minifier: whitespace removal.
- [ ] Minifier: safe renaming of local identifiers.
- [ ] Source Map v3 generation (VLQ encoding).
- [ ] External `.map` file output.
- [ ] Inline source map output.
- [ ] Source maps tested against known mappings.
- [ ] Minifier keeps `__js__` code and the names it refers to working (D-026).
- [ ] Optional syntax check of `__js__` code with an in-house JS parser (later, D-026).

## Phase 9 — Bundler

- [ ] Combine multiple translation units into one output file.
- [ ] Link symbols across translation units (one definition rule checks).
- [ ] Module wrapper of the bundle (IIFE).
- [ ] Entry point: call `main()` and propagate its return code (D-011).
- [ ] Export `extern "C"` symbols: `exports` on Node.js, global object in the browser (D-014).
- [ ] Embed only the runtime helpers actually used.

## Phase 10 — Runtime, standard library and JavaScript bindings

- [ ] Integer arithmetic helpers.
- [ ] Memory model helpers (pointers / references).
- [ ] Per-build generator of obfuscated member names (D-012).
- [ ] Platform layer: browser, Node.js, mixed contexts such as Electron (D-013).
- [ ] Standard library headers in JavaScript, most used first (D-017).
- [ ] Usage analysis and dead-code elimination of the standard library.
- [ ] Separate standard library bundle output.
- [ ] Flag to embed the standard library bundle in the main output.
- [ ] Runtime and standard library tests on ES5 and ES6, per platform.
- [ ] Base types header `<js>`: `js::value`, `js::object`, `js::array<T>`, `js::function` (D-025).
- [ ] Binding header `<es5>`: DOM of ES5 browsers, namespace `dom::` (D-025).
- [ ] Binding header `<es6>`: includes `<es5>`, adds ES2015+ APIs (D-025).
- [ ] Node.js binding headers `<node/fs>`, `<node/child_process>`, ... (`node::`) (D-025).
- [ ] Diagnostics for binding headers used with an incompatible target or platform (D-025).

## Phase 11 — Quality, documentation, release

- [ ] End-to-end tests over the `examples/` programs.
- [ ] Usage guide for every CLI flag in `README.md`.
- [ ] Documentation of the supported C++ subset and its limits.
- [ ] Contribution guide (`CONTRIBUTING.md`).
- [ ] Changelog (`CHANGELOG.md`).
- [ ] First tagged release `v0.1.0`.
- [ ] Publish on npm, only when the project is finished (D-045). The package is already
  installable from a clone with `npm install -g .`.

---

## Change log of this roadmap

- **2026-11-12** — Roadmap created; Phase 0 started (documentation and license).
- **2026-11-12** — Phase 1: decisions D-010 to D-013 taken; Phases 5, 6, 7 and 10
  extended accordingly (C++11 features, standard library).
- **2026-11-12** — Decision D-014 (`extern "C"` exports); Phases 6 and 9 extended.
- **2026-11-12** — Decisions D-015 (platform flags), D-016 (integer semantics),
  D-017 (standard library order).
- **2026-11-12** — Decisions D-018 (pointers), D-019 (standard library linking),
  D-020 (Node.js 0.10+).
- **2026-11-12** — Phase 0 completed (`package.json`, `.gitignore`, `.editorconfig`,
  source tree). Next: CLI flag design (Phase 1), then Phase 2.
- **2026-11-12** — Phase 1 completed with D-021 (CLI). Next: Phase 2.
- **2026-11-19** — Phase 2 started: test runner, source files, diagnostics, ES5 check
  (D-022 to D-024; new item added; Phase 1 count fixed to 13). Next: CLI argument
  parser and D-021 checks.
- **2026-11-19** — Owner requirements D-025 (JavaScript binding headers: ES5 DOM, ES6 DOM,
  Node.js) and D-026 (`__js__` inline JavaScript, like `__asm__`); Phase 1 reopened for
  their design, items added to Phases 4-8 and 10. Overall count corrected to 25 done.
- **2026-11-19** — CLI done (D-028: `stdlib.js` default, stdout rule, conflicts, syntax);
  `compile()` started. Next: fixture-based tests, then CI.
- **2026-11-19** — Fixture-based tests (D-029) with three CLI/pipeline fixtures.
- **2026-11-19** — CI item dropped: no tests on GitHub (D-030). Next: open questions.
- **2026-11-19** — Open questions closed: binding headers (D-025), `__js__` syntax (D-026),
  `extern "JS"` for third-party code (D-031), shared `stdlib.js` (D-032). Phase 1 done again;
  items added to Phases 5-8 and 10.
- **2026-11-19** — Phase 3 completed: pp-lexer, 64-bit `#if` arithmetic, Prosser macro
  expansion, includes, `#line` (D-033); two Phase 4 items done by the pp-lexer. Next: Phase 4.
- **2026-11-19** — Phase 4 completed: lexer, literal decoding, string concatenation (D-034).
  Next: Phase 5 (parser).
- **2026-11-19** — Decisions D-035 (parser and semantics interleaved), D-036 (ILP32 data
  model), D-037 (UTF-8 byte strings), D-038 (phase-by-phase strategy).
- **2026-11-19** — Phase 6 started: type representation (D-039). Phase 5 started: AST nodes
  (D-040). Scopes and name lookup (D-041). Parser step 1: declarations and declarators
  (D-042). Step 2: namespaces, linkage, attributes (D-043).
- **2026-11-19** — Package installable with npm, not published (D-045); strings become
  JavaScript strings (D-044, supersedes D-037); push at the end of every phase (D-046).
- **2026-11-19** — Parser step 3: expressions, conversions, overload resolution, constant
  evaluation (D-047).
- **2026-11-19** — Parser step 4: statements and jump checks; goto will use the hybrid
  technique (D-048).
- **2026-11-19** — Parser step 5a: enumerations (D-049).
- **2026-11-19** — Parser step 5b: classes, members, this, access, layout (D-050).
