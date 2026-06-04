# Documentation

Everything stitchkit ships in writing — the guide for building with it, and the
records of how it is built.

## For users

Building an app with stitchkit? Start here.

### Guide — [`guide/`](./guide/)

The guide, in reading order:

1. [Getting started](./guide/getting-started.md) — install, entrypoints, a first app.
2. [Contracts](./guide/contracts.md) — every endpoint field, in depth.
3. [HTTP server](./guide/server.md) — `createServer`, hooks, raw routes, primitives.
4. [Typed client](./guide/client.md) — the client, the React data layer, SSE.
5. [MCP & agents](./guide/mcp-and-agents.md) — contracts as AI tools.
6. [CLI](./guide/cli.md) — contracts as a command-line program.
7. [Realtime](./guide/realtime.md) — Socket.IO and the cache bridge.
8. [Auth & errors](./guide/auth-and-errors.md) — scopes, auth hooks, the error model.
9. [Observability](./guide/observability.md) — logging requests and tool calls via hooks.
10. [Testing & deployment](./guide/testing-and-deployment.md).

### API reference — [`api/reference.md`](./api/reference.md)

Every public export, grouped by entrypoint, each linked to the guide.

### At the repo root

- [`README.md`](../README.md) — the overview and quick start.
- [`CHANGELOG.md`](../CHANGELOG.md) — released changes.
- [`ROADMAP.md`](../ROADMAP.md) — where stitchkit is going.
- [`packages/starter`](../packages/starter) — a complete runnable example.

## For contributors

How stitchkit is built and why.

- [`VISION.md`](./VISION.md) — what stitchkit is, its principles, its direction.
- [`decisions/`](./decisions/) — architecture decision records (ADRs) — the **why**.
  One file per ADR. Index: [`decisions/README.md`](./decisions/README.md).
- [`backlog/`](./backlog/) — task tracking — the **what**.
- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — how to build, test and contribute.

### Layout

```
docs/
├── guide/         the user guide — how to build with stitchkit
├── api/           the API reference
├── VISION.md      what stitchkit is, its principles, its direction
├── decisions/     architecture decision records — one file per ADR
└── backlog/       task tracking — the "what"
    ├── inbox/     raw ideas, not yet worked out
    ├── planned/   worked out, has a plan, ready to pick up
    └── done/      completed task records
```

### The backlog flow

```
idea ─▶ inbox/ ─▶ planned/ ─▶ done/
                        │
   architectural decision ─▶ decisions/ (a new ADR file)
   released change        ─▶ CHANGELOG.md (repo root)
```

- **New idea** → a file in `inbox/`. One idea, one file.
- **Worked out, has a plan** → `git mv` it to `planned/`.
- **Being implemented** → it may move to an `in-progress/` folder while active.
- **Finished** → `git mv` to `done/` and add a `## What was done` section.
- **An architectural decision** taken along the way → also a new ADR section in
  `decisions/`.
- **A shipped, user-visible change** → a line in the root `CHANGELOG.md`.

`done/` holds completed task records — from the first release onward it fills
normally as work ships.

### Decisions vs. backlog

- **`decisions/`** records the **why** — architectural decisions, as immutable
  ADRs. An ADR weighs alternatives and explains a choice; once written it is
  not edited, only superseded by a later ADR.
- **`backlog/`** records the **what** — the work pipeline, from idea to done.

Not every completed task is an ADR. A routine task — a bug fix, a small
feature — just lives in `done/`. Write an ADR only when a real architectural
decision was made (a choice between alternatives, with lasting consequences).

See [`decisions/README.md`](./decisions/README.md) for the ADR format and index.

### File conventions

- **One idea, one file.** Don't append to a shared list.
- **Backlog filenames start with a date** — `YYYY-MM-DD-slug.md` — so they sort
  chronologically.
- **Move between stages with `git mv`**, never copy-delete, so history follows.
- **`done/` is immutable** — a completed record is not rewritten.
- Every backlog file opens with frontmatter:

```yaml
---
title: Short title
description: One sentence — what this is and why
type: task
status: inbox | planned | in-progress | done
created: YYYY-MM-DD
updated: YYYY-MM-DD
completed: YYYY-MM-DD   # done only
---
```

ADRs use a lighter header (a `Status` and `Date` line) — see the sections in
`decisions/`.
