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

### D-029 — Fixture-based end-to-end tests

- **Status**: Accepted (owner chose the task, 2026-11-19; format by agent).
- **Decision**: `test/fixtures.test.js` turns every directory under
  `test/fixtures/` that contains `.cpp` files or an `args` file into one
  test case, named after its path (`<group>/<name>`). Layout:
  - inputs (`*.cpp`, headers): paths in diagnostics are relative to the
    fixture directory, so expectations do not depend on the machine;
  - `args`: CLI arguments, one per line (no shell quoting); default is
    every `.cpp` file, sorted, followed by `-o out.js`;
  - `expected/`: the files the build must write, at their relative path
    (the exact set is checked);
  - `expected.stdout`, `expected.stderr` (default empty), `expected.exit`
    (default `0`).
  The CLI runs in memory through `cli.run()` with injected `readFile` and
  `writeFile`; nothing is written to disk. `CPP2JS_UPDATE_FIXTURES=1 npm
  test` rewrites the expectations from the actual results; the diff must
  then be reviewed before committing.
- **Reason**: a compiler is best tested on whole programs; going through the
  CLI covers argument handling, diagnostics and outputs together, and the
  update mode keeps large expected outputs maintainable.
- **Discarded**: one JSON file per case (awkward for multi-line C++ and JS);
  spawning `bin/cpp2js.js` (`child_process.spawnSync` is not in Node 0.10,
  and an in-memory run is faster).
- **Related**: `src/cli/main.js` now writes `compile()` outputs through
  `io.writeFile` (default `fs.writeFileSync`); an output with a null path is
  the bundle on standard output.

### D-030 — No tests or CI on GitHub

- **Status**: Accepted (owner, 2026-11-19).
- **Decision**: tests are **never** run on GitHub: no GitHub Actions
  workflow, no other GitHub-hosted CI, nothing under `.github/workflows/`.
  The test suite is run locally with `npm test` before every commit
  (AGENTS.md workflow, step 5).
- **Reason**: explicit owner requirement.
- **Consequence**: the Phase 2 item "Continuous integration workflow" is
  dropped. Compatibility with old Node versions (D-020) must be checked
  locally if needed.

### D-031 — Third-party JavaScript code through `extern "JS"`

- **Status**: Accepted (owner, 2026-11-19).
- **Decision**: C++ code calls existing JavaScript code (npm CommonJS
  packages, libraries loaded by `<script>`) through declarations inside
  `extern "JS" { ... }`, the counterpart of `extern "C"` for exports
  (D-014). Only declarations are allowed there; the definitions already
  exist in JavaScript.
  - a namespace marked with the attribute `[[js::module("name")]]` is a
    **CommonJS module**: `namespace [[js::module("left-pad")]] leftpad {...}`
    is emitted as `var leftpad = require('left-pad');` and calls become
    `leftpad.leftPad(...)`. Any package name works (`@scope/pkg`,
    `lodash/fp`);
  - a namespace without the attribute is a **global object** (e.g.
    `jQuery` loaded by `<script>`, or built-ins such as `Math`);
  - modules are always loaded with **`require` at run time**; their code is
    never embedded in the bundle;
  - on `--platform browser`, where `require` does not exist, importing a
    module is a compile-time **error**; global objects are allowed
    (agent choice, the owner had no preference).
- **Reason**: owner requirement; one mechanism, symmetric with `extern "C"`.
  The attribute keeps the module name next to the namespace it describes.
  Attributes on namespaces are standard from C++17; cpp2js accepts them as
  an extension of its C++11 subset (D-010).
- **Rule 2 of AGENTS.md**: it forbids dependencies of the transpiler and of
  its tooling. Packages chosen by the user are dependencies of the user's
  program, as libraries are for a C++ program, and are never bundled.
- **Discarded**: `extern "JS:<module>"` linkage strings; `#pragma` before
  the block; namespace name as module name (fails for `left-pad`); a purely
  dynamic `js::require()`; embedding module code with an in-house CommonJS
  loader; emitting `require` in the browser anyway.

### D-032 — Shared `stdlib.js` is always overwritten

- **Status**: Accepted (owner, 2026-11-19). Resolves the consequence noted
  in D-028.
- **Decision**: the standard library file is **always overwritten**, with no
  check of what it contained. Building two programs into the same directory
  with the default `stdlib.js` is the user's responsibility: each one should
  get its own file with `--std-out <file>` (or use `--embed-std`).
- **Reason**: owner choice; rebuilding a program after it starts using new
  library parts must just work.
- **Discarded**: incremental union of parts; warning on overwrite; error
  when the existing file has different parts; recording the owning bundle
  in the file; a new flag to change the library file (`--std-out` already
  covers it).

### D-033 — Preprocessor

- **Status**: Accepted (owner for system headers and predefined macros,
  2026-11-19; the other points by the agent, owner had no preference on
  extensions).
- **Decision**:
  - **architecture**: `src/preprocessor/pp-lexer.js` (phases 1-3: BOM, line
    splicing reverted inside raw strings, comments, pp-tokens),
    `expression.js` (`#if` evaluation), `preprocessor.js` (phase 4). Macro
    expansion uses **Prosser's hide-set algorithm**; the output is a list
    of pp-tokens for the lexer (Phase 4). Each translation unit gets a
    fresh macro table;
  - **tokens** carry `kind`, `text` (spelling), `value` (canonical: digraphs
    normalized), `source`/`start`/`end` (offsets in the original text),
    `spaceBefore`, `lineStart`, `hideset` and `expansion: {site, macro}`.
    Diagnostics on expanded tokens are reported at the outermost
    invocation (`rootOf`);
  - **system headers** (`<iostream>`, `<js>`, `<es5>`, `<node/fs>`...) are
    **real header files** in the package directory `include/` (owner
    choice), without extension like the standard ones;
  - **search order**: `"..."`: directory of the including file, then `-I`
    paths, then `include/`; `<...>`: `-I` paths, then `include/` (as GCC);
  - **predefined macros** (owner choice): `__cplusplus` = `201103L`,
    `__STDC_HOSTED__`, `__FILE__`, `__LINE__`, `__DATE__`, `__TIME__`;
    `__CPP2JS__` = major*10000 + minor*100 + patch;
    `__CPP2JS_TARGET_ES5__` / `_ES6__`; `__CPP2JS_PLATFORM_BROWSER__` /
    `_NODE__` / `_MIXED__` (value 1). `-D`/`-U` apply after them, in order;
  - **extensions** (agent choice): `__has_include` (C++17), `#warning`,
    `__COUNTER__`, binary literals in `#if`, GNU `, ## __VA_ARGS__`,
    omitting the variadic argument, `defined` produced by a macro
    expansion (evaluated as GCC/Clang do). Not supported: `#include_next`,
    `__VA_OPT__`, GNU line markers (`# 12 "file"`), trigraphs (removed in
    C++17; GCC ignores them by default);
  - **`#if` arithmetic** in 64-bit intmax_t/uintmax_t via `src/util/int64.js`
    (no BigInt in ES5). Character literals: plain `char` is **signed
    8-bit**, `wchar_t` signed 32-bit, `char16_t`/`char32_t` unsigned;
    multi-character literals and non-ASCII plain literals (UTF-8 bytes)
    follow GCC, with a warning. Errors in unevaluated operands are not
    reported;
  - **diagnostics**: a missing include and `#include` nested more than 200
    levels are **fatal** for the translation unit (as GCC/Clang);
    `#error`/`#warning` print `#error <text>`; `#line` changes the presumed
    location used by `__LINE__`, `__FILE__` and diagnostics
    (`SourceFile.addLineMapping`). Unknown pragmas are ignored; `#pragma
    once` and `_Pragma("once")` work; `#pragma once` in the main file
    warns.
- **Reason**: faithful C++11 behaviour, checked against the examples of
  C++11 16.3.5; GCC/Clang behaviour where the standard leaves room.
- **Discarded**: virtual headers known only to the compiler (owner); only
  standard predefined macros; lower-case macro names; doubles for `#if`
  arithmetic (wrong above 2^53).

### D-034 — Lexer and literal representation

- **Status**: Accepted (agent, 2026-11-19; owner chose to proceed with
  Phase 4).
- **Decision**:
  - `src/lexer/lexer.js` converts pp-tokens into C++ tokens of kind
    `identifier`, `keyword` (the 73 C++11 keywords plus `__js__`),
    `integer`, `float`, `char`, `string`, `punct`, `eof`. The token list
    always ends with `eof`;
  - **alternative tokens** (`and`, `or`, `not`, `bitand`, ...) are turned
    into operators already by the pp-lexer, as C++11 2.6 requires: they
    work in `#if` and cannot be macro names;
  - **integer literals** record `value` (Int64), `radix`, `unsigned`,
    `longs` (0, 1, 2) and `udSuffix`; their **type is chosen by semantic
    analysis** (C++11 2.14.2), so the lexer does not depend on the size of
    `long`. Too large for 64 bits is an error;
  - **floating literals**: `value` (JS number), `suffix` (`''`, `f`, `l`),
    `udSuffix`; overflow to infinity is a warning;
  - **character literals**: value as in D-033 (`literals.characterValue`,
    shared with `#if`);
  - **string literals** hold the **code units of their encoding**: UTF-8
    bytes (no prefix, `u8`), UTF-16 units (`u`), code points (`U`, `L`).
    Raw strings keep backslashes, their line ends become `\n`. Adjacent
    literals are concatenated (phase 6): a prefix combines with no prefix,
    `u8` with no prefix; other mixes are errors, as are differing
    user-defined suffixes. The run-time representation of strings is
    decided later;
  - **extensions**: binary integer literals (C++14), hexadecimal floating
    literals (C++17); user-defined literal suffixes are lexed, their
    semantics come later. An unknown escape (`\q`) is a warning that keeps
    the character (GCC/Clang), also in `#if`;
  - **diagnostics**: `stray 'x' in program` for `#`, `##` and stray
    characters; errors in tokens produced by macros point at the outermost
    invocation, with `expanded from macro 'X'` notes at the spelling.
- **Reason**: C++11 2.14 semantics; keeping types out of the lexer
  separates lexical rules from the data model, as Clang does.
- **Discarded**: typing integer literals in the lexer; decoding strings
  directly to JavaScript strings (would lose the C++ byte view).

### D-035 — Parser and semantic analysis are interleaved

- **Status**: Accepted (owner, 2026-11-19).
- **Decision**: as in Clang, the parser asks semantic analysis, while
  parsing, what a name denotes (type, template, namespace, value) and
  semantic analysis builds scopes and declarations as the parser reports
  them. Phases 5 and 6 are developed together; the AST produced is
  already resolved (names bound to declarations, expressions typed).
- **Reason**: C++ syntax depends on name lookup (`a * b;`, `T(x);`,
  `a < b > c;`); only lookup with full scoping (namespaces, class members,
  base classes) follows the standard exactly.
- **Discarded**: a parser-side table of type names (wrong with namespaces
  and inherited members); an ambiguous AST resolved later (GLR-style,
  more complex AST).

### D-036 — Data model ILP32

- **Status**: Accepted (owner, 2026-11-19). Completes D-016.
- **Decision**: `char` 8 bits (signed, D-033), `short` 16, `int` 32,
  **`long` 32**, `long long` 64, pointers 32 bits; `size_t` and
  `ptrdiff_t` are 32-bit (`unsigned int` / `int`); `wchar_t` 32 bits signed;
  `float` 32 and `double` 64 IEEE-754; `long double` = `double`; `bool` 1
  byte. This is the model of Windows 32-bit, wasm32 and Emscripten.
- **Reason**: 32-bit arithmetic is fast and exact in JavaScript (`| 0`,
  `>>> 0`, `Math.imul`); 64-bit values need the slow int64 helper, so they
  are limited to `long long`.
- **Discarded**: LP64 (`long`, pointers and `size_t` on 64 bits).

### D-037 — Narrow strings are UTF-8 bytes at run time

- **Status**: **Superseded by D-044** (owner, 2026-11-19: performance and
  interoperability matter more than byte fidelity for non-ASCII text).
- **Decision**: `std::string`, `char` arrays and narrow string literals
  hold **UTF-8 bytes**, as in native C++: `"é"` has `size() == 2`, `s[i]` is
  a byte, `strlen`/`memcpy` behave as expected. Conversion to and from
  JavaScript strings (UTF-16) happens only at the boundaries: console and
  streams, DOM and Node.js bindings, `extern "JS"` calls, `__js__`
  operands of string type.
- **Reason**: programs must produce the same results as natively (D-016);
  the lexer already delivers UTF-8 units (D-034).
- **Discarded**: `std::string` backed by a JavaScript string (fast interop,
  but sizes and indexing differ from C++).

### D-038 — Development strategy: phase by phase

- **Status**: Accepted (owner, 2026-11-19).
- **Decision**: the parser and semantic analysis (Phases 5-6, developed
  together per D-035) cover the whole C++11 subset of D-010 before code
  generation (Phase 7) starts. Order inside Phases 5-6: type
  representation, AST nodes, scopes/declarations/lookup, then the parser
  for declarations, statements and expressions with their semantic checks.
- **Reason**: owner choice.
- **Discarded**: a vertical slice (minimal subset carried to runnable JS
  first, then widened).

### D-039 — Type representation

- **Status**: Accepted (agent, 2026-11-19).
- **Decision**: `src/semantic/types.js`. A `TypeContext` creates and
  **interns** every type, so type identity is `===`. Each type carries its
  cv-qualifiers (`isConst`, `isVolatile`) and `unqualified`; kinds are
  `builtin` (canonical names such as `'unsigned long long'`,
  `'std::nullptr_t'`), `pointer`, `lvalue-ref`, `rvalue-ref`, `array`
  (size or null), `function` (return, adjusted params, variadic, method
  cv and ref-qualifier), `record` and `enum` (pointing to their
  declaration, which must have a unique numeric `id`). Built in: reference
  collapsing, cv on arrays applied to elements, parameter adjustment,
  decay, ILP32 `sizeOf`, integral promotion, usual arithmetic conversions
  and Clang-style printing (`const int *`, `int (*)[3]`, `void (int, ...)`)
  for diagnostics.
- **Reason**: interning makes type comparison trivial and fast, which
  overload resolution and conversions need constantly; Clang spelling is
  what users already know.
- **Discarded**: structural comparison of non-interned types; Clang's
  separate `QualType` wrapper (more objects to handle in ES5).

### D-040 — AST nodes

- **Status**: Accepted (agent, 2026-11-19).
- **Decision**: `src/ast/nodes.js`. Nodes are plain objects
  `{kind, range, ...fields}` created by `createNode(kind, range, fields)`,
  which fills every field declared for the kind in `NODE_KINDS` and rejects
  unknown ones. Each kind lists `children` (fields holding nodes or arrays
  of nodes, visited by `walk`/`childrenOf`) and `props`. Declarations are
  AST nodes and scope entries at once (D-035); expressions carry `type`
  and `valueCategory` (`lvalue`, `xvalue`, `prvalue`); implicit
  conversions are explicit `CastExpr` nodes with `written: false`.
  `range` is the spelling range in the user's file. Field names never use
  `kind`, `range` or Object.prototype names (`constructor` -> `constructorDecl`).
- **Reason**: a data-driven definition keeps the many node kinds
  consistent and gives traversal for free; plain objects are cheap in ES5.
- **Discarded**: one constructor function per node kind (much more code,
  no benefit for traversal).

### D-041 — Scopes and name lookup

- **Status**: Accepted (agent, 2026-11-19).
- **Decision**: `src/semantic/scope.js`. A `Scope` (kinds: namespace,
  class, enum, function, block, prototype, template) maps names to
  declarations in order, with its using-directives; namespace, class and
  enum scopes point to their declaration (`entity`) and back (`scope`).
  Lookup results are `{decls, ambiguous}`; several functions form an
  overload set. Implemented rules:
  - unqualified lookup (3.4.1) outwards, stopping at the first scope with
    a result; class scopes search their bases (10.2);
  - members of namespaces nominated by `using namespace` count as
    declared in the nearest namespace enclosing both the directive and
    the nominated namespace (7.3.4/2), transitively; a clash with a name
    of that namespace is ambiguous;
  - qualified lookup in namespaces (3.4.3.2): own members (plus inline
    namespaces, 7.3.1/8) first, then nominated namespaces recursively;
  - member lookup: a name in the class hides its bases; the same name in
    several bases is ambiguous unless it is the same declaration;
  - class/enum names are hidden by variables, functions and enumerators
    of the same name in the same scope (3.3.10/2); `tagsOnly` finds them
    for elaborated specifiers; using-declarations expand to their targets.
- **Reason**: the parser depends on exact lookup (D-035).
- **Discarded**: approximating using-directives by injecting names into
  the scope that contains the directive (wrong in the ambiguous case).

### D-042 — Parser structure and declarators

- **Status**: Accepted (agent, 2026-11-19; owner approved the step order).
- **Decision**:
  - `src/parser/parser.js` (tokens, recovery, declarations) is extended by
    `parse-expr.js` and `parse-stmt.js` on `Parser.prototype`;
    `src/semantic/sema.js` holds the semantic actions it calls;
    `src/ast/dump.js` prints the AST like `clang -ast-dump` for tests;
  - a **declarator** is parsed into `{ptrOps, name, nested, suffixes}` and
    turned into a type by `Sema.typeFromDeclarator`: pointer operators
    apply left to right, array/function suffixes right to left, a nested
    declarator last (C++11 8.3). Invalid compositions (arrays of
    references, functions returning arrays, references to `void`, ...)
    are reported with Clang's wording;
  - **disambiguation**: after a named declarator, `(` starts parameters
    only if followed by `)`, `...` or something that can begin a
    declaration (`int b(2);` is a variable, `int f(int);` a function, as
    C++11 8.2/1 requires); in abstract declarators `(` followed by a
    decl-specifier, `)` or `...` is a parameter list (8.2/7);
  - **recovery**: a `ParseError` abandons the current declaration or
    statement; the parser skips to `;` or the closing `}` at the same
    depth. Missing tokens at the end of a line are reported after the
    previous token, as Clang does;
  - **redeclarations**: functions chain to their most recent matching
    declaration (`previous`); default arguments merge; variables may be
    redeclared only with `extern` at namespace scope; typedefs may repeat
    with the same type; literal types follow C++11 table 6 with ILP32.
- **Reason**: the declarator model mirrors the grammar and keeps type
  construction in one place; Clang's messages are familiar.
- **Discarded**: building types while parsing declarators (hard to get the
  inside-out order right with nested declarators).

### D-043 — Namespaces, linkage specifications and attributes

- **Status**: Accepted (agent, 2026-11-19; implements D-014 and D-031).
- **Decision**:
  - every `namespace` occurrence is its own AST node; reopenings point to
    the first one (`previous`) and share its scope; unnamed namespaces add
    an implicit using-directive; `inline` cannot be added on reopening;
  - qualified names (`::opt (name ::)* name`) are scanned without
    consuming tokens (`_scanQualifiedName`) so that the parser can decide
    between declarations and expressions; qualifiers must be namespaces,
    classes or enumerations;
  - an out-of-namespace definition (`void ns::f() {}`) must match an
    existing member and be made in an enclosing namespace; its body is
    looked up in the namespace scope first;
  - **linkage**: `extern "C"`, `"C++"`, `"JS"`; the unbraced form makes
    variables declarations; two `extern "C"` functions with the same name
    and different parameters are `conflicting types` (D-014); in
    `extern "JS"` everything is a declaration, definitions and
    initializers are errors (D-031);
  - **attributes** `[[...]]` are parsed generically; standard ones
    (`noreturn`, `deprecated`, ...) are ignored silently, unknown ones
    with a warning; `[[js::module("name")]]` is valid only on a namespace
    inside `extern "JS"`, and is an error on `--platform browser`.
- **Reason**: C++11 7.3 and 7.5 semantics, Clang diagnostics.
- **Discarded**: a single node per namespace with merged declaration
  lists (loses the source order needed by code generation).

### D-044 — Strings are JavaScript strings, exact for ASCII

- **Status**: Accepted (owner, 2026-11-19). Supersedes D-037.
- **Decision**: `std::string` and narrow string literals are represented
  at run time by **JavaScript strings** (UTF-16). For **ASCII** text the
  behaviour is exactly that of C++: `size()`, `s[i]`, comparisons,
  `find`, `strlen` give the same results. For non-ASCII text lengths and
  indexes count UTF-16 code units instead of UTF-8 bytes; this divergence
  is documented. Code generation converts the UTF-8 units delivered by the
  lexer (D-034) into JavaScript strings. Concatenation, comparison,
  search and hashing use the native string operations; strings pass to
  console, DOM, Node.js and `extern "JS"` without conversion.
- **Reason**: owner choice after comparing performance: native strings are
  much faster for the common operations and free at the JavaScript
  boundaries.
- **Discarded**: UTF-8 byte arrays (D-037); "byte strings" with one UTF-8
  byte per character (exact but with conversions at the boundaries).
- **Open detail (Phase 10)**: value of `char c = s[i]` when the unit is
  above 127, and in-place modification `s[i] = c` (JavaScript strings are
  immutable).

### D-045 — No npm publication before the project is finished

- **Status**: Accepted (owner, 2026-11-19).
- **Decision**: the package is installable (`npm install -g .` from a
  clone, checked with `npm pack` and a global install) but is **not
  published** on the npm registry until the project is finished. The
  name `cpp2js` was free on 2026-11-19.
- **Reason**: owner choice; the compiler does not generate code yet.
- **Discarded**: publishing a 0.0.x placeholder now; publishing at v0.1.0.

### D-046 — Push at the end of every phase

- **Status**: Accepted (owner, 2026-11-19).
- **Decision**: commits stay local during a phase; when a phase of
  `ROADMAP.md` is completed, all commits are pushed to `origin main`.
  Phases 5 and 6 are developed together (D-035), so the next push comes
  when Phase 5 is complete.
- **Reason**: owner choice.
- **Discarded**: pushing after every step; pushing immediately.

### D-047 — Expressions, conversions and overload resolution

- **Status**: Accepted (agent, 2026-11-19; owner approved the step order).
- **Decision**:
  - `src/semantic/conversions.js`: implicit conversion sequences (C++11
    clause 4, 8.5.3, 13.3.3.1) are computed without side effects and then
    applied as implicit `CastExpr` nodes, one per step, whose `conversion`
    names the operation (`LValueToRValue`, `ArrayToPointerDecay`,
    `IntegralCast`, `FloatingToIntegral`, `NullToPointer`, `BitCast`,
    `MaterializeTemporary`, ...). Reference binding follows 8.5.3,
    including temporaries for const lvalue and rvalue references;
  - `src/semantic/overload.js`: overload resolution over standard
    conversion sequences with the 13.3.3.2 tie-breakers (bool
    conversions, rvalue vs lvalue reference binding, less cv-qualified
    references and pointers). A single non-overloaded function gets
    Clang's direct messages; an overload set gets "no matching function"
    or "is ambiguous" with one note per candidate. The address of an
    overload set is resolved by the target type (13.4);
  - `src/semantic/constant.js`: integral constant expressions evaluated
    with exact 64-bit arithmetic, truncated to each type (ILP32), including
    const integral variables with constant initializers;
  - `src/semantic/sema-expr.js`: built-in operators with promotions and
    usual arithmetic conversions, pointer arithmetic and comparisons
    (composite pointer type), value categories, casts (`static_cast`,
    `const_cast`, `reinterpret_cast`, C-style trying them in the 5.4
    order, functional), `sizeof`/`alignof`, `new`/`delete` for non-class
    types, and initialization (copy, direct, list with narrowing errors,
    arrays with bound deduction, char arrays from strings, references);
  - warnings on by default as in Clang: `expression result unused`,
    `division by zero is undefined`, value-changing conversions of
    constants (not in list-initialization, where narrowing is an error).
- **Reason**: every conversion is explicit in the AST, so code generation
  can implement the integer semantics of D-016 exactly.
- **Not yet**: class types (user-defined conversions, overloaded
  operators, member access), `dynamic_cast`, exceptions, lambdas.

### D-048 — Statements; goto translated with a hybrid technique

- **Status**: Accepted (owner for the goto technique, 2026-11-19; the rest
  by the agent).
- **Decision (Phases 5-6)**: `parse-stmt.js` and `sema-stmt.js` implement
  C++11 clause 6: compound, expression, declaration, `if`/`else`,
  `switch`/`case`/`default`, `while`, `do`, `for`, `break`, `continue`,
  `return`, `goto` and labels. Substatements and conditions that declare
  variables get their own block scope. Checked: contextual conversion of
  conditions to bool; integral switch conditions, constant and unique
  case values, a single default; break/continue placement (`target`
  points to the loop or switch); labels with function scope, undeclared
  and duplicate labels; **jumps (goto, case, default) that bypass a
  variable with an initializer or a non-scalar type** (6.7/3).
  Default-on warnings as in Clang: assignment used as condition, empty
  body on the same line, non-void function without a return value (in
  all control paths), except `main`.
- **Decision (Phase 7, owner)**: `goto` is translated with a **hybrid
  technique**: functions without goto stay structured code; forward jumps
  that leave enclosing blocks become `break label` on labeled blocks; only
  the smallest region that needs it (backward jumps, jumps into blocks or
  loops) becomes a state machine (`for (;;) switch ($L)` with
  `continue $dispatch`).
- **Reason**: readable and fast output for the common cases, support for
  every goto allowed by C++.
- **Discarded**: always a state machine for functions with goto (less
  readable output); only forward gotos (rejects valid C++).
- **Not yet**: range-based for (C++11 step), exceptions.

### D-049 — Enumerations

- **Status**: Accepted (agent, 2026-11-19; part of step 5a approved by the
  owner).
- **Decision**: `src/semantic/sema-tag.js` (tags) and
  `Parser.parseEnumSpecifier`:
  - unscoped and scoped (`enum class` / `enum struct`) enumerations, fixed
    underlying types, opaque declarations (`enum class E;`,
    `enum E : int;`), elaborated references (`enum E e;`) and anonymous
    enumerations; redeclarations check scoped-ness and underlying type;
  - enumerator values are **Int64**; during the definition an enumerator
    has the type of its initializer (or of the previous one, widened on
    overflow); after `}` every enumerator has the enumeration type;
  - without a fixed type the underlying type is the first of `int`,
    `unsigned int`, `long long`, `unsigned long long` holding all values
    (GCC's choice; `long` equals `int` in ILP32); with a fixed type every
    value must be representable (checked before conversion);
  - unscoped enumerators are members of both the enumeration scope and the
    enclosing scope (`E::a` and `a`); scoped ones only of the former;
    unscoped enumerations promote to integers, scoped ones never convert
    implicitly;
  - an opaque declaration and the later definition are the same EnumDecl
    node (enumerations generate no code of their own).
- **Reason**: C++11 7.2 semantics with GCC/Clang diagnostics.
- **Discarded**: a separate node per enumeration redeclaration (no benefit:
  enumerators are compile-time constants).

### D-050 — Classes: members, this, access, layout

- **Status**: Accepted (agent, 2026-11-19; part of step 5b approved by the
  owner).
- **Decision**: `src/semantic/sema-class.js` and `src/parser/parse-class.js`:
  - `class`/`struct`/`union` definitions, forward declarations and
    elaborated references (`struct S *p;` declares S in the nearest
    namespace or block scope); default access private for `class`,
    public otherwise; data members (with `mutable`, bit-fields and default
    member initializers), member functions, nested types and typedefs;
  - **member function bodies written in the class are parsed when the
    outermost class is complete** (C++11 9.2/2), by saving and restoring
    the token position; default arguments and member initializers are
    still parsed in place (later members are not visible there yet);
  - `this` is a prvalue `cv C *` with the method's cv; members named
    without an object become implicit `this->m`; member access computes
    cv (object cv + member cv, `mutable` excluded) and category (lvalue,
    or xvalue for prvalue objects); reference members are lvalues;
  - member function calls resolve overloads with the **implicit object
    argument** (a const object only accepts const methods; a non-const
    object prefers non-const ones); out-of-line definitions `R C::f()`
    must match a declaration exactly (cv and return type included);
  - **access control**: private members only from members of the class
    and of classes nested in it; protected also from derived classes
    (step 5d); Clang's messages with a `declared private here` note;
  - **layout** (ILP32, natural alignment as wasm32): fields aligned to
    their size (max 8), bit-fields packed in units of their type, unions
    sized by the largest member, empty classes 1 byte; `sizeof` uses it;
  - aggregates (no constructors, private fields, bases, virtuals) accept
    brace initialization member by member, with narrowing checks.
- **Reason**: C++11 clauses 9 and 11; native `sizeof` values (D-016).
- **Not yet**: constructors and destructors (5c), inheritance and virtual
  functions (5d), operators (5e), friends and static members (5f),
  anonymous structs/unions, qualified class names in definitions.

### D-051 — Constructors, destructors and special members

- **Status**: Accepted (agent, 2026-11-19; part of step 5c approved by the
  owner).
- **Decision**: `src/semantic/sema-special.js` and the constructor parts of
  `parse-class.js`:
  - constructors (`explicit`, delegating), destructors, member
    initializer lists (fields and delegation; bases in 5d), `= default`,
    `= delete` (for any function), in-class and out-of-line definitions
    (`S::S(...) : ... {}`, `S::~S() {}`, also qualified by namespaces);
  - **implicit special members** declared when a class is complete:
    default constructor (only without user constructors), copy
    constructor, copy assignment, move constructor and move assignment
    (not when the class declares copy operations, move operations or a
    destructor), destructor; each is deleted when members require it
    (references, const members, members without the needed operation,
    user-declared moves for copies);
  - **every copy of a class object is explicit in the AST**: objects are
    JavaScript references (D-018), so initializing an object from a
    glvalue of its class is a `ConstructExpr` with the copy or move
    constructor (`ConstructorConversion` step), assignment calls the
    assignment operator (`BinaryExpr '='` with `function`), and
    prvalues initialize directly (elision). A local returned by value is
    treated as an rvalue first (implicit move, 12.8/32);
  - initialization forms: default, direct `S s(a)`, copy `S s = e`
    (explicit constructors excluded; Clang's "no viable conversion"),
    list `S s{a}` and copy-list `S s = {a}` (explicit chosen is an
    error), aggregates through the same entry point; `new S(...)`,
    functional casts `S(a)`, `S{a}`, `S()`;
  - constructor errors with Clang's wording: no matching / ambiguous /
    deleted / implicitly-deleted constructor, private constructor,
    uninitialized const and reference members.
- **Reason**: C++11 clause 12 semantics; explicit copies are what the
  JavaScript object model needs.
- **Not yet**: base class initializers (5d), user-defined conversions
  through constructors in function arguments (5e), destructor calls at
  scope exit (generated in Phase 7).

### D-052 — Inheritance and virtual functions

- **Status**: Accepted (agent, 2026-11-19; part of step 5d approved by the
  owner).
- **Decision**: `src/semantic/sema-inherit.js` with hooks in classes,
  conversions and casts:
  - **single inheritance** with `public`/`protected`/`private` bases
    (default private for `class`, public for `struct`); multiple and
    virtual bases are parsed and rejected with "not supported yet"
    (D-010); final classes, unions and incomplete classes cannot be bases;
  - **access through inheritance** (11.2): the access of a member named in
    a derived class is the more restrictive of its own and the
    inheritance access, private members of bases are inaccessible;
    Clang's `constrained by private inheritance here` note; inaccessible
    bases block derived-to-base conversions;
  - **conversions**: `D*` to `B*`, `D&` to `B&` (rank Conversion,
    `DerivedToBase` casts), slicing copies through the base copy
    constructor; a closer base beats a farther one and any base beats
    `void *` (13.3.3.2/4); `static_cast` down (`BaseToDerived`);
  - **virtual functions**: `virtual`, implicit virtual on overriders,
    `override` and `final` (contextual keywords), pure `= 0`, virtual
    destructors inherited by derived destructors (also implicit ones),
    covariant return types; calls through a non-qualified member are
    marked `isVirtualCall`, `Base::f()` is a direct call;
  - **abstract classes**: no variables, `new`, or fields of them; Clang's
    notes list the unimplemented pure methods; abstract bases are still
    constructed as subobjects;
  - **layout**: the base subobject first (empty bases take no space); a
    class introducing virtual functions starts with a 4-byte vtable
    pointer; base initializers in constructors, required when the base
    has no default constructor.
- **Reason**: C++11 clauses 10-11 with Clang's diagnostics.
- **Discarded for now**: multiple inheritance, virtual bases,
  `dynamic_cast` (planned after the core, D-010).

### D-053 — Overloaded operators and user-defined conversions

- **Status**: Accepted (agent, 2026-11-19; part of step 5e approved by the
  owner).
- **Decision**: `src/semantic/sema-operator.js` with parser support for
  `operator@` names (also qualified, `S::operator+`) and conversion
  functions (`operator T()`, `explicit operator bool()`, also out of
  line):
  - an operator with a class or enumeration operand looks for
    `operator@` as a member of the left operand's class and as a
    non-member through ordinary lookup **plus the namespaces of the
    operands' classes** (simplified ADL, 3.4.2); member candidates take
    the implicit object argument; the best viable candidate is called
    (`CallExpr` with `overloadedOperator`). With no viable user operator
    the built-in rules apply (built-in candidates are not mixed into
    the overload set);
  - covered: all binary and unary operators, compound assignments,
    prefix and postfix `++`/`--` (dummy `int`), `[]`, `()` (function
    objects), `->` (applied until a pointer results); class `=` uses the
    assignment operators (D-051); `&` and `,` are always built-in;
  - declarations are checked: arity, member-only operators (`=`, `()`,
    `[]`, `->`), a class or enumeration parameter for non-members, the
    `int` of postfix forms; `new`/`delete` overloads are not supported;
  - **user-defined conversions** (13.3.3.1.2): a non-explicit
    converting constructor of the target or a conversion function of the
    source (or its bases), followed by a standard conversion; ranked
    below standard conversions and above `...`; at most one per
    sequence; `explicit` ones only in direct and contextual contexts
    (`explicit operator bool` works in conditions and `!`, `&&`, `||`).
- **Reason**: C++11 13.3.1.2 and 12.3 with Clang-compatible results for
  common code.
- **Limits**: built-in candidates with converted class operands (e.g.
  `obj + 1` through `operator int`) are not considered; comparison of two
  user-defined sequences through different functions is a tie.

### D-054 — Friends and static members

- **Status**: Accepted (agent, 2026-11-19; part of step 5f approved by the
  owner).
- **Decision**: `src/semantic/sema-friend.js`:
  - `friend class X;` / `friend X;` add X to the class's friends (an
    undeclared X is declared in the nearest enclosing namespace, not
    in the class); `friend R f(...)` declares f in the innermost
    enclosing namespace and makes it a friend; inline friend
    definitions are parsed with the delayed member bodies, in the scope
    of the class. Friends pass access checks, also through bases.
    Friend member functions of other classes are not supported yet;
  - static data members are `VarDecl`s with `isStaticMember`: declared
    in the class (not laid out), defined out of line (`int S::n = 0;`,
    matched by name and type, a single definition), in-class
    initializers only for const integral/enumeration or constexpr
    members, usable in constant expressions; not allowed in local
    classes; `obj.s` and `S::s` name the member itself;
  - static member functions are called as `S::f()` or `obj.f()` and have
    no `this`; qualified uses of private static members are checked;
  - after a qualified declarator-id, the rest of the declarator is
    looked up in the scope of the qualifier (3.4.1/8): `int S::a[k]`,
    `void S::f(Nested x)`; local classes print without their function.
- **Reason**: C++11 11.3 and 9.4.

### D-055 — auto, decltype, static_assert

- **Status**: Accepted (agent, 2026-11-20; part of step 6a approved by the
  owner).
- **Decision**: `src/semantic/sema-cxx11.js`:
  - `auto` is a placeholder type while the declarator is built and is
    deduced from the initializer like a template argument (14.8.2.1):
    the declared form (`auto`, `auto *`, `const auto &`, `auto &&`) is
    matched against the initializer's type level by level; plain `auto`
    decays and drops top-level cv; `auto &&` is a forwarding reference
    (an lvalue gives `A &`). All declarators of one declaration must
    deduce the same `auto`;
  - **`auto x{e}` deduces e's type** (N3922, applied by GCC and Clang
    also in C++11 mode); `auto x = {e}` would need
    `std::initializer_list` and is rejected for now;
  - `auto` is rejected in parameters, non-static members and typedefs;
    `auto f()` without a trailing return type is an error (deduced
    return types are C++14); parameters are visible in trailing return
    types;
  - `decltype(e)`: declared type of an unparenthesized name or member,
    otherwise `T&` / `T&&` / `T` by value category;
  - `static_assert(cond, "msg")` at namespace, class and block scope;
    Clang's `static assertion failed: msg`; the message may be omitted
    with a C++17-extension warning.
- **Reason**: C++11 7.1.6.2, 7.1.6.4 and 7, matching current compilers.

### D-056 — Range-based for

- **Status**: Accepted (agent, 2026-11-20; part of step 6b approved by the
  owner).
- **Decision**: `for (decl : range)` is expanded as C++11 6.5.4 says into
  hidden variables of the `RangeForStmt` node: `__range` (`auto &&`
  bound to the range), `__begin` and `__end` (`auto`), plus the
  condition `__begin != __end` and the increment `++__begin`, all typed;
  the loop variable is initialized with `*__begin`. begin/end are
  `__range` and `__range + N` for arrays (`rangeKind: 'array'`), member
  functions `begin()`/`end()` when the class has both (`'member'`), or
  free functions found by argument-dependent lookup only (`'adl'`).
  Braced lists as ranges need `std::initializer_list` and are rejected.
- **Reason**: code generation gets every operation already resolved
  (overloaded `!=`, `++`, `*` included).

### D-057 — Lambda expressions

- **Status**: Accepted (agent, 2026-11-20; part of step 6c approved by the
  owner).
- **Decision**: `src/semantic/sema-lambda.js` and
  `Parser.parseLambdaExpression`:
  - each lambda gets a unique closure class named like Clang
    (`(lambda at file:line:col)`) with a public `operator()` (const
    unless `mutable`), one private member per capture, deleted default
    constructor and assignment, and — without captures — an implicit
    conversion to a function pointer;
  - the body is a function scope nested in the enclosing scope; every
    automatic variable records its function (`ownerFunction`); using one
    of an enclosing function captures it on every lambda in between,
    explicitly (`[x]`, `[&x]`) or through the default (`[=]`, `[&]`),
    otherwise Clang's "cannot be implicitly captured" error with notes.
    Copies are const in non-mutable lambdas; `DeclRefExpr` records
    `isCapture`/`capturedByCopy`;
  - `this` in a lambda is the enclosing member function's object and
    must be captured (`[this]`, or implicitly by a default); capture
    lists are validated (duplicates, `[=, x]`, `[&, &x]`, non-automatic
    variables);
  - without `-> R` the return type is deduced from the returns, which
    must all agree (the C++14 rule GCC and Clang also apply in C++11
    mode); no return gives `void`; `break`/`continue` cannot leave the
    body.
- **Reason**: C++11 5.1.2; the explicit capture list in the AST is what
  code generation needs to build JavaScript closures (D-057 hands them
  over to Phase 7).

### D-058 — `__js__` syntax details

- **Status**: Accepted (agent, 2026-11-20; completes D-026).
- **Decision**: `src/semantic/sema-js.js`:
  - statement `__js__("code" [: outputs [: inputs]]);` with outputs
    `"=" (lvalue)` (write) or `"+" (lvalue)` (read-write), which must be
    modifiable lvalues, and inputs `(expr)`; expression
    `__js__<T>("expr" [: inputs])`, a prvalue of `T` (not a reference,
    array or function; `void` allowed); `__js__("...")` used as a value
    without `<T>` is an error;
  - the code is a narrow (or `u8`) string literal, possibly raw or
    concatenated, decoded from UTF-8 to a JavaScript string and stored
    as a list of text pieces and operand indexes (`JsStmt.code`,
    `JsExpr.code`); operands are numbered outputs first, then inputs;
  - **`%N` is an operand only when a digit follows `%`**; `%%` is a
    literal `%`; any other `%` stays as written, so `a % b` needs no
    escaping (`a %2` must be written `a % 2` or `a %%2`);
  - scalar inputs are passed as rvalues, class objects as references
    (JavaScript objects, D-018); operand numbers are checked.
- **Reason**: GCC extended-asm familiarity (D-026) without making the
  common JavaScript `%` operator awkward.

### D-059 — Templates by token replay

- **Status**: Accepted (owner chose to implement templates now,
  2026-11-20; technique by the agent).
- **Decision**: `src/semantic/sema-template.js`, `src/parser/parse-template.js`:
  - a template declaration is **not analysed where it is written**: its
    parameter list is parsed, the declaration's tokens are skipped and
    their range is stored in a `TemplateDecl`;
  - **instantiation re-parses those tokens** with the parser moved back
    to them and a template scope binding each parameter (types as
    typedefs, values as constants); the instantiated code is therefore
    fully checked with concrete types, and errors name the concrete
    types (`Array<int, 4>`). Instantiations are cached by their
    arguments; a class instantiation is cached before its body is
    parsed, so it may refer to itself; inside it the template's name
    alone is the injected-class-name, followed by `<` the template;
  - **member function bodies of class templates are instantiated only
    when used** (14.7.1): their positions are recorded and the body is
    parsed at the end of the translation unit when the function is
    called (virtual functions and destructors always);
  - template arguments: `>` and `>>` close the list (C++11 14.2/3; a
    `>>` leaves one `>` pending), parentheses make `>` an operator
    again; template-ids are parsed once per position (also during
    tentative name scanning) and cached; default arguments are replayed
    with the earlier parameters bound; non-type arguments are converted
    constant expressions (no narrowing, no floating point); non-type
    parameters are integral or enumeration types for now;
  - instantiated classes are listed in `TranslationUnit.instantiations`.
- **Reason**: re-parsing reuses the whole parser and semantic analysis,
  gives exact checking of instantiations and handles dependent code
  without a separate representation of dependent types.
- **Trade-off**: errors in a template that is never instantiated are not
  reported (as with Microsoft's compiler before two-phase lookup);
  names are looked up from the template's definition scope at
  instantiation.

### D-060 — Function templates: deduction, SFINAE, ordering

- **Status**: Accepted (agent, 2026-11-20; templates step T2).
- **Decision**:
  - the signature of a function template is analysed once with each
    template parameter replaced by a placeholder (a distinct dependent
    class type, or a constant without value; `T a[N]` gets a deducible
    size), giving the **pattern** used for deduction; errors there are
    discarded. Redeclarations merge when their patterns match
    (parameter names ignored); `X<T>` in a pattern is a dependent
    specialization, `typename Q::name` an opaque non-deducible type;
  - **deduction** (14.8.2.1) matches each parameter pattern against the
    argument type: references bind the argument type, other parameters
    see the decayed, cv-unqualified argument; forwarding references
    deduce `A&` for lvalues; pointers, arrays (bounds), function types
    and specializations of class templates (also through a base class)
    are matched structurally; extra cv on P is allowed; non-deduced
    contexts are skipped; conflicts and missing arguments give Clang's
    "candidate template ignored" notes; explicit arguments (`f<int>`)
    are not deduced and exclude non-template functions;
  - the deduced declaration is then instantiated by token replay in
    **SFINAE mode** (errors go to a throwaway bag and only discard the
    candidate); its body is recorded and instantiated when the function
    is used;
  - **best viable function**: better conversions, then a non-template
    beats a template specialization, then the more specialized template
    (simplified partial ordering by mutual deduction of the patterns).
- **Reason**: C++11 14.8 with Clang-compatible results on common code.
- **Limits**: partial ordering ignores some special rules; deduction from
  a template-id's address (`&f<int>` to a pointer) is not supported yet.

### D-061 — Template specializations

- **Status**: Accepted (agent, 2026-11-20; templates step T3).
- **Decision**:
  - **explicit class specializations** `template <> struct X<args> {...}`
    are parsed as ordinary classes and stored as the instantiation for
    their arguments; after an implicit instantiation of the same
    arguments they are an error (Clang's message);
  - **partial specializations** `template <params> struct X<pattern>`
    store their pattern arguments (analysed with placeholders) and their
    tokens on the primary template; at instantiation every pattern is
    matched exactly against the arguments (`matchExact`: placeholders
    bind, the rest must be identical, repeated parameters must agree,
    array bounds and value arguments deducible); the most specialized
    match (mutual matching of patterns) is replayed with its own
    parameters bound, ambiguity is an error;
  - **explicit function specializations** `template <> R f<args>(...)` or
    with arguments deduced from the declared type are parsed as ordinary
    functions in a hidden scope and stored as the specialization for
    their arguments, so calls deducing those arguments use them;
  - `X<args>::member` works in expressions and types.
- **Reason**: C++11 14.5.5 and 14.7.3; enough for type traits and the
  standard library.
- **Not yet**: explicit specializations of members of class templates.

### D-062 — Variadic templates by per-element replay

- **Status**: Accepted (agent, 2026-11-20; templates step T4).
- **Decision**:
  - a template parameter pack is bound to a list of arguments; a function
    parameter pack `Ts... args` expands into one parameter per element
    (all named `args`), and the body sees a pack holder `args` whose
    elements are those parameters (an empty pack still declares it);
  - every **pack expansion** (`f(args...)`, `g(h(args)...)`, `{xs...}`,
    `X<Ts...>`) re-parses the tokens of its pattern once per element,
    with each pack in the pattern naming that element
    (`sema.packIndices`); packs of different lengths are an error, and a
    pack named outside an expansion is
    `expression contains unexpanded parameter pack`;
  - in patterns (signatures and partial specializations) a pack has one
    placeholder element; a trailing function parameter pack takes the
    remaining call arguments (each deduced against the element pattern),
    and a trailing `T...` in a partial specialization matches the
    remaining template arguments;
  - `sizeof...(X)` is an integer constant;
  - a partial specialization is used even if the primary template is
    only declared;
  - inside an instantiated function body, the function name denotes the
    template again (the specialization is removed from the template
    scope), so recursion over packs reaches other specializations.
- **Reason**: the token-replay design (D-059) makes expansion a loop
  over the same tokens, without a separate tree transformation.
- **Discarded**: substituting into a dependent AST (needs a full
  dependent-type representation).
- **Not yet**: several packs in function templates (only the last one is
  accepted, as for class templates); pack expansions in base lists,
  member initializers and lambda captures; diagnosing unexpanded packs in
  templates that are never instantiated.

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

- **Status**: Accepted (owner, 2026-11-19); design completed by the owner
  the same day (see *Design* below).
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
- **Design** (owner, 2026-11-19):
  - header names are flat: `<es5>` (DOM of ES5 browsers) and `<es6>` (DOM of
    ES2015+ browsers); `<es6>` **includes** `<es5>` and only adds the newer
    APIs. Node.js has **one header per core module**: `<node/fs>`,
    `<node/child_process>`, `<node/path>`, ...;
  - namespaces: `dom::` for the DOM (`dom::Document`, `dom::Element`, ...),
    `node::fs`, `node::child_process`, ... for Node.js;
  - APIs are exposed as **typed C++ classes and functions**, checked by the
    type checker;
  - the shared base types live in namespace `js::`, header `<js>`:
    `js::value` (dynamic value with get/set/call), `js::object`,
    `js::array<T>`, `js::function<R(Args...)>` (callbacks);
  - a header used with an incompatible `--target` (`<es6>` with `es5`) or
    `--platform` (`<es5>`/`<es6>` on `node`, `<node/...>` on `browser`) is
    a compile-time **error**.
- **Discarded**: `<js/dom_es5>`-style names and `js::dom::` namespace,
  `<cpp2js/...h>` names, a single dynamic type only, independent ES5/ES6
  headers, a warning on misuse.
- **Implementation idea**: the binding headers can be written with
  `extern "JS"` (D-031), so DOM, Node.js and third-party modules share one
  mechanism.

### D-026 — `__js__`: inline JavaScript, like `__asm__`

- **Status**: Accepted (owner, 2026-11-19); syntax decided by the owner the
  same day (see *Syntax* below).
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
- **Syntax** (owner, 2026-11-19):
  - **optional operands, GCC extended-asm style**:
    `__js__("%0 = Math.max(%1, %2);" : "=" (r) : (a), (b));` binds the C++
    lvalue `r` as output `%0` and the values `a`, `b` as inputs `%1`, `%2`.
    Without operands the string is plain code: `__js__("debugger;");`.
    Adjacent string literals concatenate and raw strings `R"(...)"` work,
    as for any C++ string;
  - **statement and typed expression**: `__js__("...");` is a statement;
    `__js__<T>("expr")` is an expression of C++ type `T`
    (`double t = __js__<double>("Date.now()");`), so type checking keeps
    working;
  - **copied verbatim**: the JavaScript is not parsed or checked for now
    (as compilers do with `asm`); an optional syntax check is a later
    roadmap item, once an in-house JS parser exists;
  - **isolated in a function**: each `__js__` is emitted as an immediately
    invoked function whose parameters are the input operands, called with
    `.call(this, ...)`; outputs are returned by the wrapper and assigned to
    their C++ lvalues after the call. Names declared inside `__js__`
    therefore never clash with minified names.
- **Discarded**: plain string using C++ names directly (breaks with
  mangling, D-012 and minification); operands mandatory; statement only;
  syntax/target checking now; inline emission without isolation.
- **Consequence**: `return`, `break` or `continue` inside `__js__` act on
  the wrapper, not on the surrounding C++ code.

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
│   ├── preprocessor/        # pp-lexer, expression (#if), preprocessor (D-033)
│   ├── lexer/               # lexer.js (pp-tokens -> C++ tokens), literals.js (D-034)
│   ├── parser/              # parser.js, parse-expr.js, parse-stmt.js (D-042)
│   ├── ast/                 # nodes.js (D-040), dump.js (D-042)
│   ├── semantic/            # types, scope, sema, sema-expr, conversions, overload, constant
│   ├── lowering/            # C++ AST -> JS-oriented intermediate representation
│   ├── codegen/             # IR -> JavaScript AST for ES5 / ES6
│   ├── printer/             # Pretty printer and minifier
│   ├── sourcemap/           # Source Map v3 builder, VLQ encoder
│   ├── bundler/             # Combines translation units into one bundle
│   ├── util/                # Shared helpers (int64.js: 64-bit arithmetic)
│   ├── runtime/             # Small JS helpers embedded in the bundle when needed
│   └── stdlib/              # C++ standard library in JS, split per header (D-013)
│       └── platform/        # Context layer: browser, node, mixed (Electron)
├── include/                 # C++ headers shipped with cpp2js (D-033)
├── test/                    # Unit tests (no external test framework)
│   ├── run.js               # Test runner (D-022)
│   ├── fixtures.test.js     # Fixture runner (D-029)
│   ├── harness.js           # test(name, fn) registry
│   ├── tools/               # Test helpers (es5-check.js, D-024)
│   └── fixtures/            # <group>/<name>/: inputs, args, expected* (D-029)
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

- Details to settle when the relevant phase starts: how `std::string` and
  JavaScript strings map onto each other in bindings; lifetime of C++
  lambdas passed as `js::function` callbacks; which Node.js core modules get
  a header first.
