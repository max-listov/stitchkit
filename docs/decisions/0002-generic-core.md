---
title: "ADR 0002 — A generic core: the framework carries no domain model"
type: decision
status: accepted
created: 2025-05-01
updated: 2026-05-20
---

# ADR 0002 — A generic core: the framework carries no domain model

- **Status:** Accepted
- **Date:** 2025-05

## Context

stitchkit was extracted from several unrelated projects — a chat-bot platform, a
media-generation app, and others. An earlier in-house framework had baked one
project's domain model straight into the core:

- `EndpointScope = 'public' | 'client' | 'bot' | 'admin' | 'project'` — five
  hardcoded scopes, each with its own typed context (`botId`, `projectId`, …).
- `requiredFeature?: PlanFeature` on every endpoint — billing in the core.
- a `Source` enum imported from the database (`EMAIL`, `SCHEDULER`,
  `WEBHOOK`, …) used in the handler context.

None of it transferred. A media app has no bots; another project has no
"projects" in that sense. The domain model was dead weight everywhere but its
origin.

## Decision

The framework carries **no domain model**. Every domain-specific concept is
pushed to the application.

- **Scopes are free strings.** `scope?: string` on an endpoint — any value. The
  application defines what its scopes mean and enforces them in a `beforeHandle`
  hook (see ADR 0004, ADR 0008).
- **No billing in the core.** Plan/feature gates are an application concern.
  An app extends `EndpointDef` with its own fields and checks them in a hook.
- **Transport-only source.** `source: TransportSource = 'http' | 'mcp' |
  'agent'` — where the call physically entered. Application-level origins
  (a scheduler, a webhook) are not the framework's concern.
- **Extensible context.** One `HandlerContext` with `[key: string]: unknown` —
  each app adds its own fields (`userId`, `sessionId`, …) through hooks.

## Consequences

- The framework is reusable across unrelated domains without modification.
- Applications wire identity, scopes and billing themselves — more setup, but
  no framework dictates the domain.
- Type safety for app-specific context is preserved by ADR 0003 and the
  `createImplement<Ctx>()` factory: the app declares its context type once.
