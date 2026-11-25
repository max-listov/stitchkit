---
title: Spend
description: One door to paid model APIs — the attempt recorded before the call and closed on every outcome, a spooled ledger, rank-merged receipts, reconciliation and a coverage guard.
type: guide
status: active
created: 2026-11-24
updated: 2026-11-24
---

# Spend

`stitchkit/spend` is a server-only, peer-free, evolving entrypoint for accounting
every call to a paid model API. A call goes through the gateway; the gateway
records the attempt **before** the network sees a byte and closes it with what it
observed, whatever happens after. `stitchkit/spend/testing` holds the guard that
fails a project's tests when a call goes around the gateway.

## The gateway

```ts
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import {
  createSpendGateway,
  openAiCompatibleUsage,
  runWithSpendAttribution,
} from 'stitchkit/spend';

const gateway = createSpendGateway({
  store: ledger, // your SpendLedgerStore, usually spooled (below)
  providers: [
    {
      name: 'openrouter',
      origin: 'https://openrouter.ai',
      headers: () => ({ authorization: `Bearer ${secrets.openrouter()}` }),
      facts: openAiCompatibleUsage,
    },
  ],
  // Fill run, invocation and step from the agent runtime when the call is one of its attempts.
  context: modelInvocationSpendAttribution, // from stitchkit/agent-runtime
});

// The gateway adds the real key; the SDK only needs a placeholder to start.
const openrouter = createOpenRouter({ apiKey: 'set-by-gateway', fetch: gateway.fetchFor('openrouter') });

await runWithSpendAttribution({ purpose: 'title', scope: spaceId, labels: { env } }, () =>
  generateText({ model: openrouter('openai/gpt-5-mini'), prompt }),
);
```

What the gateway guarantees:

- **Recorded first.** `store.begin(attempt)` runs before the request is sent. A
  ledger that refuses it stops the call (`SpendGatewayError` `intent-unrecorded`):
  a call nothing accounts for does not happen.
- **Closed always.** Success, an HTTP error, a broken stream, a cancelled read, a
  transport failure: each ends in exactly one `store.settle(receipt)`. A ledger
  write that fails after the call went out is reported to `onLedgerError` and
  never fails the call.
- **Credentials stay home.** The provider's headers are added only when the URL is
  on its `origin` (`origin-mismatch` otherwise), any credential header the caller
  set is dropped, redirects are refused, and `x-request-id` carries the attempt id.
- **No call without a reason.** A call outside `runWithSpendAttribution` (and with
  no `purpose` from `context`) is refused: `no-attribution`, with the validation
  error as its cause.
- **Admission first.** `admit(attempt)` runs before anything is sent — a budget, a
  payer policy. Throwing refuses the call (`refused`): the attempt is recorded and
  closed as `refused`, and the provider never hears of it.
- **A body nobody reads is never closed.** The attempt closes when the response
  body ends, breaks or is cancelled; a caller that drops a response unread leaves
  it open until `closeOrphanedSpend`.
- **Cost is the provider's word.** `costUsd` is set only when the response reported
  it (`costStatus: 'reported'`). Otherwise it is `pending` for a reconciler, or
  `unknown` for a failed call — never a guessed zero.

The response stream reaches the caller byte for byte; the gateway reads server-sent
events or a JSON body alongside it, bounded by `maxEventLength`, to learn usage.

### Work that is not tokens

Seconds of transcribed audio, characters spoken, images made: the receipt's `workUnit` is a free
label and `workAmount` its number, filled by the provider's own `facts` reader from what the
response reports. The call is an ordinary upload through `fetchFor`, so the attempt is written
before it leaves and `admit` can refuse it first.

```ts
const secondsOfAudio: SpendFactsReader = {
  event: (body) => {
    const parsed = TranscriptionUsageSchema.safeParse(body) // your provider's response shape
    return parsed.success
      ? { providerRequestId: parsed.data.id, workUnit: 'audio-second', workAmount: parsed.data.seconds }
      : {}
  },
}
```

The amount on the receipt is what the response said. A quantity known only to the application
before the call — the length of the file it is about to send — is not part of the attempt; `admit`
decides from the attribution and the application's own state.

## The ledger

`SpendLedgerStore` is yours: `begin(attempt)` and `settle(receipt)`, both idempotent
on `attemptId`. Merge receipts with `mergeSpendReceipt` — or the same rule in SQL,
under a row lock — so a late receipt never erases what an earlier, better-informed
one learned. Ranks: 1 the gateway's transport view, 2 the response's reported
usage, 3 a reconciler's answer.

`createSpooledSpendStore({ store, path })` puts every attempt and receipt on disk
before the database is offered it. With the database down, calls go on and
`recover()` at the next start delivers what was spooled, in order — an attempt
always before its receipts, in the live path too: a receipt whose attempt the
database has not taken waits on disk with it. Delivery of what was spooled happens
at `recover()`, not in the background. Only a record that could be neither spooled
nor stored refuses the call.

## Afterwards

- `reconcilePendingSpend({ store, reconcilers })` asks each provider for the cost of
  attempts still `pending` (OpenRouter: `GET /api/v1/generation?id=`) and settles
  rank-3 receipts. The store needs `pendingCosts`.
- `closeOrphanedSpend({ store, olderThanMs })` closes attempts whose process never
  came back to them as `orphaned`, cost `unknown`. The store needs `openAttempts`.

## The coverage guard

```ts
import { test } from 'bun:test';
import { assertSpendCoverage } from 'stitchkit/spend/testing';

test('every model call goes through the spend gateway', async () => {
  await assertSpendCoverage({
    root: 'src',
    policy: {
      modules: [
        { module: 'ai', symbols: ['streamText', 'generateText', 'generateObject', 'streamObject'] },
        { module: '@openrouter/ai-sdk-provider' },
      ],
      envKeys: ['OPENROUTER_API_KEY'],
      hosts: ['openrouter.ai'],
      allowedFiles: [{ path: 'spend/gateway.ts', reason: 'the one door' }],
    },
  });
});
```

It is red on a value import of a listed module or one of its subpaths (static,
dynamic, `require`, a re-export; `@scope/*` lists a whole scope), on a listed key name anywhere in code (`process.env`, `Bun.env`,
`import.meta.env`, destructuring, an interpolation), on a listed host in a string,
on an allowance whose file no longer touches anything listed, and on a scan that
saw no file. `import type` is ignored. It reads tokens, not types: a key or host
assembled from pieces at run time is not seen.
