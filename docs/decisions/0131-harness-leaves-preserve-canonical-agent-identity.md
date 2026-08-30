---
title: "ADR 0131: Harness leaves preserve canonical Agent identity"
description: "Lazy resources, approvals, control views and coding artifacts compose the existing runtime without a gateway, second history or process supervisor."
type: decision
status: accepted
created: 2026-08-30
updated: 2026-08-30
---

# ADR 0131 — Harness leaves preserve canonical Agent identity

## Context

A useful coding harness needs progressive skill discovery, human approval, reconnectable control,
bounded large output and guarded file changes. A generic command gateway would replace the real
operation identity. Eager skills/output waste context, while a second session database or
optimistic UI history would compete with the canonical Agent store.

## Decision

Keep the existing entrypoint split. `stitchkit/agent-runtime/harness` owns optional resource and
control composition over one `createAgentRuntime`; `stitchkit/agent-runtime/coding-tools` owns
peer-free host-authorized coding operations; `stitchkit/agent-runtime/browser` owns schemas,
multi-conversation cursors and a pure view reducer. There is no integrated god factory.

Filesystem resources use caller-declared absolute roots and public root IDs. One contained,
symlink-refusing walker supplies deterministic relative paths. Instructions are eager; skills and
ordinary resources contribute bounded summaries until the direct `harness_read_resource` operation
reads one exact name. Provenance is `rootId:relative/path`, never an absolute host path.

Tool approval uses the AI SDK signed two-turn protocol. Request and response are canonical message
parts. A request terminates its run before the effect; an exact tool-role response is a new durable
admission and queued successor. The SDK validates the signature against approval ID, tool call ID,
direct tool name and input before the existing fenced executor runs. Pending state is derived from
durable messages. No remembered policy or stronger cross-crash exactly-once promise is added.

Control connections attach as observers or one exclusive controller per conversation. Connection
close detaches; it cannot close the harness. Durable versions are tracked per conversation and
transient `(runtimeEpoch, sequence)` positions per run. A gap requires canonical resync. The reducer
owns no UI; the server owns no transport, authentication or durable session catalog.

Large shell output may use a host-provided opaque artifact store. Small output remains inline;
large output retains a bounded preview and direct bounded read. Workspace search and single-file
patch remain named operations. A patch binds one file to a SHA-256 base, supports dry-run,
authorizes the exact change and applies by same-directory atomic replacement. Multi-file atomicity
and PTY/background process supervision are not claimed.

Failed assistant evidence is off by default. One explicit evidence policy opts a marked partial
failed turn into projection, context budgeting and compaction together.

## Consequences

- Low-level `mountAgent`, `createAgentRuntime` and custom resource loaders remain independent.
- Direct operations keep lifecycle, presenter, observability, fence and durable identity.
- Browser, terminal and remote clients can share one view contract without sharing a renderer.
- Trust, artifact retention, authorization, transport security, process placement and external
  effect idempotency remain visible host responsibilities.
- Interactive process sessions stay deferred until independent consumers prove one portable
  lifecycle for Bun and Node.
