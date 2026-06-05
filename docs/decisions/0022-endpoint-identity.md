---
title: "ADR 0022 — Stable (service, action) identity on MethodDef"
type: decision
status: accepted
created: 2026-06-05
updated: 2026-06-05
---

# ADR 0022 — Stable (service, action) identity on MethodDef

- **Status:** Accepted — extends [ADR 0002](0002-generic-core.md) and [ADR 0021](0021-endpoint-meta-passthrough.md)
- **Date:** 2026-06-05

## Context

Per-endpoint audit / observability keys a row on **(service, action)** —
`service` = the contract prefix, `action` = the endpoint key (e.g.
`updatePartial`). A consuming project doing exactly this could not obtain the
pair from stitchkit:

- **`MethodDef` carried no identity.** It has `method` / `path` / `toolName`, but
  no service name and no endpoint key. `implement()` knows both
  (`contract.meta.prefix` + the loop key) and dropped them.
- **Neither is derivable downstream.** `path` (e.g.
  `/tenants/:id/widgets/...`) yields the prefix at best but never the action —
  the endpoint key is not a path segment. `toolName` is absent on HTTP-only
  endpoints.
- **The lifecycle hooks already receive `MethodDef`.** `beforeHandle` /
  `afterHandle` / `onError` take `(ctx, …, endpoint: MethodDef)`. `afterHandle`
  additionally has the handler `result` — so it is the natural home for a rich
  mutation audit (input from `ctx`, output from `result`). The only missing
  piece there was the identity.

## Decision

Add stable, first-class identity to `MethodDef`, populated by `implement()` and
`implementRemote()`:

```ts
serviceName: string;   // = contract prefix (the "service")
key: string;           // = endpoint key   (the "action")
```

- **Required, not optional.** Every `MethodDef` is built by `implement` /
  `implementRemote`, both of which always have both values — so optionality
  would be a false nullability forcing every reader to `?? ''` (a fallback this
  project forbids — Fail First). The two existing in-repo `MethodDef` test
  literals were updated; there are no other construction sites.
- **This is not a domain model.** `serviceName` / `key` are *structural*
  framework facts — the same category as `path`, `method`, `scope` — that the
  framework already computes. Exposing them is "stop discarding identity we
  own," not "model the domain" (ADR 0002 holds).
- A consumer reads them in a hook (cast-free): `endpoint.serviceName`,
  `endpoint.key`.

## Alternatives considered

- **Derive from `path` / `toolName`.** Rejected: `action` is not in the path,
  and `toolName` is absent on HTTP-only endpoints — the pair cannot be recovered.
- **Stamp into `meta`** (the opaque bag from ADR 0021) and read it in a hook.
  Rejected: `meta` is for facts the core *does not* model; (service, action) is
  structural identity the core *does* know — pushing it through `meta` re-creates
  exactly the brittle side-channel ADR 0021 set out to retire.
- **Enrich `createAuditHook`'s `RequestEvent` with (service, action)** (stamp
  into the ALS request-context at dispatch). Deferred: `createAuditHook`'s HTTP
  path is a fetch wrapper decoupled from the dispatcher (ADR 0012) and records
  **no response body** — so a consumer auditing `output` is forced onto
  `afterHandle` anyway, where this ADR's `MethodDef` identity already lands.
  Revisit only if a real consumer needs (service, action) on the
  `createAuditHook` path *without* the handler output.

## Consequences

- Any hook with a `MethodDef` (and tool mounts via `MountableTool.method`) can
  key audit / metrics on `(serviceName, key)` with no `as`, no `meta` stamp, no
  path parsing.
- Additive in spirit, but the fields are **required** — a pre-1.0 change with no
  back-compat shim (consistent with the "no compatibility layer" rule). Only
  internal `MethodDef` literals (two tests) needed updating.
- `implementRemote` now also carries `meta` (it was dropping it) — same line.
- The core still models no domain; it stops throwing away identity it already
  holds.
