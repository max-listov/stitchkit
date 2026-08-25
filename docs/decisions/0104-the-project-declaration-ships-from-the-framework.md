---
title: "ADR 0104: The project declaration ships from the framework"
description: "One versioned Zod schema for what a repository says about itself, published as an entrypoint rather than copied into every project, with a boundary rule that keeps deployment values out of it."
type: decision
status: accepted
created: 2026-08-24
updated: 2026-08-24
---

# ADR 0104 — The project declaration ships from the framework

## Context

An application repository makes statements about itself that are not code: what
it is called, what roles it runs, what it needs before it starts, which
environment variables it expects. Today the starter template says some of this
in `app.config.json`, some in two hand-written process files, and some in a Zod
environment schema — three places, no single reader.

The moment that becomes a contract rather than a convention is when something
*outside* the repository reads it: a tool that builds a source into an artifact
and binds that artifact into a deployment. That reader is not the project and not the scaffolder, and it
cannot be assumed to sit in the same tree.

The schema therefore has at least three readers that must never disagree:

1. the repository, which fills the declaration in and consumes it at runtime;
2. the scaffolder, which writes the first copy;
3. whatever builds a source and binds the artifact into a deployment.

In this repository the schema was already duplicated between (1) and (2) —
`ApplicationIdentitySchema` existed verbatim in `packages/create-stitchkit/src/`
and in the template's `packages/config/src/`. Four fields made the duplication
cheap; roles, requirements and environment do not.

## Decision

The project declaration schema ships **from the framework** as
`stitchkit/declaration`, and no reader keeps a copy of it.

Three properties make that a contract rather than a shared file:

- **It is versioned.** `PROJECT_DECLARATION_SCHEMA_VERSION` is part of the
  declaration, and `parseProjectDeclaration` checks it *before* reading any
  field. A reader that does not recognise the version refuses the repository.
- **Refusal is fail-closed.** An unrecognised version is never assumed
  compatible. A partially understood declaration is the single failure mode that
  produces a running, wrong deployment instead of an error, and it is the one
  outcome the version field exists to make impossible.
- **A project narrows, never restates.** A project that speaks exactly two
  locales extends the shipped schema; it does not write its own copy of the
  other fields.

The schema carries a boundary rule, and the rule is the load-bearing part:

> A declaration must be complete and meaningful **when no machine exists**. A
> field that cannot be filled in without knowing where the code will run is a
> binding supplied by the deployment, not a declaration made by the repository.

So ports, hosts, absolute URLs, connection strings, machine paths, routing
shape, supervision policy and secrets are never values in a declaration. A
binding may be *named* — by the variable that will carry it — and never valued.

The boundary rule splits the world in two — code, and the values of a place.
There is a third thing that is neither, and leaving it unnamed makes the rule
wrong rather than incomplete: **data read while building**. Pages prerendered
from a database depend on bytes that are not in the source and are not a
binding, so such a build cannot leave the machine that holds the data, and no
rearrangement of environment variables changes that. Three answers are
legitimate, chosen per route rather than per project: render at runtime,
declare a frozen export whose digest is pinned (`build.inputs`), or generate
the bytes as a release step — the same kind of step as a migration, not a new
concept. A build that reads data it has not declared is the one case that
announces nothing: it succeeds wherever the data happens to be.

The declaration ships whole: `kind`, `identity`, `roles` (each with its own
working directory, per-mode argv commands, optional listener and drain floor),
`build` (its command, its artifacts and any declared data inputs), `requires`,
`release` and `env`. The entrypoint is **evolving**
(→ ADR 0103) because the shape is still being found, not because parts of it
are missing.

Two things hold the boundary, and they are not equally strong — saying so is
part of the decision.

**Structure** is the guarantee. There is nowhere in the declaration that a value
of the place must go: a command is `executable` plus `args`, no part may be an
absolute path or an assignment in any form, and a listener names variables that
must exist in the env contract with the right shapes. `--port=8080` and
`--config=/srv/app/config.json` are refused because an inline value has to be
written as its own argument, where the same checks reach it.

**Hygiene** is the filter. `namesAMachine` catches the known shapes of a machine
name in every remaining free string, and a number after a port flag is refused.
It is not a proof: a secret written as its own argument and a hostname written
as a plain word are indistinguishable from any other argument. Stitchkit is not
a secret scanner and this ADR does not claim it is one.

Both versions of this rule were first written too strongly, and both times the
correction came from someone else running shapes the author had not thought of.
That is why the test file leads with a table of declarations that must be
refused, and carries a second table of shapes it deliberately accepts.

## Consequences

- A reader outside the repository validates a project with the same schema the
  project validates itself with, and a mismatch is an error rather than a
  divergence nobody notices.
- **Declaring yourself stays optional, and that is part of the decision.** A
  project with no `project.json` is complete: no other core module imports this
  one, no build/test/start path looks for a declaration, and its absence is
  never an error or a warning. Two tests hold that shape
  (`packages/core/tests/project-declaration.test.ts`) because the alternative —
  a repository that only one tool can bring up — is a fork rather than a
  dependency, which is the outcome the whole surface exists to avoid.
- The framework gains a surface that is not about serving requests. It stays
  generic (→ ADR 0002): the schema fixes no locale set, no role vocabulary and
  no deployment model — it fixes only what is true about code with no machine.
- Adoption crosses a release boundary. The template resolves `stitchkit` from
  npm at the version its catalog targets, so it can only import a new entrypoint
  after that entrypoint is published — the template's migration is a starter
  release that follows the framework release, never the same one.
- Extending the declaration is a breaking change to a published schema and moves
  the minor, with a migration section like any other.

## Alternatives considered

- **Leave the schema in each project.** Rejected: it is already duplicated
  twice, and the reader that most needs it is the one that cannot see the tree.
- **Ship it from the scaffolder.** Rejected: the scaffolder writes a project
  once and is then absent. A deployment reader would depend on a scaffolding
  tool to understand a repository it scaffolded years earlier.
- **A JSON Schema file rather than a Zod module.** Rejected for now: the repo is
  Zod-first, types come from `z.infer`, and a JSON Schema can be generated from
  the Zod schema (`z.toJSONSchema`) when a non-TypeScript reader needs one.
  Generating is one source; hand-maintaining both is two.
