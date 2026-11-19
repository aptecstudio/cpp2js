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

- **Status**: Accepted (owner, 2026-11-19).
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
│   ├── parser/              # Recursive-descent parser -> AST
│   ├── ast/                 # AST node definitions and visitors
│   ├── semantic/            # Scopes, symbols, name lookup, type checker, access control
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
