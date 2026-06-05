---
title: Observability completeness — endpoint identity on MethodDef + richer RequestEvent
description: A consumer with a rich per-endpoint audit (service+action+output+tenant) could NOT use createAuditHook — RequestEvent has no output, no endpoint identity, no injected ctx fields; and MethodDef in lifecycle hooks has no service/method name. So they fell back to raw afterHandle hooks + stamping identity into meta. Close the gap so the batteries-path covers rich audit.
type: task
status: done
created: 2026-06-05
updated: 2026-06-05
completed: 2026-06-05 02:07
related: docs/decisions/0012-observability-module.md, docs/decisions/0022-endpoint-identity.md
---

# Observability completeness

**Type: DO (code, generic).** Surfaced building a project-level audit during a
consumer's migration. The observability module is great for the generic case but
a rich per-endpoint audit had to bypass it. Pure observability — zero domain.

## Problem

The consumer's audit row carries `service` + `action` + `input` + `output` +
`durationMs` + tenant/actor, project-scoped. Two gaps forced it off the
batteries-path (`createAuditHook`) onto raw hooks + a side-channel:

1. **`MethodDef` has no identity.** Lifecycle hooks get `endpoint: MethodDef`,
   but it carries no service name and no endpoint key — so a hook can't say
   *which* `service.method` ran. Workaround: stamp `auditService`/`auditAction`
   into `endpoint.meta` at startup (a side-channel abuse of the opaque bag).

2. **`RequestEvent` is lossy.** `createAuditHook`'s event has no `output`
   (`responseBytes: 0` on HTTP), no endpoint identity (service/action), and no
   way to pull injected ctx fields (the resolved `tenantId`/`projectId`). So a
   rich, project-scoped audit can't be built from it — the consumer wrote its own
   `afterHandle`/`afterToolCall` + a manual sink instead, duplicating what the
   module exists to do.

## Proposal

```ts
// 1. identity on MethodDef (implement knows both — it builds MethodDef from the
//    contract under a ServiceDef with .name and a keyed methods map).
interface MethodDef {
  serviceName: string   // = ServiceDef.name / contract prefix
  name: string          // the endpoint key
  // ...existing
}

// 2. richer RequestEvent + a way to contribute ctx fields to the audit row.
interface RequestEvent {
  serviceName?: string; action?: string   // from MethodDef
  output?: unknown; resultSize?: number    // already measured for tool calls — also HTTP
  // ...existing
}
// e.g. createAuditHook({ contributeFields: (ctx) => ({ tenantId: ctx.tenantId }) })
//      or setRequestField('tenantId', id) alongside setRequestUser.
```

## Scope — generic only

- ✅ Take: `serviceName`/`name` on `MethodDef`; `serviceName`/`action`/`output`
  on `RequestEvent`; a generic ctx-field contributor for the audit row.
- ✂️ Leave out: what the fields mean. No "tenant"/"project" in core — the
  consumer names what it contributes.
- Supersedes the "MethodDef identity" note in `tool-config-passthrough-gaps.md`.

## Acceptance

- [x] `MethodDef.serviceName` + endpoint key populated by `implement` (+
      `implementRemote`) — **done** as `serviceName` + `key` (named `key`, not
      `name`) in **ADR 0022** (batch #3). Read it in `afterHandle` for a rich audit.
- [x] `RequestEvent` enrichment (`output`/`resultSize`/identity + ctx contributor)
      — **rejected** (3-Opus consensus #3 = "C1 only"): `createAuditHook` does not
      carry output and a rich per-endpoint audit runs through `afterHandle` anyway,
      where `MethodDef` identity (above) + full `ctx` are already in scope. Adding it
      to `RequestEvent` would duplicate that path. → see batch index.
- [x] Tests + `docs/guide/observability.md` — identity covered with ADR 0022
      (batch #3). No `as`.
- [x] `bun run verify` green — 414 tests (no new code this task; Part 1 shipped in #3).

## Что сделано (2026-06-05)

- [x] **Part 1 — endpoint identity → SHIPPED in batch #3 (ADR 0022).**
  `MethodDef.serviceName` + `key` (required), populated by `implement` /
  `implementRemote`; readable in `beforeHandle`/`afterHandle`/`onError` and tool
  mounts. The cast-free way to key a per-endpoint audit. The consumer drops its
  `meta`-stamping workaround.
- [x] **Part 2 — richer `RequestEvent` → REJECTED** (3-Opus consensus, unanimous).
  Rationale: a rich audit (`service`+`action`+`input`+`output`+ctx) belongs in
  `afterHandle` (full `ctx` + `MethodDef` identity present), not `createAuditHook`
  (whose `RequestEvent` has no `output` — `responseBytes: 0` on HTTP). Enriching
  `RequestEvent` would build a second, parallel audit path. Documented as the
  intended pattern rather than adding surface.

**Verdict:** resolved — Part 1 delivered (ADR 0022), Part 2 deliberately not done
(use `afterHandle` + `MethodDef` identity). No further code. Tracked under the
**0.6.0** batch.
