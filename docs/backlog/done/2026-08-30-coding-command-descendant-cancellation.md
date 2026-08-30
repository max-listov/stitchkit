---
title: Bound coding command cancellation when descendants retain pipes
description: Ensure finite command tools settle at their deadline and do not leave owned descendants behind.
type: task
status: done
created: 2026-08-30
updated: 2026-08-30
completed: 2026-08-30 11:31 +00:00
priority: P1
---

## Evidence

Published stitchkit 0.69.0, Bun 1.3.14 on macOS. Public coding-tools factory configured with
`root: process.cwd()`, executable alias `fixture: /bin/bash`, empty environment, explicit
authorization, `shellTimeoutMs: 20`. Invoking `run_command` with arguments
`['-c', '/bin/sleep 1 & wait']` returned after 1015 ms, outcome `timeout`, signal `SIGKILL`.
The direct child was killed at the deadline but its descendant retained the output pipes.

`packages/core/src/agent-runtime/coding-tool-shell.ts` spawns without owned process-group
isolation, kills only the immediate child, and settles only on `close`. A longer-lived child
can therefore outlive cancellation and hold the tool open beyond its advertised deadline.

## Result

Finite host-authorized commands settle within a documented bounded cancellation interval,
with cleanup of owned descendants where supported. Do not claim OS sandboxing or containment
of processes deliberately escaping the ownership group. No implicit new executable authority.

## Plan and acceptance

- [x] Reproduce deadline and explicit abort with a descendant retaining stdout/stderr.
- [x] Fix process ownership and bounded stream settlement; handle pre-aborted input before spawn.
- [x] Verify normal parent exit, output-limit cancellation, and error cleanup without orphan timers.
- [x] Test Bun and Node public entrypoints, including platform limitations explicitly.
- [x] Publish the corrected coding-tools leaf and record exact version and execution evidence.

## Additional public mounted-tool proof

Published `stitchkit@0.69.0`, `ai@7.0.85`, Bun 1.3.14 on macOS: `mountAgent` executes the
published `run_command` definition with an empty environment and a finite executable alias.
A parent starts a self-terminating child that inherits stdout/stderr. A fixture barrier proves
the child is running; only then the caller aborts. The child writes a disposable marker 500 ms
later and exits after 800 ms. The tool returns `outcome: cancelled`, `signal: SIGKILL`, but only
after 795 ms and with the post-cancellation effect present. Positive controls return exit 0 and
exit 7 exactly. This proves an actual surviving effect, not only delayed pipe settlement.
All effects are inside a temporary fixture tree; no persistent process or real session is used.

## Что сделано

- `packages/core/src/agent-runtime/coding-tool-shell.ts` owns a detached POSIX process group and
  terminates it on normal parent exit, timeout, abort and output overflow; retained pipes settle
  within `shellTerminationGraceMs`, and pre-aborted calls never spawn.
- `packages/core/tests/agent-coding-tools.test.ts`, case `kills owned descendants and bounds retained
  pipes on exit, timeout, abort and output limit`, covers the complete lifecycle. The packed Bun
  and Node consumer fixtures also execute the public entrypoint.
- Full `bun run verify` passed on tree `e23094e6b7f3`; exact-SHA CI run `33308956173` passed.
- Published as `stitchkit@0.70.0`, source
  `d2478418469ae8ebb8dfce195e621c637422d178`, integrity
  `sha512-2aVY8ZlqVqRnw6tmJkavFRgFQJ2Qq+IZqygFwCqgyksD7232jQEZmoJ7r8dZBDL/XS55Nc1ftKAQdbH3WldNVQ==`.

Completed: 2026-08-30 11:31 +0000
