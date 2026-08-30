---
title: Project declaration
description: One machine-readable statement a repository makes about itself — identity, roles, build, requirements, release steps and the names of the values a deployment supplies.
type: architecture
status: active
created: 2026-08-25
updated: 2026-08-30
---

# Project declaration

> **Maturity: evolving.** This surface is still finding its shape and may be
> redefined in any minor release — always with a `### ⚠️ Breaking changes` entry
> and a migration section, never silently.

> **Declaring yourself is optional.** A project with no `project.json` is a
> complete stitchkit project: nothing in `stitchkit`, `stitchkit/server`,
> `stitchkit/node`, `stitchkit/tools` or `stitchkit/cli` reads a declaration,
> and no build, test or start path looks for one. Read this page as an offer,
> not a requirement — it describes what you get if you decide to say these
> things in a machine-readable way instead of in a README.

`stitchkit/declaration` is the schema for what a repository says about itself:
what it is, the roles it runs, what it builds, what has to exist before it
starts, what must happen once on release, and the **names** of the environment
variables a deployment has to supply.

```ts
import { parseProjectDeclaration } from 'stitchkit/declaration';
import declaration from '../project.json';

export const appDeclaration = parseProjectDeclaration(declaration);
```

`parseProjectDeclaration` checks `schemaVersion` **before** it reads any field.
A reader that does not recognise the version refuses the repository instead of
interpreting it partially — a half-understood declaration is the one failure
mode that produces a running, wrong deployment rather than an error.

## Why declare yourself

### Identity is not product membership

The exported names `ProjectDeclaration` and `ProjectIdentity` describe the buildable source/artifact
declared by a repository. A singular `identity` does **not** make a product project and a repository
the same entity, nor does it identify a local checkout or a harness session.

| Entity | Meaning and owner |
| --- | --- |
| Product project | A product boundary whose repository membership is explicitly maintained outside this declaration |
| Repository | Versioned source; its declaration describes roles, build outputs and release requirements |
| Checkout | A local working copy of a repository revision; local paths and credentials belong to its host |
| Harness workspace | The host-selected working scope for a session, not an implied product or membership registry |

Membership is many-to-many. For example, an external registry may declare product A includes
repositories `service-a` and `shared-library`, while product B includes `service-b` and the same
`shared-library`. Both products can read the library's unchanged declaration. Installing that library
as a dependency, placing a checkout beside another, or naming a harness workspace does not create
membership. The embedding product/registry owns these explicit relationships and their access policy.

A private companion repository can be part of a product without becoming a separate product. Its
relationship and working context stay in an authorized private registry, never in a potentially public
library declaration. No registry or membership fields are required here; the declaration remains
optional. Existing exports and schema version 1 are unchanged.

### One statement, several readers

Because the statements exist either way, and without a schema they exist three
times. A repository already says how many roles it runs (in a process file),
which variables it needs (in a Zod schema), what it builds (in a script) and
what has to happen on release (in a README paragraph). Those four copies drift
independently, and nothing fails when they do.

What a declaration buys:

- **One reader can be outside the tree.** Whatever builds a source into an
  artifact and binds that artifact into a deployment can validate the project
  with the same schema the project validates itself with, without being told
  anything by the author.
- **The tool is not the format.** The schema ships from the framework and is
  plain published TypeScript plus JSON. Any side may read `project.json`
  through `stitchkit/declaration` — or generate a JSON Schema from it with
  `z.toJSONSchema` — and serve the project without asking the format's author
  for anything. A repository that only one specific tool can bring up is a fork,
  not a dependency.
- **Generated instead of hand-kept.** The starter renders its supervision files
  and its client-safe identity module from the declaration, so a role added in
  one place cannot be missing in another.

What it does not buy: nothing here starts, supervises or deploys anything.
The declaration is a statement; acting on it belongs to whatever brings a
deployment to a source.

## The boundary rule

> A declaration must be complete and meaningful **when no machine exists**. A
> field that cannot be filled in without knowing where the code will run is a
> binding supplied by the deployment, not a declaration made by the repository.

So ports, hosts, absolute URLs, connection strings, machine paths, routing
shape, supervision policy and secrets are never *values* in a declaration. A
binding is **named** — by the variable that will carry it — and never valued:

```jsonc
{
  "listener": { "portVariable": "API_PORT", "bindVariable": "BIND_HOST", "readinessPath": "/health" }
}
```

**What is guaranteed is structure**: there is nowhere in the declaration that a
value of the place must go. A command is `executable` plus an `args` array — no
shell string, no pipe — and no part may be an absolute path or carry an inline
value, so `--port=8080` must be written `['--port', '8080']`, where it is
refused as a port. A listener's variables must exist in `env.variables` with the
right shapes. Unknown keys are refused rather than stripped.

**What is filtered is the rest**: every remaining free string is checked against
`namesAMachine` — a scheme, a protocol-relative host, an absolute or
home-relative path, a Windows drive, a `host:port` pair, a bare IPv4 literal.

The second half is hygiene, not a proof, and it is worth knowing where it stops:
a secret written as its own argument and a hostname written as a plain word look
like any other argument. The schema will not catch them, and it is not trying
to — the point is that a complete declaration can be written before any machine
exists, not that nobody can type a value into one.

## Three kinds of input, not two

The boundary rule separates code from the values of a place. There is a third
kind that is neither: **data read while building**. Pages prerendered from a
database depend on bytes that are not in the source and are not a binding, and
moving environment variables around does not make such a build portable.

Decide it **per route**, not per project:

| what the bytes depend on | what is legitimate |
| --- | --- |
| only the source | static — built once, and portable |
| the place (domain, port) | never static; read it from the request |
| data | render at runtime · a declared snapshot with a digest · generate it as a release step |

The default is **render at runtime**: the build needs no database, and the page
reads its data where the data lives. Choose a declared snapshot when you need
static bytes — the build then reads a frozen export whose digest is a declared
input, not a live database. Choose a release step when the bytes must be
produced on the way to the deployment; that is the same kind of step as a
migration, not a new concept.

A build that reads data it has not declared is not hermetic, and the fact is
invisible: it succeeds on the machine that happens to have the database.

## What it carries

| key | what it says |
| --- | --- |
| `schemaVersion` | which format this is; checked before anything else |
| `kind` | `application` or `library` |
| `identity` | `slug`, `name`, `version`, `description` per locale |
| `roles` | each with its own working directory, per-mode argv commands, optional listener and `drainFloorMs` |
| `build` | the build command and the artifact paths it produces |
| `requires` | what the code needs and does not provide, per phase (`release`, `start`) |
| `release` | what must happen once before any role starts — migrations declared as bytes |
| `env` | the variables a deployment must supply, by name and shape |

Two details are load-bearing:

- **A role may declare no listener at all.** A queue consumer, a bot or a
  scheduler is a role like any other; readiness belongs to a role rather than to
  the application.
- **Migrations are declared as bytes** — `engine`, `root`, `lockfile` — not as a
  command to run. The side that can see the deployment decides what to do with
  them: exact contents, admission verdict, whether a preflight can be skipped
  because nothing touches the database.

## Narrowing it for your project

A project that speaks exactly two locales narrows the shipped schema; it does
not write its own copy of the rest.

```ts
import { z } from 'zod';
import { ProjectDeclarationSchema, parseProjectDeclaration } from 'stitchkit/declaration';

const Narrowed = ProjectDeclarationSchema.safeExtend({
  identity: ProjectIdentityNarrowedSchema,
});
```

`safeExtend` keeps the refinements the shipped schema carries. Extending the
declaration itself is a breaking change to a published schema and moves the
minor, with a migration section like any other.

## Related

- [ADR 0104](../decisions/0104-the-project-declaration-ships-from-the-framework.md)
  — why the schema ships from the framework rather than from each project.
- [API reference](../api/reference.md#stitchkitdeclaration) — every export.
