---
title: "ADR 0040 — The log format is chosen, not guessed"
type: decision
status: accepted
created: 2026-08-06
updated: 2026-08-06
---

# ADR 0040 — The log format is chosen, not guessed

- **Status:** Accepted — repairs the delivery of
  [ADR 0039](0039-request-logging-reads-the-request-context.md); upholds
  [ADR 0013](0013-runtime-agnostic-core.md)
- **Date:** 2026-08-06

## Context

The built-in logger picked its output shape from the ambient environment:

```ts
const isProd = process.env.NODE_ENV === 'production';
```

A consuming project found that the published package contains
`var isProd = false` as a **literal**. The bundler constant-folds
`process.env.NODE_ENV` at build time — and for a library that is *this
package's* build, not the consumer's. Every install was therefore frozen into
`pretty`, and the structured line was unreachable for everyone. The line had
been written that way since the first commit, so the JSON output had never once
worked outside this repository's own tests, which run from source.

ADR 0039 had just shipped request-context identity and `enrich` **into that
unreachable branch**, and the guide told readers to verify with
`NODE_ENV=production` — advice that could not work. A consumer trying it added
`NODE_ENV=production` to their own build script, which does not help and quietly
freezes *their* application code the same way.

Two failures, not one:

1. **Mechanical.** A literal `process.env.NODE_ENV` is folded even inside a
   function body — laziness alone does not fix it. Only an indirection survives
   (`const env = process.env; env.NODE_ENV`), which a probe confirmed against
   the real build command.
2. **Design.** A library guessing its output shape from an ambient variable is
   wrong regardless of bundlers. Nothing in `logging: true` says which shape you
   get; `NODE_ENV` is set by a process manager, a container, a CI runner, and
   means different things in different stacks; and the variable silently
   conflated two orthogonal decisions — *how* a line is formatted, and *whether*
   the arrival breadcrumb is printed at all.

## Decision

**The consumer chooses: `logging.format: 'pretty' | 'json'`.** Set, it decides,
and the environment is not consulted at all.

**Unset, the environment is the default, read per request** — `json` under
`production`, `pretty` otherwise, through a variable indirection so no build can
fold it. The convenience of "colours locally, records in production with no
configuration" is real and worth keeping; what is not acceptable is that it be
the *only* path, invisible, and decided by the wrong build.

**`format` governs the built-in formatter only.** A custom `logger` is a sink,
not a format: it always receives the structured object, in every environment.
This removes a second piece of implicit behaviour — previously a sink and the
built-in formatter disagreed about what a "log line" was depending on ambient
state.

**The arrival breadcrumb follows the format, and that is documented rather than
implied.** `pretty` prints `→` so a hanging request is visible before it
finishes; `json` does not, because a record store wants one row per completed
request, not half of one. If the two ever need to be separated, that is a second
option and a deliberate decision — not a side effect of a shared flag.

**A build guard makes the mechanical failure impossible to ship again.**
`scripts/check-env-live.mjs` scans the built dist and fails the build unless the
string `NODE_ENV` still appears in it: if the read survived it is there, if it
was folded it is gone. It runs in `build`, next to `check-browser-clean.mjs`,
which exists for the same reason — a defect visible only in the artifact.

## Consequences

- The structured line becomes reachable for the first time. Everything ADR 0039
  added to it — identity, `dimensions`, `enrich` — starts working for consumers,
  who until now could only get it through a custom `logger`.
- `format: 'json'` makes that output testable locally. The guide can stop
  advising an environment change that never worked.
- A consumer who wants colours in production, or records in development, simply
  says so.
- Tests cover both formats directly and assert that one handler follows a change
  of `NODE_ENV` between requests — the property whose absence let the freeze
  ship unnoticed.

## Alternatives considered

- **Only fix the fold, keep guessing.** The peer report proposed evaluating
  lazily. Necessary but insufficient: a lazy function is folded just the same,
  and it would leave the design smell in place — the output shape still decided
  by a variable nobody configured.
- **Drop the environment entirely; default to `pretty` always.** Honest and
  magic-free, but someone deploys and silently ships colour codes into a log
  aggregator forever. The failure is quiet and the blast radius is production.
- **Default to `json` always.** Symmetrically quiet in the other direction, and
  it makes the first local run worse for every new user.
- **A separate option for the arrival breadcrumb.** Deferred, not rejected: no
  reported need, and inventing a second knob now would be exactly the kind of
  unrequested surface this project avoids. The coupling is documented, so a
  future need is a clean addition rather than a correction.
