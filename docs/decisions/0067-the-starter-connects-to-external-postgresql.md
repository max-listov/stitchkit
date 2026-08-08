---
title: The starter connects to external PostgreSQL
description: Keep database process ownership outside generated applications while retaining Prisma schemas and migrations
type: decision
status: active
created: 2026-08-08
updated: 2026-08-08
---

# 0067 — The starter connects to external PostgreSQL

## Status

Accepted. Refines ADR 0060 and ADR 0066.

## Context

The official starter is meant to model the same process boundaries as a real
application. Its first implementation also owned a local PostgreSQL container
and made development depend on a container runtime. That coupled application
code to one infrastructure provisioner and put release-lane isolation inside
the product being tested.

## Decision

The generated application owns its Prisma schema, checked-in migrations and
database access code. The environment owns PostgreSQL and provides exactly one
connection boundary: `DATABASE_URL`.

Direct development applies checked-in migrations before launching the PM2
processes. Production does the same through its deployment command. The starter
does not ship a Compose definition, container commands, SQLite fallback or a
second database mode.

Packed target and HEAD lanes provision uniquely named PostgreSQL databases in
repository-owned test infrastructure, pass their URLs to generated consumers
and drop both database and role after the lane finishes.

## Consequences

- Local, remote and managed PostgreSQL use the same application configuration.
- Adopting the starter does not add a container-runtime dependency.
- Database lifecycle remains an explicit deployment concern rather than hidden
  application bootstrap logic.
- Release tests retain isolation without changing what the scaffolder publishes.
