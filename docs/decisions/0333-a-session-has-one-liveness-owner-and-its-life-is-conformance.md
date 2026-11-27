---
title: "ADR 0333: A session's liveness has one owner, and its life is part of driver conformance"
description: "Every agent-executor driver asks one `sessionLiveness` whether its session can still be used, and one pair of guards in `engine-requests` decides what `interrupt` and `respond` do once a turn or its session stopped; `runAgentEngineConformance` checks abort, close, interrupt after the end and repeated close on every driver, with every wait bounded."
type: decision
status: accepted
created: 2026-11-27
updated: 2026-11-27
---

# ADR 0333: A session's liveness has one owner, and its life is part of driver conformance

**Relations:** Extends [ADR 0316](0316-agent-executor-drivers-and-contract.md) (the drivers and their one contract) and applies [ADR 0199](0199-one-owner-per-name-and-one-way-per-job.md) to them; changes no earlier decision. Serves **I8** and **I9**.

## Context

A driver session stops for one of four reasons: its owner closed it, its engine was lost, the
caller's signal aborted, or the session aborted itself. Each of the five implementations — the
Claude CLI, the Agent SDK leaf, ACP, Codex (a session, a control connection, a shared server and
its threads) and the replay driver — kept its own `closing` and `dead` flags and wrote its own
chain of checks, in two different orders. The same was true one level down: three hand-written
guards of `turn.interrupt()` with three orders of "answer what the turn holds" and "tell the
engine", a `settled` flag set by hand at every end of a turn, and two copies of the handlers'
"is this session still alive".

The conformance kit proved a turn's content and never its life. Three patch releases in a row
followed: a fix for `respond` after `close()` in ACP was a fix every other driver needed and did
not get, because nothing shared the rule and nothing checked it. The replay driver, written to
stand in for all of them, ignored the caller's signal altogether, and a turn waiting on an answer
hung forever when its caller aborted.

## Decision

1. **One owner of liveness.** `sessionLiveness({ closedMessage, caller, linked, within? })`, beside
   `sessionAbort` in `session-primitives.ts`, is the only place a session's stop is decided. Its
   order is fixed: closing, then the recorded loss (`markLost`, first loss kept), then the owner
   the session lives in (`within` — a shared server for its threads), then the caller's abort,
   then the session's own. `terminated()` leaves the close out — it says whether the engine still
   reads — and `closingGracefully` is "closing and not terminated". No driver declares a `closing`
   or `dead` flag or reads `signal.aborted` to decide liveness.
2. **One pair of turn guards.** `interruptEngineTurn` makes `interrupt()` a no-op on a settled
   turn or a stopped session, and otherwise marks the turn, answers every request it holds, and
   only then tells the engine. `respondToEngineRequest` refuses with the session's reason, then
   with the turn's own failure, then names the request unknown. `settled` and `lost` are written by
   `endEngineTurn`, `loseEngineTurn` and `abandonEngineTurn` and by nothing else.
3. **One starter and one Claude router.** Every driver's `startTurn` is `guardedTurnStarter`; the
   Claude CLI and the Agent SDK leaf apply a record through `routeClaudeRecord`, and differ only in
   the hooks they pass.
4. **A session's life is conformance.** `runAgentEngineConformance` ends with
   `checkAbortAndTeardown`: `open` given an aborted signal, or one aborted from the startup
   observer, refuses with the caller's reason; an abort in a turn fails its stream with that reason
   and refuses `respond` and `startTurn` with it; `interrupt` after the end, an abort or a close
   resolves; `close()` in a turn fails the turn, is one close however often it is called, and
   leaves the startup observer silent. Every wait is bounded, so a driver that hangs fails by the
   name of the check. Capabilities are checked for every driver: what it declares equals what
   `info()` reports, declared or not.
5. **A decision the host makes is not contained.** `stdoutLineFilter` decides whether a line is
   protocol; when it throws there is no decision to act on, so the connection fails closed with an
   error that names the filter and carries the cause. Containing it, as an observer's failure is
   contained, would mean guessing the answer.

## Consequences

- A rule about a stopped session is written once and reaches every driver, the replay driver
  included; a driver written outside the package is held to it by the kit.
- The kit is stricter: a driver that passed before can fail it now. That is a breaking change of
  `stitchkit/agent-executor/testing`, recorded as one.
- Three things the kit cannot see stay in driver tests: that an interrupt of an ended turn writes
  nothing to the engine, that a driver's own observers (`onUpdate`, `onNotification`, `onEvent`)
  are silent after a stop, and what a second `close()` waits for.
- On Codex the transport refuses the same calls a stopped session refuses (a closed peer, a raced
  abort), so removing the liveness answer alone leaves its conformance green; removing either
  guard does not.
