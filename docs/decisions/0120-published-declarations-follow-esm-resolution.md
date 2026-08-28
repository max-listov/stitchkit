---
title: "ADR 0120: Published declarations follow ESM resolution"
description: "The package rewrites emitted relative declaration specifiers to explicit JavaScript targets and proves its HTTP-only root under NodeNext without optional peers."
type: decision
status: accepted
created: 2026-08-28
updated: 2026-08-28
---

# ADR 0120 — Published declarations follow ESM resolution

## Context

Stitchkit sources use TypeScript's bundler resolution and extensionless relative
imports. The JavaScript build is bundled, so those source specifiers do not
survive into published runtime entrypoints. Declaration emit is different:
TypeScript preserves each specifier in `.d.ts`.

An ESM consumer using `moduleResolution: NodeNext` requires explicit relative
file extensions. A declaration such as `export * from './contract'` is therefore
not a portable package reference even though bundler-mode consumers resolve it.
The package also exported the root Socket.IO surface through a constraint imported
from an optional peer. An HTTP-only consumer consequently needed Socket.IO types
just to check a client that never opened a socket.

## Decision

The declaration build resolves every emitted relative module specifier against
the completed declaration tree and writes its ESM runtime spelling:

- `./browser/client` becomes `./browser/client.js`;
- `./contract` becomes `./contract/index.js` when the declaration target is an
  index module;
- an unresolved relative specifier fails the build instead of being published.

The browser-safe root owns its generic event-map constraint. Optional Socket.IO
packages remain necessary only for code that opts into their runtime or dedicated
server declarations; they are not a declaration dependency of `createClient`.

The packed consumer lane includes a clean ESM project with
`module: NodeNext`, `moduleResolution: NodeNext`, `skipLibCheck: false`, only
`stitchkit` and `zod` installed, and both typecheck and Node runtime execution.

## Consequences

- Package declarations follow the same ESM resolution rules as their published
  JavaScript targets.
- The peer-free root is proven from an installed tarball rather than inferred
  from the workspace dependency graph.
- Source authoring remains on bundler resolution; the package build owns the
  translation at the artifact boundary.
- Optional entrypoints may still name their declared peers. The guarantee is
  that an unrelated root import does not require them.
