# 0192 — Running a parsed call, without owning the application's namespace

**Status:** Accepted
**Date:** 2026-09-22

## Context

The most common way an agent drives a CLI is not one command but a stream: a
JSON line per operation, an answer per line, plus a resumable batch of the same.
The framework owned the parsing, the routing, the JSON mode, the exit codes and
the error shape — and offered no way to say "run this parsed call and give me
the result". So the stream loop re-spawned the binary per line: arguments
serialised back into `--flag value` strings, nested objects pushed through
`JSON.stringify` into one argv slot and parsed again on the other side, the
result read back out of stdout text. Three conversions of data the framework was
already holding, and a process start measured at 0.15 s — thirty seconds for a
two-hundred-line manifest before any work begins.

## Decision

`createCliInvoker` compiles the managed surface once and runs against it,
returning the result and the exit code without writing or exiting. `createCli`
is built on the same surface walk and the same exit table.

**The loops ship as factories, not as framework command names.** Reserving
`jsonl` and `batch` would take two names out of a namespace that belongs to the
application: one that already has a `batch` command would either fail at startup
or find its own command silently shadowed. The framework may own mechanics; it
may not own the words a consumer's users type.

**A batch records successes only.** Recording exists because re-running an
operation that already happened repeats its effect. A failure had no effect to
repeat, and remembering it makes the batch unfinishable — one rate limit and the
line replays its own failure on every future run, with the only escape being to
delete the checkpoint and lose the lines that did succeed. A line whose content
changed under a used id is refused rather than replayed or re-run, because both
answer a question nobody asked.

## Consequences

What stays with the consumer, and was not taken: the link between a line id and
the idempotency of a paid operation, which operations a batch may contain, and
how much of it runs at once. That is product knowledge.

Native commands are outside the invoker. They write to stdout and stderr by
construction — that is what they are for — and an operation that prints has no
result to return. A consequence worth stating: a stream cannot invoke the stream
command, so the consumer's own ban on nesting is not replaced by ours, it simply
has nothing left to forbid.

The equality of the two paths is structural, not a matter of discipline: one
surface walk, one exit table, and the application's global options parsed by the
schema that declared them in both. Skipping that parse — an empty object stands
in for "none given" — silently drops declared defaults, and those defaults reach
`resolveAuth` and `context`, which is the one divergence this seam exists to
prevent.
