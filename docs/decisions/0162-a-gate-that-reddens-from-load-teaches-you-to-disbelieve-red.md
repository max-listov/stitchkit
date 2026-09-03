---
title: A gate that reddens from load teaches its reader to disbelieve red
description: Two heavy lanes want ~7 GiB and the host had 5.8; the release gate timed out in different tests every run, and the fix was an environment variable somebody had to remember. It measures now, and says what it measured.
type: decision
status: active
created: 2026-09-03
updated: 2026-09-03
---

# 0162 — A gate that reddens from load teaches you to disbelieve red

## Decision

`verify --release` chooses how many heavy lanes to run at once by asking the
host how much memory it has, not by asserting `2`. It prints the number and why
it picked it. `VERIFY_HEAVY_CONCURRENCY` still wins outright — the host is asked
only when nobody has answered.

## What it looked like

Two release runs in a row failed at `starter-head-lane`, and neither failure was
about behaviour:

```
run C: publishes complete page metadata (chromium)
       renders the hydrated starter application (webkit)
       switches catalogue sections and component tabs (mobile-chromium)
run D: has no serious accessibility violations (chromium)
       switches catalogue sections and component tabs (webkit)
       switches catalogue sections and component tabs (mobile-chromium)
both:  3 failed, 30 passed, 1.8–2.3 minutes
alone: 42 passed in 17.9 seconds
```

More tests, a sixth of the wall clock, when the same lane runs by itself. The
failures were Playwright timeouts — an empty URL after five seconds, thirty
seconds exceeded "while setting up page" — and they moved from test to test
between runs. A defect picks a test and keeps it.

`MemAvailable`, sampled every two seconds through each lane on this 22 GiB host:

| lane | holds |
| --- | --- |
| `starter-head-lane` | 3.24 GiB |
| `supervised-lane` | 3.33 GiB |
| `consumer-lane` | 0.82 GiB |

5.8 GiB available, swap already fully spent, and the profile started the two
that want 6.6 GiB together.

## Why this is a defect and not an inconvenience

A test that can fail from bad luck asserts nothing, and this repository already
says so about flaky tests. A whole *gate* that can fail from bad luck is the
same defect one level up, and it is worse in one specific place: the release
profile is the one run whose red cannot be repaired in place. `assert-head`
requires the tag to sit on the branch head and `assert-subject` requires that
head to be a `release(...)` commit, so a red release run costs a second release
commit. A reader who has learned that red there means "run it again" is exactly
the reader who will tag over a real failure.

The knob existed and was documented, and the comment beside it already knew the
whole story — "two of them at once on a host whose swap is already spent get
terminated rather than finishing, and a lane that was killed reports the same
way as a lane that failed". The knowledge was in the file. The gate did not act
on it, because acting on it was a human's job: remember to export a variable.

## Three outcomes, not two

`availableMemoryGib()` returns `undefined` where it cannot measure — `/proc` is
not there on macOS, and a container may not show it. That case keeps the
historical `2` and *says* it kept it, rather than arriving dressed as a
measurement. Returning `0` for an unreadable file would have pinned every host
that cannot be measured to one lane while looking like a decision.

The parameter is a **measurer**, not a measurement, and that shape came from a
test rather than from foresight: with `available = availableMemoryGib()` as a
default parameter, "could not read it" and "caller passed nothing" are the same
`undefined`, the default fires for both, and the unmeasurable branch is
unreachable — from a test, and from any caller that wanted to state it. The test
that asked for that branch is what found it.

## A failure in the background must be legible

With two lanes running, the first to throw takes its siblings' child processes
down, and a backgrounded run showed only a cluster of `terminated by signal
SIGTERM` lines with the harness reporting the job as killed. Three release runs
were read as external interference on that evidence. The failure was always
there; the sentence naming it was not.

`runBounded` now names the lane and its exit code before anything else reacts,
and says the SIGTERMs that follow are a consequence:

```
[gate] starter-head-lane FAILED: verify: `bun run starter-head-lane` exited with 1
[gate] cancelling the other heavy lanes; their SIGTERM is a consequence
```

This is the general shape from ADR 0161, in the other direction. There, a gate
threw away a diagnostic it did not recognise. Here, a gate produced a symptom
and not a cause. Both print something that reads like an answer.

## Consequence

- The release gate passes on a memory-starved host with no environment variable.
- `VERIFY_HEAVY_CONCURRENCY` is unchanged for anyone who sets it, including on a
  host the measurement would have throttled.
- A red heavy lane names itself, in the foreground and in the background.
- `HEAVY_LANE_MEMORY_GIB` is a measured constant. When the lanes grow it will be
  wrong, and the way to move it is to sample `MemAvailable` again, not to guess.

## Related

- ADR 0161 — a gate that recognises one error is blind to every other.
