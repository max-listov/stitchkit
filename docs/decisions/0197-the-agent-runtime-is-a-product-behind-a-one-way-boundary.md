# 0197 — The agent runtime is a product behind a one-way boundary

**Status:** Accepted
**Date:** 2026-09-23

Read with [ADR 0098](0098-optional-agent-application-runtime.md),
[0111](0111-the-driver-is-the-extension-point-and-the-runtime-is-not-stable-yet.md),
[0142](0142-a-primitive-leaves-the-runtime-when-nothing-in-it-needs-the-runtime.md),
[0182](0182-a-durability-port-exposes-step-sleep-and-wait.md) and
[0187](0187-the-framework-hands-over-what-it-already-knows.md).

## Context

`stitchkit/agent-runtime` and its leaves are about a quarter of the package's
source and most of its breaking changes: the runtime was redefined in 20 of the
38 minors since 0.56.2. The idea the package is built around — one contract,
every surface — lives in a few thousand lines of `contract/`, `server/` and
`tools/`. A reader of the source could not tell where one ends and the other
begins: `tools/` imported a durability type from inside `agent-runtime/`,
`stitchkit/tools` exported the durability engine from an `agent-runtime/` path,
and `stitchkit/testing`, a stable entrypoint, re-exported the runtime's race
driver and store conformance kit.

The obvious remedy is a separate npm package. It was measured and not taken.
The runtime imports about twenty-five internal names from the core — the typed
bridges, the SQLite driver types, the AI SDK adapters, the tool executor, the
trace context. A second package can only import what the first one publishes,
so the split would have made those internals public: the opposite of what the
public-surface budget (ADR 0198) is for.

## Decision

The agent runtime stays in the package as a separate product behind a
**one-way boundary**:

1. **`agent-runtime/` may import the core; the core never imports
   `agent-runtime/`.** Only entrypoint files may. Machinery both need lives in a
   neutral part both import: the durability engine and the event-log vocabulary
   it speaks moved to `src/durability/`.
2. **The boundary is a gate, not a convention.** `tests/import-graph.test.ts`
   declares the direction between every two parts of `src/` and refuses an
   import that is not declared, an import into `agent-runtime/` from the core,
   and any cycle through runtime (not type-only) imports.
3. **Agent tooling lives with the agent.** The race driver and the store
   conformance kit are exported from `stitchkit/agent-runtime/testing` only;
   `stitchkit/testing` imports nothing from the runtime.
4. **Its changes are readable on their own.** Every breaking changelog entry
   leads with the entrypoints it breaks (ADR 0198), so a consumer that imports
   no `stitchkit/agent-runtime*` entrypoint can see what does not concern it.

**When to split physically.** The decision is revisited when either holds: a
consumer that imports no agent-runtime entrypoint is blocked by one of the
runtime's breaking changes, or the internals the runtime depends on have become
public for their own reasons, so that a separate package would publish nothing
new.

## Consequences

- The package keeps one version train. A minor that breaks only the runtime is
  still a minor for everyone; the cost to a contract-only consumer is reading
  entries that name other entrypoints and raising the range.
- The durability engine's home no longer implies it is part of the runtime,
  which is what ADR 0187 promised when it exported the engine from
  `stitchkit/tools`.
- "Nobody outside our own projects uses the runtime" was deliberately not an
  argument here: ADR 0111 retires it for good.
