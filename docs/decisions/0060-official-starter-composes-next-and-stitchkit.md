---
title: The official starter composes Next.js and a separate Stitchkit backend
description: Keep frontend rendering and backend transports independently owned while providing one production-shaped scaffold
type: decision
status: active
created: 2026-08-08
updated: 2026-08-08
---

# 0060 — The official starter composes Next.js and a separate Stitchkit backend

## Status

Accepted.

## Context

Stitchkit intentionally does not own frontend routing, rendering, HMR or an
application filesystem. A useful first project still needs those concerns,
plus a database, typed client state and deployable process boundaries. Small
repository demos proved individual transports but did not define a reliable
application bootstrap and drifted outside the release gate.

## Decision

Publish `create-stitchkit` as the only official application scaffolder. It
generates a Bun workspace with a Next.js App Router frontend, a separate
Bun/Stitchkit API, Prisma/PostgreSQL and a browser-safe shared contract package.

Next.js owns rendering and frontend tooling. Stitchkit owns the HTTP, MCP, CLI,
OpenAPI and realtime-connected backend surfaces. The primary API is not hosted
inside Next Route Handlers and no custom Next server is introduced.

The first release has one template. Vite and React Router remain integration
recipes until a real consumer justifies another fully gated template.

## Consequences

- `bun create stitchkit my-app` is the canonical first-run path.
- The generated web and API processes can build and deploy independently.
- The template is tested as a packed external consumer on every release.
- Stitchkit core stays transport-focused and does not become a fullstack
  framework.
- Adding another template requires an equally complete maintenance and
  consumer-test lane.
