---
title: "ADR 0070 — Scaffold identity is derived from one config"
description: Render one validated application identity and structurally project only the root package name.
type: decision
status: accepted
created: 2026-08-10
updated: 2026-08-10
---

> **Superseded in part by [ADR 0104](0104-the-project-declaration-ships-from-the-framework.md).**
> The single validated config this ADR introduces is still the design; the file
> is now `project.json`, it carries the whole project declaration rather than
> identity alone, and its schema ships from the framework instead of being
> declared per project. Everything below about *deriving* identity from one
> place remains in force.

> **Superseded in part by [ADR 0104](0104-the-project-declaration-ships-from-the-framework.md).**
> The single validated config this ADR introduces is still the design; the file
> is now `project.json`, it carries the whole project declaration rather than
> identity alone, and its schema ships from the framework instead of being
> declared per project. Everything below about *deriving* identity from one
> place remains in force.

# ADR 0070 — Scaffold identity is derived from one config

- **Status:** Accepted — supersedes the no-rewrite clause of
  [ADR 0066](0066-the-starter-template-is-the-development-workspace.md); its
  direct-HMR and disposable-fixture decisions remain active.
- **Date:** 2026-08-10

## Context

A generated application needs its own identity immediately, but global text
replacement is fail-open: a template edit can make a replacement match zero
locations while scaffold still exits successfully. Duplicating the name across
environment files, lock metadata, process configs, UI and documentation also
lets those projections drift.

Some consumers cannot import application code before execution. The root package
manager needs a manifest name, while runtime code can read a validated config.

## Decision

The scaffolder creates one Zod-validated `app.config.json` from the destination
slug and optional display name. Runtime-visible identity derives from that file:
database name generation, PM2 processes, MCP/OpenAPI/CLI metadata, SEO, UI and
theme storage.

The only structural projection is the root `package.json` `name`, addressed by
parsing and validating the manifest. `bun.lock`, environment templates and
README prose are not searched or patched. Generated-product validation rejects
neutral template identity anywhere it must not survive.

## Alternatives rejected

- Keep the neutral identity and require manual rename: a fresh scaffold is not
  a complete generated application.
- Global token replacement: missing matches succeed silently and the inventory
  of required replacements cannot be proven complete.
- Project every identity occurrence structurally: multiplies sources of truth
  even where ordinary imports already provide a compile-time boundary.
- Rewrite inert lockfile metadata: adds a projection Bun neither validates nor
  repairs under frozen installs.

## Consequences

- Renaming `app.config.json` updates every runtime-derived identity in one place.
- Scaffold fails before completion when the one required manifest projection is
  malformed or absent.
- ADR 0066 still owns live template development and disposable generated lanes;
  only its consumer-rename policy is superseded.
