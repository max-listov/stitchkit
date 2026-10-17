---
title: "ADR 0263: A fix to an entrypoint names what it touches"
description: "A Fixed changelog item that leads with a public entrypoint carries the machine line stitchkit upgrade matches against a project's imports."
type: decision
status: accepted
created: 2026-10-17 12:07 +07:00
updated: 2026-10-17 12:07 +07:00
---

# ADR 0263 — A fix to an entrypoint names what it touches

**Invariants:** I13, I14.

## Context

`stitchkit upgrade` told a project which breaking items touched its imports and said
nothing about fixes. Five behavioural fixes to one process runner shipped in ten days;
a consuming project found them by reading three screens of changelog. Whether a fix
reaches a project is the same question as whether a break does.

## Decision

A `### Fixed` item of the framework changelog that leads with a backticked public
entrypoint is a fix to that entrypoint and carries the `**Affects:**` line of a breaking
item: export names, or `behaviour` for a change no import name reveals. `*` is refused
there, since a fix removes nothing. An item that does not lead with an entrypoint
(tooling, CI, documents) may carry the line and does not have to. `release:check`
refuses a release after 0.110.6 that breaks the rule. A behaviour change filed under
`### Changed` is outside it.

`stitchkit upgrade` prints a "Fixes that touch this project" section with the same
verdicts as breaking items (`affects this project` with `path:line`, `not used here`,
`behavioural — check by hand`). A fix that carries no line, such as one released before the
rule, is only counted. A test reads every `Affects` line of the real changelog, so one typo cannot
break the command for a consumer whose range crosses it.

## Consequences

A consumer sees at once which fixes reach it and can decide whether a release of its
own is needed. The author names the touched exports at release time, when the answer is
known, in the same line the breaking items use.
