---
title: "ADR 0286: A refused view withholds a read and keeps an effect"
description: When a managed CLI view is refused, a command that only reads prints nothing and names the field; a command with an effect still prints its complete result.
type: decision
status: accepted
created: 2026-11-10 13:48 +07:00
updated: 2026-11-10 14:37 +07:00
---

# ADR 0286 — A refused view withholds a read and keeps an effect

Serves **I9**, **I13**, **I14**. Amended by
[ADR 0287](0287-a-read-says-it-reads-on-every-tool-surface.md): a `GET` declaring
`destructiveHint: true` is not a read, and the MCP surface publishes the rule.

## Context

A managed CLI command may be asked for a view of its result — `--table`, `--count-by`, `--sum`,
`--sort`. When the view names a field no record carries, the presentation fails after the
operation already succeeded. The rule shipped earlier printed the complete original result on
stdout beside a `CLI_PRESENTATION_FAILED` diagnostic, so a creation receipt was never lost to a
typo: repeating the command would repeat its effect.

For a command that only reads, the same rule is the wrong trade. A consumer's agent asked for
`bot_list --table id,nosuchcolumn` and received 154 936 bytes of records it never asked for, in
its own context, when the answer was one corrected call away. Repeating a read costs nothing the
first call did not already cost.

## Decision

Whether the result is printed after a refused view follows from whether the command can be
repeated:

- A command only reads when its tool declares `annotations.readOnlyHint: true`, or declares no
  `readOnlyHint` and its contract method is `GET`. It prints nothing on stdout; the diagnostic
  names the refused field and the fields that exist, and says to repeat the read with a view
  that fits.
- Every other managed command, and every native `defineCliCommand` presenter, keeps its complete
  result on stdout as before, because repeating it would repeat its effect.
- `details.resultOnStdout` states which of the two happened, so a script reads the fact instead
  of inferring it from the method.

An explicit `readOnlyHint: false` on a `GET` keeps the result on stdout: the declaration wins
over the method, so a `GET` with an effect that must not be repeated can say so.

## Consequences

This changes documented behaviour of the stable `stitchkit/cli` entrypoint for reads. A script
that recovered a read's records from stdout after `CLI_PRESENTATION_FAILED` must repeat the read
with a valid view; the migration `read-view-refusal` shows the change. Commands with an effect
change nothing.
