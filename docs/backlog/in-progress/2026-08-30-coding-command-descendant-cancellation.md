---
title: Bound coding command cancellation when descendants retain pipes
description: Ensure finite command tools settle at their deadline and do not leave owned descendants behind.
type: task
status: in-progress
created: 2026-08-30
updated: 2026-08-30
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

- [ ] Reproduce deadline and explicit abort with a descendant retaining stdout/stderr.
- [ ] Fix process ownership and bounded stream settlement; handle pre-aborted input before spawn.
- [ ] Verify normal parent exit, output-limit cancellation, and error cleanup without orphan timers.
- [ ] Test Bun and Node public entrypoints, including platform limitations explicitly.
- [ ] Publish the corrected coding-tools leaf and record exact version and execution evidence.

## Additional public mounted-tool proof

Published `stitchkit@0.69.0`, `ai@7.0.85`, Bun 1.3.14 on macOS: `mountAgent` executes the
published `run_command` definition with an empty environment and a finite executable alias.
A parent starts a self-terminating child that inherits stdout/stderr. A fixture barrier proves
the child is running; only then the caller aborts. The child writes a disposable marker 500 ms
later and exits after 800 ms. The tool returns `outcome: cancelled`, `signal: SIGKILL`, but only
after 795 ms and with the post-cancellation effect present. Positive controls return exit 0 and
exit 7 exactly. This proves an actual surviving effect, not only delayed pipe settlement.
All effects are inside a temporary fixture tree; no persistent process or real session is used.
