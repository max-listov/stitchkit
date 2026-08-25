---
title: A provider failure reports itself as a policy stop
description: A stream that errors mid-run still delivers a finish chunk, and the finish branch overwrites the provider_failure reason with policy_stop — naming a stop policy that does not exist.
type: task
status: inbox
created: 2026-08-25
updated: 2026-08-25
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

- [ ] Decide the precedence explicitly: a reason already set by an `error` part
      is not overwritten by the `finish` that follows it.
- [ ] Check the other non-`stop` finish reasons the SDK can deliver — `length`,
      `content-filter`, `tool-calls` — and whether `policy_stop` is the right
      name for any of them, or whether they need reasons of their own.

## Acceptance

- [ ] A test streams a provider error and reads `provider_failure`. It must fail
      against today's code.
- [ ] A test proves `policy_stop` always arrives with a `policyName`.
