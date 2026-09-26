# 0203 — Automatic stdin probes only for the first byte

**Status:** Accepted
**Date:** 2026-09-26

Invariants I2, I8 and I10.

## Context

A CLI launched by an agent may inherit an open pipe whose owner never writes or
closes it. Reading to EOF before validating a missing required argument then
waits forever. A real child-process reproduction remained silent until killed
after 1.5 seconds. An idle pipe and a producer that has not started yet are
indistinguishable without an explicit protocol or a finite observation window.

## Decision

The default CLI stdin reader waits 250 ms for its first nonempty chunk. TTYs,
empty EOF and a pipe that remains empty leave the field unset; normal schema
validation owns the error. After the first chunk, only EOF completes the input:
pauses cannot truncate a large or multipart payload. Decode UTF-8 after collecting
the bytes, preserving split characters, then trim as the existing reader does.
Read errors and premature close reject instead of returning partial input.
Every completion path removes its listeners and timer and pauses the stream.

Only the first required unset field invokes this reader. Explicit arguments,
commands without required unset fields and the existing `CliConfig.stdin` hook
do not acquire the probe timeout. JSONL/batch commands own their streaming input;
MCP/serve and long-running handlers do not use this deadline. The token `-`
remains ordinary data.

Process tests cover the required-field error below one second, a real TTY,
empty EOF, full UTF-8 payloads beyond pipe capacity with 400 ms inter-chunk
pauses, and explicit readers/stream commands whose first input arrives after
600 ms. The regression exits in about 330 ms on Bun and 365 ms on Node in the
measured Linux environment, including process startup; these measurements are
not a guarantee about arbitrary machine startup latency.

## Consequences

A producer that starts after the probe needs an explicit argument or a custom
stdin reader. This changes the stable CLI's default behavior and requires a
breaking minor with migration instructions, not a patch labeled only as a fix.
The stable-breaking release budget in ADR 0198 remains in force; this decision
does not grant a release-budget exception.
