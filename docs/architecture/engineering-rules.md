---
title: Engineering rules — the reasoning behind the review rules
description: Why casts are a counted review rule, why every declared option must prove its effect, why runtime globals are verified against real packages, when a runtime internal is published and why an ADR may record a practice.
type: architecture
status: active
created: 2026-09-23
updated: 2026-11-24
---

# Engineering rules — the reasoning behind the review rules

[`AGENTS.md`](../../AGENTS.md) states each rule in one line. Where no ADR already carries the
reasoning, it lives here. The invariants these rules serve are in
[`PRINCIPLES.md`](../PRINCIPLES.md).

## Casts are a boundary, and a count

A cast that ships is a **boundary**, never business logic:

- the loose↔typed bridges in `internal/typed.ts`;
- `executableAgentRuntimeTools` in `tools/runtime-tool.ts`, which validates the executable
  functions of a peer-free runtime tool declaration and then restores the richer internal
  definition — the checks before the cast are what make it true;
- adapters over untyped external emitters (Socket.IO, the event bus, the cache bridge);
- the generic bridges in `browser/client.ts`, where a scoped client surface is rebuilt from a wider
  one.

Each carries a comment saying why. A new cast anywhere else means the types are broken upstream;
fix them there. The design that removed the request path's casts is
[ADR 0003](../decisions/0003-two-context-types.md): `RuntimeContext` is loose and honest,
`HandlerContext` is typed, and `implement()` is the bridge.

Nothing enforces this mechanically — it is a review rule over a small, countable set, not a gate:
47 `AsExpression` nodes in `packages/core/src` on 2026-09-06, counted by the TypeScript AST with
`as const` excluded (a text search over-counts comments and strings). A rising count is a review
question.

## A declared option is load-bearing, and proven

A typed option that is accepted and then not honoured on some path is this repository's most
repeated defect — six shipped instances, four of them in three releases: `transports: ['websocket']`
did not refuse polling, a route group's `onError` was never dispatched, `managedServerResource`
never started the server it was handed a thunk for, `bindProcessSignals` substituted schema
defaults over the application's declared budget. Every one of them typechecked, because a type
proves an option can be **passed** and says nothing about whether passing it changes anything.

`packages/core/tests/option-effects.test.ts` enumerates the members of the covered configuration
types through the TypeScript checker and refuses one with no registered test; the registry names a
real test, so it cannot drift into a list of claims. It proves a named test *claims* the option,
not that the test is good — the same contract `reference-coverage` has. Covered surfaces are chosen
by failure mode: a wrong `port` fails loudly on the first request, an unenforced allowlist looks
exactly like success. The same defect one level out — a scanning gate — is
[ADR 0146](../decisions/0146-a-scanning-gate-asserts-what-it-scanned.md). Invariant I9.

## A discovered schema is not the authored one

A command reaches a surface from three origins: a native definition, a contract, and a tool discovered
from a server. The first two hand the framework the Zod schema an author wrote. The third hands it a
served JSON Schema document, which `zodObjectFromJsonSchema` reads into Zod and `toJsonSchema` writes
back for help, `--schema`, tool lists and manifests. Zod is not lossless on that trip: a `format` beside
a `pattern` is restored as `z.uuid().regex(p)` and written as two patterns and no name, and a format its
reader has no check for is dropped.

A release taught CLI help to print a string's format and proved it on an authored `z.uuid()`. A project
whose every command is discovered saw no change: by the time its schema reached help, the name was gone.
The loss had been noticed during that work and written into the guide as a property of composed
patterns. Two rules follow.

- A rule about how a schema, metadata, or result is shown is proven through the shared test
  factories rather than a single authored path:
  `packages/core/tests/support/operation-origins.ts` parameterizes across every origin (`native`,
  `contract`, `discovered-openapi`, `discovered-mcp`, `managed-cli-catalog`), and
  `packages/core/tests/support/operation-transports.ts` parameterizes across every result transport
  (`agent`, raw wire `mcp-content`, `mcp-structured`, `cli`). A test that hands the printer an
  authored schema proves the printer, not the path a discovered schema or wire envelope takes to it.
- A keyword that does not survive from the served document to the written one is fixed where it is lost:
  at the read boundary (`withServedFormats`) or in the one conversion (`keepFormatName`).
  `packages/core/tests/json-schema-string-format.test.ts` holds the invariant — a document a stitchkit
  server serves reads back as it was served. A caveat in the guide is not a third option.
- The same rule applies across exported CLI helpers: `stitchkit/cli` exposes `extractCliGlobalOptions`,
  `scanCliInvocation`, `routeCliArgv`, `parseCliArgs`, `createCli`, and `createCliInvoker` as separate
  entry points over the same CLI grammar. A flag or parser change proven only on `createCli` leaves sibling
  helpers able to diverge silently, so regression tests cover every affected exported helper and schema
  projection.

## Verify target-runtime globals against real packages

A portable entrypoint such as `stitchkit/handler` runs inside target realms — React Native / Hermes, Node,
and browsers — whose global object differs from Bun's. Testing a realm against hand-written assumptions
about what globals exist proves the assumption, not the target: a synthetic polyfill for `DOMException`,
`Buffer`, or `URL` can make a test harness pass while the real runtime throws on the first call, or mask a
missing host primitive the core actually depends on.

Realm proofs (`packages/core/tests/rn-realm/`) and packed consumer proofs
(`packages/core/scripts/consumer-lane/fixtures/minimal/src/handler-hermes*`) therefore verify target
globals against real installed packages and runtime binaries on disk, include a negative control that proves
forbidden host APIs fail inside the target realm, and share one source of truth for any target-provided
helper rather than maintaining divergent copies.

## A runtime internal is published only when it cannot be otherwise

A primitive leaves `agent-runtime` for an application that drives the model itself only when it
needs no store, needs no run protocol, and already exists inside proven by tests — and it must be
typed against what the caller already holds, because a symbol can be public while the thing it
does is still behind the store (`selectAgentHistory` was exported for months and unreachable in
practice). A rule that cannot refuse is not a rule: the two named refusals are a context-pressure
ratio and a model → context-window catalog, both of which consuming applications hand-write and
neither of which we will own. The full judgement table is
[ADR 0142](../decisions/0142-a-primitive-leaves-the-runtime-when-nothing-in-it-needs-the-runtime.md).

## The bar for an ADR is lower than "architecture"

This repository tracks decisions, not tasks, so an ADR is the **only** durable record of why the
code looks the way it does — and the bar for writing one is therefore lower than "architecture".
**An ADR may record a practice or an incident**, not just a design: ADR 0011 describes a release
arrangement that has since been replaced and is kept as history, and the release protocol
([`release-process.md`](./release-process.md)) is mostly scar tissue from runs that went wrong. If a
change teaches something a future reader would otherwise relearn the expensive way, that lesson has
nowhere else to live — write the ADR. What does *not* earn one is unchanged: a bug fix or a small
addition is a changelog line.

Every row of the ADR index names the invariant it serves, or is marked `P` (a practice or incident
record) or superseded; `scripts/decisions-index.test.ts` holds it.
