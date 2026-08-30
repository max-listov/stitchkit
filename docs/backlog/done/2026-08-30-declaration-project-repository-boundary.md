---
title: Clarify declaration identity versus product project membership
description: Keep repository-local build declarations distinct from many-to-many product membership and private working context.
type: task
status: done
completed: 2026-08-30
created: 2026-08-30
updated: 2026-08-30
---

## Зачем

The optional `stitchkit/declaration` leaf describes repository-local source, roles, build and
release requirements. Its `ProjectDeclarationSchema.identity` is singular, while its guide and
source comments alternate between “project” and “repository” without defining the identity boundary.
This is a terminology gap, not evidence that the runtime enforces product/repository 1:1 membership.

Evidence: `packages/core/src/declaration.ts` (`ProjectIdentitySchema`, `RepositoryPathSchema`,
`ProjectDeclarationSchema`), `docs/guide/declaration.md` and `docs/api/reference.md` declaration
section. The TUI independently accepts a workspace and conversation ID in
`packages/tui/src/config.ts`; `packages/tui/src/session.ts` identifies a local runtime session,
not a product project. No audited API requires private companion metadata in source declarations.

## Результат

- Product project, repository, checkout and harness workspace have explicit distinct meanings.
- One product can include several repositories, and one repository can serve several products;
  dependency or checkout placement never creates membership implicitly.
- Repository-local paths and build identity remain valid without a product registry or declaration.
- Private working context and companion relationships stay in an authorized external registry;
  generic source is not made to carry consumer identities or private paths.

## Approved scope decision

The current release mandate includes this clarification. Existing identity names the repository-local
buildable source/artifact, not a product membership or checkout. Document explicit external M:N
membership with generic examples. No product registry, export rename, schema version change or
executable behavior change is needed. External registries own visibility and access policy.

## Acceptance

- [x] Agree whether the existing declaration is repository/artifact identity or explicit product
      context, and document the ownership of any external membership relation.
- [x] Align guide, source comments and API reference without requiring private metadata.
- [x] Demonstrate M:N usage with generic examples and keep declaration optionality intact.

## Что сделано

- `docs/guide/declaration.md` defines all four identities and shows two generic products sharing
  one library repository without changing that repository's declaration.
- `packages/core/src/declaration.ts`, `docs/api/reference.md` and `docs/VISION.md` use the same
  repository/artifact boundary. The schema, version and exports are unchanged.
- `packages/core/tests/project-declaration.test.ts`: `no other framework module imports the
  declaration schema`, `nothing in the framework reads a project.json` and `a declaration is parsed
  only when a caller hands one over` passed. The existing refusal matrix remains green.
- Focused multipart/declaration run: 144 tests, 0 failures, 226 assertions. Repository typecheck passed.

Publication travels with the core `0.70.2` target in `release-train.json`; the task is documentation
clarification, not a claim that an unpublished local build already exists in the registry.

## Audit limits

Bounded source/doc inspection only; no external registry, companion repository, runtime deployment,
Git history or comprehensive secret scan was checked. No global configuration was changed.
