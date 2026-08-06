---
title: "The published package is tested the way a consumer uses it"
description: Four defects in one day survived 765 tests and were found by a consuming project, because the suite imports from src in-process while everything that broke was about the built artifact and the public surface.
type: task
status: done
created: 2026-08-06
updated: 2026-08-06
completed: 2026-08-06 13:22 +07:00
related: docs/backlog/planned/2026-08-06-a-type-named-in-a-public-signature-is-exported.md
---

# The published package is tested the way a consumer uses it

## The evidence

Four defects landed in one day. The suite was green through all of them; every
one was reported by a consuming project.

| Defect | Fixed in | What was not covered |
|---|---|---|
| `isProd` frozen to a literal by the bundler — the structured log line was unreachable in **every** published copy since the first commit | 0.29.0 | the built artifact |
| The cause of a thrown tool error existed only inside a framework `console.error` | 0.30.0 | reachability from a consumer's hook |
| `ToolCallContext` named in a public signature, exported nowhere | 0.31.0 | the public surface |
| The raw cause reached one hook, the audit row was built in another | 0.32.0 | the API's shape from outside |

None of these are exotic. They are invisible from inside the repository for one
structural reason: **the tests import from `src`, in one process, with access to
everything.** A consumer imports a tarball, through an `exports` map, with only
the public entrypoints and the emitted `.d.ts`.

The project already knows this. `check-browser-clean` and `check-env-live` both
exist, both inspect `dist`, and both were written **after** the burn they now
prevent. That is the tell: there is no mechanism, only one patch per scar.

## Decision

A consumer lane: build, pack, install the tarball into a throwaway fixture app,
and exercise it the way a consuming project does — public entrypoints only,
type-checked against the emitted declarations, then run.

```
packages/core/scripts/consumer-lane/
├── run.mjs           pack → temp dir → install → tsc → run
└── fixture/
    ├── package.json  depends on the packed tarball, nothing else
    ├── tsconfig.json strict, same as a consumer would write
    └── src/app.ts    imports from 'stitchkit', '/server', '/tools', '/node',
                      '/observability', '/contract', '/cli', '/react'
```

What the fixture must do, because these are the failure modes actually observed:

- **Name types, not just call functions.** A missing export is a *type* error, so
  the fixture must annotate: `const hooks: ToolCallHooks = {…}`, and one explicit
  annotation for every options / return type of every exported function. That is
  what turns "the type exists in `src`" into "the type is reachable".
- **Run a request end to end and assert on the log output**, with
  `logging: { format: 'json' }` and again with the default under a mutated
  `NODE_ENV`. The frozen-`isProd` defect is only visible when the *built* code
  reads the environment at run time.
- **Call a tool through a real mount and make its handler throw**, asserting that
  `onToolError` fires and that `afterToolCall` gets the raw value. This is the
  0.30/0.32 surface, and it is exactly the part a `src` test cannot vouch for.
- **Import from the entrypoints only.** No deep `stitchkit/dist/...` path — if
  the fixture needs one, the `exports` map is wrong and that is the finding.

`check-browser-clean` and `check-env-live` stay. They are cheap, precise, and
name their defect in one line; the consumer lane is the net that catches the
next one nobody has thought of yet.

## Where it runs — measured, then decided

Measured before writing anything, because the whole shape hung on it. Warm
cache, this machine:

| Step | Cost |
|---|---|
| `npm pack` | 1056 ms |
| **`bun pm pack`** | **61 ms** — and the file list is byte-for-byte the same 205 entries, verified by diff, so the artifact under test is still the one that ships |
| install, minimal (stitchkit + zod) | 127 ms |
| install, full (+ optional peers) | 631 ms |
| typecheck a fixture | ~1.0–1.2 s |
| declaration check (`skipLibCheck: false`) | 1.6–3.9 s |

**Total 8.0–8.4 s**, under the 15 s bar, so it goes into `verify` — which was the
point: the frozen-`NODE_ENV` defect shipped because nothing *local* could see it.

## Where it runs — decided

`npm pack` + install costs seconds, and `bun run verify` is the pre-push gate
that must stay fast enough to actually be run.

- **Recommended:** in `verify`, if the whole lane stays under ~15s. The
  `isProd` defect shipped because nothing local could see it; a check that only
  runs in CI still catches it before publish, but a check that runs before push
  catches it before the commit is written.
- **Fallback:** a separate `verify:consumer`, wired into the release workflow
  ahead of `npm publish`, and named in `CONTRIBUTING.md` as required before a
  release commit.

Measure first, then choose. Do not guess the cost.

## Acceptance

- [x] `packages/core/scripts/consumer-lane/` — pack, install into a temp
      fixture, `tsc --strict` the fixture, run it; non-zero exit on any failure
- [x] The fixture imports **only** published entrypoints and annotates every
      options / return type it touches
- [x] It asserts the JSON log line is produced from the **built** package, and
      that the default format follows `NODE_ENV` read at run time
- [x] It exercises a throwing tool handler through a real mount and asserts both
      `onToolError` and `afterToolCall`'s raw value — and chains the real
      `createAuditHook`, so the audit row is checked from outside too
- [x] Wired into `verify` (8.4 s, measured) plus a CI step, and documented in
      `CONTRIBUTING.md`, `AGENTS.md`
- [x] Retro-check: all four defects reverted one at a time, lane fails on each —
      see below
- [x] Temp directories are cleaned up on success, kept and printed on failure;
      nothing is written into the repo

## Retro-check — the lane was watched failing, four times

A guard nobody has seen fail is a guess. Each defect was reintroduced, the
package rebuilt, the lane run, then reverted.

| Reintroduced | Lane says |
|---|---|
| The environment read frozen at import (`const RETRO_FROZEN = …`) | `✗ NODE_ENV=production defaults to one structured line`, `✗ the environment is read at run time, not folded at build time` |
| `onToolError` not fired from the `catch` | `✗ onToolError fired once 0`, `✗ it received the value as thrown` |
| `ToolCallContext` dropped from `stitchkit/tools` | `does not typecheck for a consumer — Module '"stitchkit/tools"' has no exported member 'ToolCallContext'` |
| The raw value not passed to `afterToolCall` | `✗ the failed call carried the raw value`, `✗ and it names the cause instead of the placeholder` |

**The first one matters most.** That variant keeps the literal string `NODE_ENV`
in `dist`, so `check-env-live` — the guard written for exactly this defect —
passes it. The lane catches it anyway, because it asserts the *behaviour* (the
same handler answering differently after the environment changes) rather than the
presence of a token. That is the difference between a scar and a net.

## Found on the way: the declarations do not stand alone

With `skipLibCheck: false` on a minimal install, the emitted declarations
reference six things a consumer cannot resolve — `Bun`, `bun`, `node:http`,
`socket.io`, `@socket.io/bun-engine`, `@socket.io/component-emitter`. Every one
is an **optional** peer, and `skipLibCheck: true` (the near-universal default,
and what the strict pass of the lane uses) never looks. Worth knowing:
`server/create.d.ts` and `server/types.d.ts` name the `Bun` namespace on the core
path, not only in the socket-io files — a Node-only consumer with `skipLibCheck`
off needs `@types/bun` today.

Not fixed here, and deliberately not silently accepted either: the list is
`ACCEPTED_UNRESOLVED` in `run.mjs`, and a **new** name fails the lane. Whether
the core path should stop naming `Bun` at all is an ADR 0013 question and belongs
in its own task.

## Что сделано

**Лейн** — `packages/core/scripts/consumer-lane/`

- [x] `run.mjs` — `bun pm pack` → temp dir → per-fixture install → strict
      typecheck (must pass) → declaration check (allowlisted) → run; per-step
      timings printed so the "does it still fit in `verify`" question stays
      answered
- [x] `fixtures/minimal` — stitchkit + zod only, `types: []` (so an ambient-type
      dependency of the package shows up rather than hiding behind the fixture's
      own tsconfig), 10 runtime checks
- [x] `fixtures/full` — plus `@modelcontextprotocol/sdk` and `ai`; the tool
      surface through `mountAgent`, 12 runtime checks including the audit row

**Разводка**

- [x] `consumer-lane` script in both package.json files; appended to `verify`
- [x] A CI step after the Node smoke, with a comment saying what it is for
- [x] `CONTRIBUTING.md` — a section explaining the gap it covers and the rule for
      new public API ("name its types in a fixture")
- [x] `AGENTS.md` — the gate line

## Не делалось

- [x] Running the fixtures under **Node** as well as Bun — `smoke:node` still
      covers Node imports, though from `dist` rather than an installed package.
      Folding the two together would remove a half-measure and roughly double the
      lane; left as a follow-up rather than doubling the gate on the first day
- [x] One fixture per entrypoint — the split by **peer requirement** turned out
      to be the axis that finds things (it is what proved the core path needs no
      optional peer). Per-entrypoint would mostly re-prove the `exports` map
- [x] Fixing the `Bun`-in-declarations finding — recorded above, needs its own
      decision against ADR 0013
