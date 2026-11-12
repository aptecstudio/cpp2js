# AGENTS.md

Operating guide for **AI agents and human contributors** working on `cpp2js`.

This file explains how work on the project is organized, where its state is
recorded, and which rules every contributor must follow. Read it in full
before making any change to the repository.

---

## 1. Purpose of this file

`AGENTS.md` gives AI agents and humans a single, stable reference for:

- the rules that govern changes to the repository;
- where to find the progress made so far and what is still missing;
- where the strategies adopted, and the reasons behind each decision, are
  recorded.

It is the entry point of the project's documentation. The live state of the
project is **not** kept here: it lives in `MEMORY.md` and `ROADMAP.md`
(see section 3).

## 2. Change policy for this file

> **`AGENTS.md` is protected.**

- It was created once, at project initialization.
- It **must not be modified** — not even to fix a typo — unless the project
  owner (the human maintainer) has **explicitly requested and approved** the
  change.
- An agent that believes this file needs to change must **propose** the
  change to the owner and wait for approval. It must never apply it on its
  own initiative.
- Any approved change must be committed on its own, with a commit message
  that states it was approved by the owner.

## 3. State files

The project state is tracked in two files. These are the **only**
documentation files an agent may update on its own initiative to record the
state of the project.

| File         | What it tracks                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `MEMORY.md`  | Decisions taken and their reasons, visual/stylistic traits (CLI output, generated code), source tree structure, syntax and naming conventions. |
| `ROADMAP.md` | Steps already completed and steps still to do, giving both a global and a per-phase view of the project's progress.            |

Rules:

- **Read both files before starting any task.**
- **Update both files at the end of every task** that changes the project:
  - `ROADMAP.md`: tick completed items, add newly discovered items, keep the
    phase status and the overall progress up to date;
  - `MEMORY.md`: record every new decision, with the reason it was taken and
    the alternatives that were discarded.
- Never delete a past decision from `MEMORY.md`. If a decision is reversed,
  mark it as *superseded*, link the new decision and explain why.
- Source code, tests, examples, `README.md` and other technical documentation
  are of course created and updated as part of normal development; the
  restriction above concerns the files that describe the project state.

## 4. Non-negotiable project rules

1. **Language of the implementation**: the transpiler itself is written
   entirely in **JavaScript ES5**, for backward compatibility. No ES2015+
   syntax or built-ins in the transpiler sources (no `let`/`const`, arrow
   functions, classes, template literals, `Map`/`Set`, Promises, modules…).
2. **No external runtime dependencies**: the transpiler and the bundles it
   produces must not depend on third-party libraries or bundlers (webpack,
   rollup, esbuild, Babel, …). Bundling, minification and source map
   generation are implemented in-house.
3. **English everywhere in the repository**: source code, identifiers,
   comments, documentation, commit messages and CLI messages are written in
   English. Chat communication with the project owner is in **Italian only**.
4. **Standard JavaScript conventions**: naming, spacing, comments (JSDoc) and
   general code style follow common JavaScript practice. The exact
   conventions in use are recorded in `MEMORY.md`.
5. **Single branch**: all work happens on `main`. Do not create other
   branches.
6. **License**: the project is released under **GPL-3.0**. Do not add code
   whose license is incompatible with it.

## 5. Workflow for agents

1. Read `AGENTS.md`, then `MEMORY.md` and `ROADMAP.md`.
2. Pick the next item from `ROADMAP.md` (or the one requested by the owner).
3. When a choice is ambiguous or has significant consequences, **ask the
   owner** before proceeding, using interactive multiple-choice questions
   whenever the tooling allows it. Do not guess on decisions that are hard to
   reverse.
4. Implement the change together with its tests.
5. Run the test suite; do not commit with failing tests.
6. Update `ROADMAP.md` and `MEMORY.md`.
7. Commit on `main` with a clear, imperative English message
   (e.g. `Add preprocessor support for #ifdef`).

## 6. Where to find things

| Topic                                      | File          |
| ------------------------------------------ | ------------- |
| What the project is and how to use it      | `README.md`   |
| Rules for contributors and agents          | `AGENTS.md`   |
| Decisions, conventions, code structure     | `MEMORY.md`   |
| Progress and next steps                    | `ROADMAP.md`  |
| License                                    | `LICENSE`     |
