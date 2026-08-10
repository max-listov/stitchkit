---
title: Single generated application identity
description: Derive runtime branding and process identity from one validated config populated from the scaffold destination.
type: task
status: done
created: 2026-08-10
updated: 2026-08-10
completed: 2026-08-10 13:39 +07:00
---

## Зачем

Adopting the template currently requires changing independent literals for the root
package, PM2 processes, MCP server info, OpenAPI info, CLI metadata, SEO, theme
storage and visible copy. This is easy to miss and makes a generated product retain
starter identity in operational or public surfaces.

## Результат

The destination name establishes a valid application slug during scaffolding, and
one application-owned identity config drives every runtime and presentation surface
that needs the product name or slug.

## План

- [x] Define a small runtime-validated identity model for `slug`, display `name` and localized/default description without inventing domain roles or categories.
- [x] Derive the initial slug from the destination basename, validate it before filesystem mutation and derive a readable initial display name deterministically.
- [x] Store identity in one format consumable by TypeScript and PM2 config without duplicating literals.
- [x] Derive root package name, PM2 app names, MCP server info, OpenAPI title, CLI name, SEO site name and theme storage key from the canonical identity where their constraints allow it.
- [x] Keep package workspace aliases such as `@app/*` stable unless changing them produces a demonstrated benefit.
- [x] Provide one documented edit point for later renaming and fail first on an invalid slug.
- [x] Add scaffold and generated-runtime tests covering a hyphenated destination and a custom display name.

## Acceptance

- [x] A project generated into `talk-control` contains no operational `stitchkit-starter` identity outside framework attribution and documentation examples.
- [x] PM2, MCP, OpenAPI, CLI, SEO and theme persistence resolve to the same application slug/name.
- [x] Renaming through the canonical config does not require a repository-wide search.
- [x] Invalid package/process/server names are rejected with an actionable error before files are written.
- [x] No second identity registry or compatibility alias is introduced.

## Что сделано

- [x] Scaffold boundary: `packages/create-stitchkit/src/identity.ts` validates destination-derived identity before writing files.
- [x] Canonical source: generated `app.config.json` is runtime-validated by `packages/create-stitchkit/template/packages/config/src/identity.ts`.
- [x] Consumers: PM2, MCP, OpenAPI, CLI, SEO and theme storage derive from that single config.
- [x] Tests: scaffolder and packed runtime lanes cover hyphenated slug, custom display name and invalid identity diagnostics.
