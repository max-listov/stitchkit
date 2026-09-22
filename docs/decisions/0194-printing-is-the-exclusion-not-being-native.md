# 0194 — Printing is the exclusion, not being native

**Status:** Accepted
**Date:** 2026-09-22

## Context

[0192](0192-a-cli-namespace-belongs-to-the-application.md) put native commands
outside `createCliInvoker` and gave the reason in its Consequences: "they write
to stdout and stderr by construction — that is what they are for — and an
operation that prints has no result to return."

That reason describes one half of `CliCommandDefinition`, and the type has
always had two. `CliCommandDefinitionWithOutput` declares `output`, returns a
value the frame validates and prints, and holds the writers without normally
touching them. `CliCommandDefinitionWithoutOutput` declares `output?: never`,
returns `void`, and prints itself. The exclusion was written for the second and
applied to both.

A consumer measured the cost on the upgrade to 0.92.0: six of their eight native
commands declare `output`, a `describe` line that had worked in their stream —
by re-spawning the binary, which is exactly what 0192 removed — began answering
`NOT_FOUND`. They accepted the narrowing and reported it. It was not a trade the
decision ever meant to make; it was a criterion that named the wrong property.

## Decision

The invoker admits a native command if and only if it declares `output`. The
test is `cliCommandReturnsResult`, a type predicate, so the compiler carries the
distinction the prose got wrong.

`present` is not called on this path. It is stdout formatting and there is no
stdout; calling it to throw the result away would run consumer code for no
effect and let a throw in it turn a good result into an error.

`exitCode` is applied, through the same `cliCommandSuccessExitCode` the command
line uses. A script that branches on the code must not be able to see the two
paths disagree, and one shared function is the only way that holds.

Whatever a handler does write comes back on the result as `written`. In process
there is nowhere else for it to go: printing it would interleave with the
caller's own output and corrupt a stream of JSON lines, and dropping it would
lose a diagnostic without saying so. The caller decides what it is worth.

## Consequences

A printing command is still outside, and now for its own reason rather than by
association. `NOT_FOUND` is the honest answer for it: it has no result to give,
and running it would write into a caller that asked for a value.

The consequence 0192 drew — "a stream cannot invoke the stream command, so the
consumer's ban on nesting has nothing left to forbid" — survives unchanged,
because a stream command is precisely one that prints.

This widens a released surface: a name that answered `NOT_FOUND` in 0.92.0 can
now resolve. An application that relied on native commands being unreachable in
process has to say so by not passing them to the invoker.
