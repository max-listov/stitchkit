---
title: A provider failure reports itself as a policy stop
description: A stream that errors mid-run still delivers a finish chunk, and the finish branch overwrites the provider_failure reason with policy_stop — naming a stop policy that does not exist.
type: task
status: done
created: 2026-08-25
updated: 2026-08-25
completed: 2026-08-25 14:59 +0000
---

## Зачем

Found while validating an unrelated change, and unrelated to it — this predates
the spend work and is untouched by it.

A provider error mid-stream sets `terminalReason = 'provider_failure'`
(`run-execution.ts`, the `part.type === 'error'` branch). The provider then still
delivers a `finish` chunk, whose `finishReason` is not `'stop'`, and the next
branch overwrites the reason:

```ts
} else if (part.type === 'finish' && part.finishReason !== 'stop') {
  terminalReason = 'policy_stop';
}
```

A probe run against a stream that errors reports `terminalReason: 'policy_stop'`
with **no `policyName`** — a stop policy that does not exist, standing in for a
provider failure. An operator reading the terminal reason is told the run stopped
because the application asked it to.

Spend on that path is reported correctly; only the reason is wrong.

## Результат

- A run that failed at the provider says `provider_failure`.
- `policy_stop` appears only when a policy actually stopped the run, and carries
  the name of the policy that did.

## План

- [x] Decide the precedence explicitly: a reason already set by an `error` part
      is not overwritten by the `finish` that follows it.
- [x] Check the other non-`stop` finish reasons the SDK can deliver — `length`,
      `content-filter`, `tool-calls` — and whether `policy_stop` is the right
      name for any of them, or whether they need reasons of their own.

## Acceptance

- [x] A test streams a provider error and reads `provider_failure`. It must fail
      against today's code.
- [x] A test proves `policy_stop` always arrives with a `policyName`.

## Что сделано

- [x] Precedence decided and enforced: a terminal reason an `error` or `abort`
      part already set is never overwritten by the `finish` that follows it —
      `run-execution.ts`. The provider's own error and the finish chunk describe
      one event, and the later one used to win.
- [x] The other non-`stop` finish reasons got their own name rather than
      borrowing `policy_stop`: `'provider_stop'` joins
      `AgentTerminalReasonSchema` for a cap the provider hit — length, content
      filter — with the raw finish reason recorded in the operator-only
      `internalCause` instead of growing an enum member per provider verb.
      `assistantStatus` and `terminalState` gained the arm in their single homes.
- [x] **`policy_stop` now only ever comes from a named policy.**

### Tests

- [x] `packages/core/tests/agent-runtime-spend.test.ts` →
      `a provider failure is not a policy stop`
- [x] `packages/core/tests/agent-runtime-spend.test.ts` →
      `policy_stop never arrives without the policy that caused it`
- [x] `packages/core/tests/agent-runtime-parity.test.ts` →
      `distinguishes empty success from a provider-truncated terminal result`,
      updated: it was named for the distinction and asserted the conflation.
