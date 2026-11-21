---
title: "ADR 0298: An application file crosses a branch by declaration"
description: A file part reference the application stores is carried into a branch only under the destination reference the host declares; an undeclared one still refuses the branch.
type: decision
status: accepted
created: 2026-11-21 19:49 +08:00
updated: 2026-11-21 19:49 +08:00
---

# ADR 0298 — An application file crosses a branch by declaration

Amends rekeying in [ADR 0258](0258-conversation-branches-have-new-identity-and-no-inherited-authority.md). Serves **I8**, **I12** and **I15**.

## Context

A file part's `reference` is the application's: its input carries it, or
`persistGeneratedFile` returns it, and `resolveFile` reads it back. The runtime
also lets a file part point at one of its own spills. Branching treated every
file part as the second case, so a conversation holding an image the
application stores — readable, continuable, exportable — could not be branched
or restored under a new identity at all. A consuming project hit it on an
archive whose only unmatched reference was an uploaded picture.

The runtime cannot fix this alone. It does not hold those bytes, so it can
neither copy them nor grant the destination access; and carrying the source's
address into a new conversation would hand it a reference the application never
authorised for it.

## Decision

`branchConversation` accepts `applicationFiles`: pairs of a source `reference`
and the `destinationReference` the host has already granted in its own store.

A file part's reference resolves in one order: a spill of the archive is rekeyed
as a spill; a declared application file takes its declared destination
reference; anything else refuses the branch before any write, with
`Branch contains a foreign or missing file reference`.

- One reference has one owner: declaring a spill reference as an application
  file refuses, and so does a repeated `reference` or `destinationReference`.
- The declaration covers the whole supplied history, an unselected tail
  included, because the complete archive is validated before a prefix is chosen.
- The declaration is part of the request fingerprint: the same request returns
  the same receipt, a different declaration conflicts.
- No callback runs inside the branch transaction; the host does its own I/O
  before calling, and removes what it granted if the branch refuses.
- The provider journal is evidence of what a model was actually sent, and the
  branch copies it unrewritten: bytes are recorded by hash, and an address that
  `resolveFile` returned stays as that string. A host for which such an address
  must not travel resolves files to bytes.

The same declaration answers the same question for application JSON. Message
metadata, an application tool's input and output and provider options are
carried unrewritten, and a key in them named like a runtime reference refuses
the branch. `applicationKeys` lists the names the host uses for data of its own;
a declared key still refuses when its value names an identity of the source
conversation, so a real reference is caught whatever it is called. Declarations
are sets: their order is not part of the request fingerprint.

## Consequences

- Branching and archive restore work for conversations with host-stored
  attachments, with the host's own access check unchanged.
- The runtime still learns nothing about the application's store; it rewrites a
  string it was told to rewrite, and refuses the ones it was not told about.
- `importConversation` is unaffected: it restores the same identity and keeps
  every reference as it was.
