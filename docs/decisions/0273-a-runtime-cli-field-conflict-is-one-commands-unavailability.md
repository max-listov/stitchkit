---
title: "ADR 0273: A runtime CLI field conflict is one command's unavailability"
description: A changing runtime catalogue cannot turn an argv field conflict into an outage of every CLI command.
type: decision
status: accepted
created: 2026-10-28 22:15 +07:00
updated: 2026-10-28 22:15 +07:00
---

# ADR 0273 — A runtime CLI field conflict is one command's unavailability

**Invariants:** I2, I3, I8, I13.

## Context

The CLI lifts application globals out of argv and reserves its own behaviour
options. A command input with the same field name cannot receive that value.
The shared surface walk threw on the first such entry, so one independently
changing runtime catalogue operation prevented every managed command, including
unrelated diagnostics, from running. A two-entry public API probe reproduced it;
removing the conflicting entry restored the healthy command.

## Decision

The argv shape checker still throws for command identity and local presentation
policy faults. It classifies reserved/global field conflicts with one exact reason.
The CLI surface walk retains a conflicting `kind: runtime` descriptor in help,
marked unavailable with that reason, and omits it from executable tools. Authored
native and contract-defined commands keep startup failure for the same conflict.
Local policy guards run before classification, so an unavailable field cannot hide
an aliased passthrough or another application configuration fault.

Dispatch resolves presentation before execution: command help remains available,
then an unavailable call returns canonical `CLI_COMMAND_UNAVAILABLE` with the full
reason, status 409, `retryable: false` and default CLI exit 1. The existing error
projection, hint and exit overrides apply. Refusal precedes argument admission,
stdin, context, hooks and handler; dry run cannot turn it into success. The same
refusal covers a known unavailable polling target; unknown targets keep NOT_FOUND.

The in-process invoker receives globals and command input separately, so argv
field conflicts do not make those operations unavailable there. It keeps the same
surface owner and runner without imposing a terminal-only restriction on parsed data.

## Consequences

A runtime catalogue can contain an unavailable entry without taking down unrelated
commands. Help explains the actual conflict instead of hiding the entry or claiming
it is unknown. There is no catch-all recovery for malformed catalogues: duplicate
names, reserved command names and local policy faults remain fatal configuration
errors. A minimal installed-package proof exercises both catalogue orders, help,
refusal and the direct-invoker boundary on Bun and Node.
