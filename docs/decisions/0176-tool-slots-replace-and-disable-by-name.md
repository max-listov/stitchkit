---
title: "ADR 0176: Tool slots replace and disable by name, and an unknown name refuses"
description: "A declarative registry composes runtime tools over one declared default set; replace and disable address that set, and a name outside it is a build error rather than a silent no-op."
type: decision
status: accepted
created: 2026-09-12
updated: 2026-09-12
---

# ADR 0176 — Tool slots replace and disable by name, and an unknown name refuses

## Context

`mountAgent` composes a `ToolSet` from contract methods and framework-managed
runtime tools. Removing or replacing a built-in was done by filtering the
runtime-tool array by name in application code. That filter rots: a later
framework default is simply not in the list, a typo removes nothing, and neither
mistake is visible — the tool is silently present or silently absent, and the
only record of what the composition intended lives in whoever wrote the filter.

A second list of defaults would be just as bad: it drifts from the array the
mount actually receives, and a reader has to reconcile two sources by eye.

## Decision

`defineToolRegistry({ defaults })` declares the runtime surface once. `disable`
removes a default and is idempotent; `replace` swaps it, and the replacement
must carry the same name and may be given once. `build()` returns exactly the
tools the mount will see plus their names, so introspection and mounting read
one value.

A name that is not in `defaults` is refused at composition time by both verbs.
The refusal is the point: the registry's only job beyond `mountAgent` is to know
whether a name exists to be removed, and answering that with silence would
reproduce the defect it replaces.

`mountAgent` accepts either `runtimeTools` or `registry`, never both; a
registry is passed through unchanged, so lifecycle, hooks and presentation stay
the mount's.

## Alternatives

- **Filter the runtime-tool array in the application.** Rejected: the filter
  cannot distinguish a removed default from a missing one, and it has no
  declared default set to check a name against.
- **A separate manifest of defaults.** Rejected: two declarations of one fact
  drift, and the mount would have to reconcile them.
- **Silently ignore an unknown name.** Rejected: that is the defect, not the fix
  (see *Context*).

## Consequences

A composition states its intent in one place and fails loudly on a typo. The
registry owns no execution: it is a builder over an array, and a future default
set stays an ordinary export. Adding a default does not change the registry, but
it does mean a filter written before it no longer describes the surface — which
is now a compile-time question, not a runtime guess.
