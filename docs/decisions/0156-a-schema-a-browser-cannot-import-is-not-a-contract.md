---
title: A schema a browser cannot import is not a contract
description: The application schemas ship as their own entrypoint because the server runtime beside them breaks a client bundle at module init, and the gate now refuses a browser-safe module that no export path reaches.
type: decision
status: active
created: 2026-09-03
updated: 2026-09-03
---

# 0156 — A schema a browser cannot import is not a contract

## Decision

The canonical application records ship as `stitchkit/application/schemas`, an
entrypoint with no server runtime behind it. The same names remain reachable from
`stitchkit/application`, which re-exports the module — one list, two entrypoints.

## The failure this fixes

`stitchkit/application` is the server runtime: it reaches `node:child_process`,
`node:fs`, `node:crypto`, and `diagnostic-journal-lock.ts` runs
`promisify(execFile)` at module top level.

A browser bundler does not omit a Node built-in — it substitutes a stub. So the
failure is not at the call, it is at **module initialisation**:

```
Uncaught TypeError: (0 , import_browser_external_node_util.promisify) is not a function
```

The application does not mount. Not the route that wanted the schema — any
route, because the module is in the graph.

This was reported by a consumer, and the report is the argument. A contract's
`output` may naturally be an application snapshot, and a contract is supposed to
serve both sides: the server that implements it and the typed client that calls
it. A schema the contract may return and the client physically cannot import is
the framework failing at the one thing it exists for.

## Why a second entrypoint rather than making `./application` browser-safe

> **Corrected in 0.78.0 — see [ADR 0157](0157-a-restartable-resource-begins-a-generation.md)
> and the note at the end of this section.** The reasoning below was wrong on a
> fact, and the fix that followed from it treated a symptom.

`stitchkit/application` is a server entrypoint by design — a kernel, an
admission gate, a diagnostic journal that takes a file lock. Making it
browser-safe would mean lazy-loading its own runtime to protect importers who
do not want it.

**That last sentence was false, and one command would have shown it.** Of the 18
relative imports in `application.ts`, exactly **one** reached `node:`:
`export { createDiagnosticJournal }`. The kernel, admission, schedules,
keyspaces and every schema were already clean. There was no runtime to lazy-load
— there was one line to move.

So 0.78.0 moved it to `stitchkit/application/diagnostic-journal`, and the whole
barrel became browser-safe: 39 schemas and 8 error classes that this ADR left
stranded, including the entire `DiagnosticJournal*Schema` family out of a
node-free file named `diagnostic-journal-contract.ts`.

`stitchkit/application/schemas` stays. It is no longer the *only* way to reach
those schemas, but it is still the honest minimal one — the schemas without the
kernel — and it had already shipped.

The lesson is not about entrypoints. This ADR reasoned from the shape of the
module ("it is a server entrypoint by design") when the question was empirical
and cheap, and it fixed the ten names the reporter happened to name instead of
the cause. The report was right about the class and this ADR narrowed it to the
instance.

A symbol reachable from two entrypoints is this package's existing convention,
not an alias: 108 names already sit in more than one entry barrel. An alias is a
second *name* for one thing. This is one name, one definition, and a barrel that
carries a subset.

## The gate that would have caught it

`dist/application/schemas.js` already existed, node-free, before this change. It
was unreachable: no `exports` path led to it. `check-browser-clean.mjs` proved
the browser lane carried no Node built-in and had nothing to say about a module
built for the browser that nobody can import.

It now says both, and it reads its entry list **out of the `build:browser`
script** rather than restating it. A hand-kept copy of that list is a second
source of truth whose failure mode is silence: an entry added to the build and
forgotten in the gate is simply never scanned. A derivation has its own failure
mode — returning nothing — so an empty list is a hard failure rather than a
green run over no entries.

## Consequences

- Adding a browser-safe entrypoint is now three coordinated edits (`build:browser`,
  `exports`, the entrypoint registries), and the gate fails until they agree.
- The gate proves the **built artifact**, so an unused Node import that the
  bundler shakes out is correctly not a failure. That is what makes it a
  statement about what ships rather than about what the source says.
