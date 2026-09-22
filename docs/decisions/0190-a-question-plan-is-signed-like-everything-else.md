# 0190 — A question plan is part of the state it is asked in

**Status:** Accepted
**Date:** 2026-09-22

## Context

Multi-round tool input was declared before any call existed: an ordered list of
`{key, message, schema}` on the contract, indexed by round. That is enough when
the questions belong to the operation. It is not enough when they belong to the
**arguments** — one model takes `aspect_ratio`, another `duration`, a third an
input image — and there the declared list can only be empty. The consuming tool
ended up carrying an instruction in its own description telling the model to
fetch the schema first and not guess, which is a workaround for a mechanism the
protocol already has, and left a red validation error in the transcript where a
question belonged.

## Decision

`mcp.inputRequired` also accepts a function of the parsed call. Two things about
it are not obvious and are the reason this is an ADR rather than a changelog
line.

**The plan is fingerprinted into the signed state and checked every round.**
Between two rounds there is a full round trip to the host, and a resolver that
reads anything outside its arguments — a model catalog, a feature flag — can
answer differently the second time. Every existing check would still pass: same
principal, same operation, same argument digest, round still in range. Round 2's
question would be asked under round 1's key, accepted if the schemas happened to
be compatible, and the handler would receive an answer to a question nobody
asked, with nothing anywhere looking broken. A moved plan is now a refusal.

The first draft of this work claimed the argument digest already guaranteed
determinism. It does not, by construction: it proves the arguments did not
change and says nothing about the purity of a function. The test written for it
would have passed against any implementation.

**The guard runs before the resolver.** Resolving needs the parsed arguments,
and the only thing that authorises is a pipeline pass. Resolving first and
guarding second would be cheaper by one pass and would turn elicitation into an
unauthenticated trigger for consumer code that may reach a network. So a dynamic
declaration costs one extra pass per round — `beforeHandle` once more, one more
`input-round` audit row — and that price is measured in a test against a static
declaration rather than asserted in prose. Parsing itself is free: it is the same
pure function the call parses with, so the resolver cannot see a different value
than the handler will.

## Consequences

An empty resolved list is a legitimate answer — this call needs nothing — while
an empty **static** declaration remains an error, because writing one means
declaring a policy that can never ask anything. The asymmetry is deliberate.

`ctx.mcpInput` stays typed for a resolver that declares a precise return type:
the inference reads through the function rather than giving up on it.

A continuation minted before this release carries no fingerprint and is refused
once. Expect a few in the minutes after a deploy; they are not tampering.
