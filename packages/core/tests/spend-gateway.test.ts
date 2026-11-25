import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSpendGateway,
  createSpooledSpendStore,
  mergeSpendReceipt,
  openAiCompatibleUsage,
  runWithSpendAttribution,
  type SpendGatewayConfig,
  SpendGatewayError,
  type SpendReceipt,
} from '../src/entrypoints/spend';
import { memorySpendLedger } from './support/spend-ledger';

const ORIGIN = 'https://models.example';
const live = { purpose: 'live', scope: 'space-1', labels: { env: 'dev' } };

type Seen = { request: Request; beganFirst: boolean };

function gatewayWith(
  ledger: ReturnType<typeof memorySpendLedger>,
  respond: (request: Request) => Response | Promise<Response>,
  extra: Partial<SpendGatewayConfig> = {},
) {
  const seen: Seen[] = [];
  let ids = 0;
  const gateway = createSpendGateway({
    store: ledger.store,
    providers: [
      {
        name: 'models',
        origin: ORIGIN,
        headers: () => ({ authorization: 'Bearer provider-key' }),
        facts: openAiCompatibleUsage,
      },
    ],
    newAttemptId: () => `attempt-${++ids}`,
    fetch: async (request) => {
      seen.push({
        request,
        beganFirst: ledger.attempts.has(request.headers.get('x-request-id') ?? ''),
      });
      return respond(request);
    },
    ...extra,
  });
  return { call: gateway.fetchFor('models'), seen };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function sse(events: string[], options: { breakAfter?: number } = {}): Response {
  const encoder = new TextEncoder();
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (options.breakAfter !== undefined && index === options.breakAfter) {
        controller.error(new Error('connection reset'));
        return;
      }
      const event = events[index];
      index += 1;
      if (event === undefined) controller.close();
      else controller.enqueue(encoder.encode(event));
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

describe('the spend gateway', () => {
  test('records the attempt before the call, sends only its own credentials, and closes with the usage', async () => {
    const ledger = memorySpendLedger();
    const { call, seen } = gatewayWith(ledger, () =>
      json({
        id: 'gen-1',
        model: 'm-resolved',
        usage: { prompt_tokens: 10, completion_tokens: 4, cost: 0.002 },
      }),
    );
    const response = await runWithSpendAttribution(live, () =>
      call(`${ORIGIN}/v1/chat`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer smuggled',
          'x-api-key': 'smuggled',
          'content-type': 'application/json',
        },
        body: '{}',
      }),
    );
    expect(await response.json()).toMatchObject({ id: 'gen-1' });
    const request = seen[0]?.request;
    expect(seen[0]?.beganFirst).toBe(true);
    expect(request?.headers.get('authorization')).toBe('Bearer provider-key');
    expect(request?.headers.get('x-api-key')).toBeNull();
    expect(request?.headers.get('x-request-id')).toBe('attempt-1');
    expect(request?.redirect).toBe('error');
    expect(ledger.attempts.get('attempt-1')).toMatchObject({
      gateway: 'models',
      attribution: live,
      request: { method: 'POST', origin: ORIGIN, path: '/v1/chat' },
    });
    expect(await ledger.settled('attempt-1')).toMatchObject({
      outcome: 'succeeded',
      rank: 2,
      facts: {
        providerRequestId: 'gen-1',
        resolvedModel: 'm-resolved',
        inputTokens: 10,
        outputTokens: 4,
        costUsd: 0.002,
        costStatus: 'reported',
        httpStatus: 200,
      },
    });
  });

  test('refuses before writing or sending: unknown provider, foreign origin, no attribution', async () => {
    const ledger = memorySpendLedger();
    const { call, seen } = gatewayWith(ledger, () => json({}));
    expect(() =>
      createSpendGateway({ store: ledger.store, providers: [] }).fetchFor('x'),
    ).toThrow(SpendGatewayError);
    await expect(
      runWithSpendAttribution(live, () => call('https://elsewhere.example/v1')),
    ).rejects.toMatchObject({ code: 'origin-mismatch' });
    await expect(call(`${ORIGIN}/v1`)).rejects.toMatchObject({ code: 'no-attribution' });
    expect(ledger.attempts.size).toBe(0);
    expect(seen).toHaveLength(0);
  });

  test('a ledger that refuses the attempt stops the call', async () => {
    const ledger = memorySpendLedger();
    ledger.setDown(true);
    const { call, seen } = gatewayWith(ledger, () => json({}));
    await expect(
      runWithSpendAttribution(live, () => call(`${ORIGIN}/v1`)),
    ).rejects.toMatchObject({
      code: 'intent-unrecorded',
    });
    expect(seen).toHaveLength(0);
  });

  test('a stream is passed through unchanged and closed with its final usage event', async () => {
    const ledger = memorySpendLedger();
    const events = [
      'data: {"id":"gen-2","choices":[{"delta":{"content":"he"}}]}\n\n',
      'data: {"id":"gen-2","choices":[{"delta":{"content":"llo"}}]}\n',
      '\ndata: {"id":"gen-2","usage":{"prompt_tokens":3,"completion_tokens":2,"completion_tokens_details":{"reasoning_tokens":1}}}\n\n',
      'data: [DONE]\n\n',
    ];
    const { call } = gatewayWith(ledger, () => sse(events));
    const response = await runWithSpendAttribution(live, () => call(`${ORIGIN}/v1/chat`));
    expect(await response.text()).toBe(events.join(''));
    expect(await ledger.settled('attempt-1')).toMatchObject({
      outcome: 'succeeded',
      rank: 1,
      facts: {
        providerRequestId: 'gen-2',
        inputTokens: 3,
        outputTokens: 2,
        reasoningTokens: 1,
        costStatus: 'pending',
      },
    });
    expect((await ledger.settled('attempt-1')).facts.costUsd).toBeUndefined();
  });

  test('a stream broken by the network, or cancelled by its reader, is still closed', async () => {
    const broken = memorySpendLedger();
    const first = gatewayWith(broken, () =>
      sse(['data: {"id":"a"}\n\n', 'data: {"id":"a"}\n\n'], { breakAfter: 1 }),
    );
    const response = await runWithSpendAttribution(live, () => first.call(`${ORIGIN}/v1`));
    await expect(response.text()).rejects.toThrow('connection reset');
    // A 200 stream that already yielded a providerRequestId may still be billed and reconciled.
    expect(await broken.settled('attempt-1')).toMatchObject({
      outcome: 'failed',
      facts: { costStatus: 'pending', providerRequestId: 'a' },
    });

    const brokenWithoutId = memorySpendLedger();
    const noId = gatewayWith(brokenWithoutId, () =>
      sse(['data: {"choices":[]}\n\n', 'data: {"choices":[]}\n\n'], { breakAfter: 1 }),
    );
    const noIdRes = await runWithSpendAttribution(live, () => noId.call(`${ORIGIN}/v1`));
    await expect(noIdRes.text()).rejects.toThrow('connection reset');
    expect(await brokenWithoutId.settled('attempt-1')).toMatchObject({
      outcome: 'failed',
      facts: { costStatus: 'unknown' },
    });

    const cancelled = memorySpendLedger();
    const second = gatewayWith(cancelled, () =>
      sse(['data: {"id":"b"}\n\n', 'data: {"id":"b"}\n\n']),
    );
    const reader = (
      await runWithSpendAttribution(live, () => second.call(`${ORIGIN}/v1`))
    ).body?.getReader();
    await reader?.read();
    await reader?.cancel('user stopped');
    expect(await cancelled.settled('attempt-1')).toMatchObject({ outcome: 'aborted' });
  });

  test('a transport failure and an HTTP error close the attempt with an unknown cost', async () => {
    const down = memorySpendLedger();
    const failing = gatewayWith(down, () => {
      throw new TypeError('fetch failed');
    });
    await expect(
      runWithSpendAttribution(live, () => failing.call(`${ORIGIN}/v1`)),
    ).rejects.toThrow('fetch failed');
    expect(await down.settled('attempt-1')).toMatchObject({
      outcome: 'failed',
      facts: { costStatus: 'unknown', failureCode: 'transport', failureMessage: 'TypeError' },
    });
    expect((await down.settled('attempt-1')).facts.costUsd).toBeUndefined();

    const aborted = memorySpendLedger();
    const abortable = gatewayWith(aborted, (request) => {
      throw request.signal.reason ?? new Error('aborted');
    });
    const controller = new AbortController();
    controller.abort(new DOMException('stop', 'AbortError'));
    await expect(
      runWithSpendAttribution(live, () =>
        abortable.call(`${ORIGIN}/v1`, { signal: controller.signal }),
      ),
    ).rejects.toThrow();
    expect(await aborted.settled('attempt-1')).toMatchObject({ outcome: 'aborted' });

    const refused = memorySpendLedger();
    const erroring = gatewayWith(refused, () => json({ error: 'overloaded' }, 529));
    const response = await runWithSpendAttribution(live, () => erroring.call(`${ORIGIN}/v1`));
    await response.text();
    expect(await refused.settled('attempt-1')).toMatchObject({
      outcome: 'failed',
      facts: { httpStatus: 529, failureCode: 'http-529', costStatus: 'unknown' },
    });
  });

  test('the runtime context fills what the explicit attribution leaves out, and nested attribution refines', async () => {
    const ledger = memorySpendLedger();
    const { call } = gatewayWith(ledger, () => json({}), {
      context: () => ({ runId: 'run-7', step: 2, purpose: 'background' }),
    });
    await runWithSpendAttribution(live, () =>
      runWithSpendAttribution({ purpose: 'title', labels: { agentId: 'a-1' } }, async () => {
        await (await call(`${ORIGIN}/v1`)).text();
      }),
    );
    expect(ledger.attempts.get('attempt-1')?.attribution).toEqual({
      purpose: 'title',
      scope: 'space-1',
      runId: 'run-7',
      step: 2,
      labels: { env: 'dev', agentId: 'a-1' },
    });
  });

  test('merges labels across runtime context and explicit attribution without erasing undefined overrides', async () => {
    const disjointLedger = memorySpendLedger();
    const disjoint = gatewayWith(disjointLedger, () => json({}), {
      context: () => ({
        scope: 'space-ctx',
        runId: 'run-1',
        labels: { env: 'dev', region: 'us' },
      }),
    });
    await runWithSpendAttribution(
      { purpose: 'live', labels: { agentId: 'a-1' } },
      async () => {
        await (await disjoint.call(`${ORIGIN}/v1`)).text();
      },
    );
    expect(disjointLedger.attempts.get('attempt-1')?.attribution).toEqual({
      purpose: 'live',
      scope: 'space-ctx',
      runId: 'run-1',
      labels: { env: 'dev', region: 'us', agentId: 'a-1' },
    });

    const collidingLedger = memorySpendLedger();
    const colliding = gatewayWith(collidingLedger, () => json({}), {
      context: () => ({ labels: { env: 'dev', region: 'us' } }),
    });
    await runWithSpendAttribution(
      { purpose: 'live', labels: { env: 'prod', agentId: 'a-2' } },
      async () => {
        await (await colliding.call(`${ORIGIN}/v1`)).text();
      },
    );
    expect(collidingLedger.attempts.get('attempt-1')?.attribution).toEqual({
      purpose: 'live',
      labels: { env: 'prod', region: 'us', agentId: 'a-2' },
    });

    const undefinedOverrideLedger = memorySpendLedger();
    const undefinedOverride = gatewayWith(undefinedOverrideLedger, () => json({}), {
      context: () => ({ scope: 'space-ctx', labels: { env: 'dev' } }),
    });
    await runWithSpendAttribution(
      { purpose: 'live', scope: undefined, labels: undefined },
      async () => {
        await (await undefinedOverride.call(`${ORIGIN}/v1`)).text();
      },
    );
    expect(undefinedOverrideLedger.attempts.get('attempt-1')?.attribution).toEqual({
      purpose: 'live',
      scope: 'space-ctx',
      labels: { env: 'dev' },
    });

    const nestedUndefinedLedger = memorySpendLedger();
    const nestedUndefined = gatewayWith(nestedUndefinedLedger, () => json({}));
    await runWithSpendAttribution(
      { purpose: 'live', scope: 'space-outer', labels: { env: 'dev' } },
      () =>
        runWithSpendAttribution(
          { purpose: 'title', scope: undefined, labels: undefined },
          async () => {
            await (await nestedUndefined.call(`${ORIGIN}/v1`)).text();
          },
        ),
    );
    expect(nestedUndefinedLedger.attempts.get('attempt-1')?.attribution).toEqual({
      purpose: 'title',
      scope: 'space-outer',
      labels: { env: 'dev' },
    });

    const absentLabelsLedger = memorySpendLedger();
    const absentLabels = gatewayWith(absentLabelsLedger, () => json({}), {
      context: () => ({ runId: 'run-2' }),
    });
    await runWithSpendAttribution({ purpose: 'live' }, async () => {
      await (await absentLabels.call(`${ORIGIN}/v1`)).text();
    });
    const absentAttribution = absentLabelsLedger.attempts.get('attempt-1')?.attribution;
    expect(absentAttribution).toEqual({ purpose: 'live', runId: 'run-2' });
    expect(absentAttribution?.labels).toBeUndefined();
    expect(absentAttribution !== undefined && 'labels' in absentAttribution).toBe(false);

    const emptyLabelsLedger = memorySpendLedger();
    const emptyLabels = gatewayWith(emptyLabelsLedger, () => json({}), {
      context: () => ({ labels: {} }),
    });
    await runWithSpendAttribution({ purpose: 'live' }, async () => {
      await (await emptyLabels.call(`${ORIGIN}/v1`)).text();
    });
    const emptyAttribution = emptyLabelsLedger.attempts.get('attempt-1')?.attribution;
    expect(emptyAttribution).toEqual({ purpose: 'live' });
    expect(emptyAttribution?.labels).toBeUndefined();
    expect(emptyAttribution !== undefined && 'labels' in emptyAttribution).toBe(false);

    const undefinedLabelValueLedger = memorySpendLedger();
    const labelsWithUndefined: Record<string, string> = {};
    Reflect.set(labelsWithUndefined, 'env', 'dev');
    Reflect.set(labelsWithUndefined, 'drop', undefined);
    const undefinedLabelValue = gatewayWith(undefinedLabelValueLedger, () => json({}), {
      context: () => ({
        scope: 'space-ctx',
        labels: labelsWithUndefined,
      }),
    });
    await runWithSpendAttribution(
      { purpose: 'live', labels: { agentId: 'a-3' } },
      async () => {
        await (await undefinedLabelValue.call(`${ORIGIN}/v1`)).text();
      },
    );
    expect(undefinedLabelValueLedger.attempts.get('attempt-1')?.attribution).toEqual({
      purpose: 'live',
      scope: 'space-ctx',
      labels: { env: 'dev', agentId: 'a-3' },
    });

    const invalidLabelsLedger = memorySpendLedger();
    const invalidLabels = gatewayWith(invalidLabelsLedger, () => json({}), {
      context: () => JSON.parse('{"purpose":"live","labels":"not-a-record"}'),
    });
    await expect(invalidLabels.call(`${ORIGIN}/v1`)).rejects.toMatchObject({
      code: 'no-attribution',
    });
    expect(invalidLabelsLedger.attempts.size).toBe(0);
  });
});

describe('a spooled spend ledger', () => {
  test('a database that is down does not stop the call; recover delivers attempt before receipt', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'stitchkit-spend-spool-'));
    try {
      const ledger = memorySpendLedger();
      ledger.setDown(true);
      const path = join(directory, 'spend.ndjson');
      const spooled = createSpooledSpendStore({ store: ledger.store, path });
      const { call, seen } = gatewayWith({ ...ledger, store: spooled }, () =>
        json({ id: 'gen-3', usage: { cost: 0.01 } }),
      );
      await (await runWithSpendAttribution(live, () => call(`${ORIGIN}/v1`))).text();
      expect(seen).toHaveLength(1);
      await Bun.sleep(20);
      expect(spooled.pending()).toBe(2);

      ledger.setDown(false);
      const recovered = createSpooledSpendStore({ store: ledger.store, path });
      expect(await recovered.recover()).toEqual({ replayed: 2, failed: 0 });
      expect(ledger.order).toEqual(['begin:attempt-1', 'settle:attempt-1']);
      expect(ledger.receipts.get('attempt-1')).toMatchObject({
        outcome: 'succeeded',
        facts: { costUsd: 0.01 },
      });
      // A second replay of the same file is a no-op: nothing is left undelivered.
      expect(await createSpooledSpendStore({ store: ledger.store, path }).recover()).toEqual({
        replayed: 0,
        failed: 0,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('when neither the spool nor the database can take the attempt, the call is refused', async () => {
    const ledger = memorySpendLedger();
    ledger.setDown(true);
    const spooled = createSpooledSpendStore({
      store: ledger.store,
      path: '/proc/stitchkit-spend-cannot-write-here/spend.ndjson',
    });
    const { call, seen } = gatewayWith({ ...ledger, store: spooled }, () => json({}));
    await expect(
      runWithSpendAttribution(live, () => call(`${ORIGIN}/v1`)),
    ).rejects.toMatchObject({
      code: 'intent-unrecorded',
    });
    expect(seen).toHaveLength(0);
  });
});

describe('mergeSpendReceipt', () => {
  const at = (second: number) => `2026-11-24T00:00:${String(second).padStart(2, '0')}.000Z`;
  const receipt = (patch: Partial<SpendReceipt>): SpendReceipt => ({
    attemptId: 'a',
    rank: 1,
    at: at(1),
    outcome: 'succeeded',
    facts: { costStatus: 'pending' },
    ...patch,
  });

  test('a higher rank adds what it knows, keeps what it does not, and a reported cost is never erased', () => {
    const transport = receipt({
      facts: { costStatus: 'pending', inputTokens: 5, httpStatus: 200 },
    });
    const reconciled = receipt({
      rank: 3,
      at: at(9),
      facts: { costStatus: 'reported', costUsd: 0.4 },
    });
    const merged = mergeSpendReceipt(transport, reconciled);
    expect(merged).toMatchObject({
      rank: 3,
      facts: { costStatus: 'reported', costUsd: 0.4, inputTokens: 5, httpStatus: 200 },
    });
    // A late transport receipt and a later guess change nothing that counts.
    expect(mergeSpendReceipt(merged, transport)).toMatchObject({
      rank: 3,
      facts: { costUsd: 0.4 },
    });
    expect(
      mergeSpendReceipt(
        merged,
        receipt({ rank: 3, at: at(10), facts: { costStatus: 'estimated', costUsd: 9 } }),
      ).facts,
    ).toMatchObject({ costStatus: 'reported', costUsd: 0.4 });
  });

  test('a closed outcome never returns to pending, and pending or unknown never carry a number', () => {
    const closed = receipt({ outcome: 'failed', facts: { costStatus: 'unknown' } });
    const later = receipt({
      rank: 3,
      outcome: 'pending',
      facts: { costStatus: 'pending', costUsd: 1 },
    });
    const merged = mergeSpendReceipt(closed, later);
    expect(merged.outcome).toBe('failed');
    expect(merged.facts.costUsd).toBeUndefined();
    expect(() => mergeSpendReceipt(closed, { ...later, attemptId: 'b' })).toThrow(TypeError);
  });
});

describe('gateway and spool options', () => {
  test('an event longer than maxEventLength is passed through but not parsed', async () => {
    const ledger = memorySpendLedger();
    const big = JSON.stringify({ id: 'gen-big', padding: 'x'.repeat(200) });
    const { call } = gatewayWith(ledger, () => json(JSON.parse(big)), { maxEventLength: 100 });
    const text = await (
      await runWithSpendAttribution(live, () => call(`${ORIGIN}/v1`))
    ).text();
    expect(text).toBe(big);
    expect((await ledger.settled('attempt-1')).facts.providerRequestId).toBeUndefined();
    const roomy = memorySpendLedger();
    const second = gatewayWith(roomy, () => json(JSON.parse(big)), { maxEventLength: 1000 });
    await (await runWithSpendAttribution(live, () => second.call(`${ORIGIN}/v1`))).text();
    expect((await roomy.settled('attempt-1')).facts.providerRequestId).toBe('gen-big');
  });

  test('now times the attempt, and onLedgerError sees a close the ledger refused', async () => {
    const ledger = memorySpendLedger();
    const clock = [0, 1500, 4000];
    const failures: { attemptId: string; error: unknown }[] = [];
    const { call } = gatewayWith(ledger, () => sse(['data: {"id":"t"}\n\n']), {
      now: () => new Date(Date.UTC(2026, 10, 24) + (clock.shift() ?? 4000)),
      onLedgerError: (failure) => failures.push(failure),
    });
    await (await runWithSpendAttribution(live, () => call(`${ORIGIN}/v1`))).text();
    expect(await ledger.settled('attempt-1')).toMatchObject({
      at: '2026-11-24T00:00:04.000Z',
      facts: { durationMs: 4000, ttftMs: 1500 },
    });

    const refusing = memorySpendLedger();
    const original = refusing.store.settle;
    refusing.store.settle = async () => {
      throw new Error('ledger full');
    };
    const second = gatewayWith(refusing, () => json({}), {
      onLedgerError: (failure) => failures.push(failure),
    });
    const response = await runWithSpendAttribution(live, () => second.call(`${ORIGIN}/v1`));
    expect(response.status).toBe(200);
    await response.text();
    await Bun.sleep(10);
    expect(failures).toEqual([{ attemptId: 'attempt-1', error: new Error('ledger full') }]);
    refusing.store.settle = original;
  });

  test('the spool bounds refuse what they cannot hold, and onSpoolError says why', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'stitchkit-spend-bounds-'));
    try {
      const ledger = memorySpendLedger();
      ledger.setDown(true);
      const errors: string[] = [];
      const attempt = (attemptId: string) => ({
        attemptId,
        gateway: 'models',
        startedAt: '2026-11-24T00:00:00.000Z',
        attribution: { purpose: 'live' },
        request: { method: 'POST', origin: ORIGIN, path: '/v1' },
      });
      const byCount = createSpooledSpendStore({
        store: ledger.store,
        path: join(directory, 'count.ndjson'),
        maxPendingEntries: 1,
        onSpoolError: ({ error }) => errors.push(String(error)),
      });
      await byCount.begin(attempt('one'));
      // Kept nowhere: the refusal says so, and carries the database's as its cause.
      await expect(byCount.begin(attempt('two'))).rejects.toMatchObject({
        code: 'SPOOL_UNSPOOLED',
        cause: expect.objectContaining({
          message: expect.stringContaining('database unreachable'),
        }),
      });
      expect(errors.some((error) => error.includes('bound of 1 undelivered'))).toBe(true);

      const bySize = createSpooledSpendStore({
        store: ledger.store,
        path: join(directory, 'size.ndjson'),
        maxFileBytes: 64,
        onSpoolError: ({ error }) => errors.push(String(error)),
      });
      // Kept nowhere: the refusal says so, and carries the database's as its cause.
      await expect(bySize.begin(attempt('three'))).rejects.toMatchObject({
        code: 'SPOOL_UNSPOOLED',
        cause: expect.objectContaining({
          message: expect.stringContaining('database unreachable'),
        }),
      });
      expect(errors.some((error) => error.includes('64-byte bound'))).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

test('a replay that is refused on the attempt never delivers its receipt ahead of it', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stitchkit-spend-order-'));
  try {
    const ledger = memorySpendLedger();
    ledger.setDown(true);
    const path = join(directory, 'spend.ndjson');
    const spooled = createSpooledSpendStore({ store: ledger.store, path });
    await spooled.begin({
      attemptId: 'ordered',
      gateway: 'models',
      startedAt: '2026-11-24T00:00:00.000Z',
      attribution: { purpose: 'live' },
      request: { method: 'POST', origin: ORIGIN, path: '/v1' },
    });
    await spooled.settle({
      attemptId: 'ordered',
      rank: 1,
      at: '2026-11-24T00:00:01.000Z',
      outcome: 'succeeded',
      facts: { costStatus: 'pending' },
    });
    // The database is back, but still refuses attempts: the receipt must wait.
    ledger.setDown(false);
    const refusingBegin = {
      ...ledger.store,
      begin: async () => Promise.reject(new Error('attempts table locked')),
    };
    const recovering = createSpooledSpendStore({ store: refusingBegin, path });
    expect(await recovering.recover()).toEqual({ replayed: 2, failed: 2 });
    expect(ledger.order).toEqual([]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('findings of the implementation review', () => {
  test('a receipt without a reported cost goes through the spooled store, and undefined context fields are dropped', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'stitchkit-spend-pending-'));
    // The gateway settles after the body is read, and the spool marks the receipt delivered
    // after the ledger took it — past `ledger.settled`. Removing the directory before that
    // mark lands lets the spool recreate it, so the test waits for its own store's writes.
    const settling: Promise<void>[] = [];
    try {
      const ledger = memorySpendLedger();
      const spooled = createSpooledSpendStore({
        store: ledger.store,
        path: join(directory, 's.ndjson'),
      });
      const store = {
        ...spooled,
        settle: (receipt: Parameters<typeof spooled.settle>[0]) => {
          const settled = spooled.settle(receipt);
          settling.push(settled);
          return settled;
        },
      };
      const { call } = gatewayWith({ ...ledger, store }, () => json({ id: 'no-cost' }), {
        context: () => ({ runId: undefined, step: 1 }),
      });
      await (
        await runWithSpendAttribution({ purpose: 'live', scope: undefined }, () =>
          call(`${ORIGIN}/v1`),
        )
      ).text();
      expect(await ledger.settled('attempt-1')).toMatchObject({
        outcome: 'succeeded',
        facts: { costStatus: 'pending', providerRequestId: 'no-cost' },
      });
      expect(ledger.attempts.get('attempt-1')?.attribution).toEqual({
        purpose: 'live',
        step: 1,
      });
    } finally {
      await Promise.allSettled(settling);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('credentials that cannot be read stop the call before an attempt is opened', async () => {
    const ledger = memorySpendLedger();
    const gateway = createSpendGateway({
      store: ledger.store,
      providers: [
        {
          name: 'models',
          origin: ORIGIN,
          headers: () => {
            throw new Error('vault sealed');
          },
        },
      ],
    });
    await expect(
      runWithSpendAttribution(live, () => gateway.fetchFor('models')(`${ORIGIN}/v1`)),
    ).rejects.toThrow('vault sealed');
    expect(ledger.attempts.size).toBe(0);
  });

  test('a reader that throws or reports what is not a fact adds nothing, and the call still closes', async () => {
    const ledger = memorySpendLedger();
    let events = 0;
    const gateway = createSpendGateway({
      store: ledger.store,
      newAttemptId: () => 'attempt-1',
      fetch: async () => json({ id: 'x'.repeat(300), usage: { cost: 0.5 } }),
      providers: [
        {
          name: 'models',
          origin: ORIGIN,
          headers: () => ({}),
          facts: {
            headers: () => {
              throw new Error('reader bug');
            },
            event: (value) => {
              events += 1;
              return openAiCompatibleUsage.event?.(value) ?? {};
            },
          },
        },
      ],
    });
    const response = await runWithSpendAttribution(live, () =>
      gateway.fetchFor('models')(`${ORIGIN}/v1`),
    );
    expect((await response.json()).id).toHaveLength(300);
    expect(events).toBe(1);
    const receipt = await ledger.settled('attempt-1');
    expect(receipt.outcome).toBe('succeeded');
    expect(receipt.facts.providerRequestId).toBeUndefined();
    // The out-of-bounds id is dropped alone: the reported cost beside it stays.
    expect(receipt.facts).toMatchObject({ costStatus: 'reported', costUsd: 0.5 });
  });

  test('a ledger whose settle throws synchronously reaches onLedgerError, not the caller', async () => {
    const ledger = memorySpendLedger();
    const failures: unknown[] = [];
    ledger.store.settle = () => {
      throw new Error('sync ledger bug');
    };
    const { call } = gatewayWith(ledger, () => json({}), {
      onLedgerError: ({ error }) => failures.push(error),
    });
    const response = await runWithSpendAttribution(live, () => call(`${ORIGIN}/v1`));
    expect(await response.json()).toEqual({});
    await Bun.sleep(10);
    expect(failures).toEqual([new Error('sync ledger bug')]);
  });

  test('a receipt whose attempt is still undelivered waits on disk with it, in the live path too', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'stitchkit-spend-live-order-'));
    try {
      const ledger = memorySpendLedger();
      let refuseBegin = true;
      const store = {
        ...ledger.store,
        begin: async (attempt: Parameters<typeof ledger.store.begin>[0]) => {
          if (refuseBegin) throw new Error('attempts table locked');
          return ledger.store.begin(attempt);
        },
      };
      const path = join(directory, 'spend.ndjson');
      const spooled = createSpooledSpendStore({ store, path });
      const { call } = gatewayWith({ ...ledger, store: spooled }, () => json({ id: 'g' }));
      await (await runWithSpendAttribution(live, () => call(`${ORIGIN}/v1`))).text();
      await Bun.sleep(20);
      // The database took no receipt ahead of the attempt it could not take.
      expect(ledger.order).toEqual([]);
      refuseBegin = false;
      expect(await createSpooledSpendStore({ store, path }).recover()).toEqual({
        replayed: 2,
        failed: 0,
      });
      expect(ledger.order).toEqual(['begin:attempt-1', 'settle:attempt-1']);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('admit refuses before the call: recorded as refused, nothing sent', async () => {
    const ledger = memorySpendLedger();
    const { call, seen } = gatewayWith(ledger, () => json({}), {
      admit: (attempt) => {
        if (attempt.attribution.purpose === 'live') throw new Error('budget exhausted');
      },
    });
    await expect(
      runWithSpendAttribution(live, () => call(`${ORIGIN}/v1`)),
    ).rejects.toMatchObject({
      code: 'refused',
      cause: new Error('budget exhausted'),
    });
    expect(seen).toHaveLength(0);
    expect(ledger.receipts.get('attempt-1')).toMatchObject({
      outcome: 'refused',
      facts: { costStatus: 'free', costUsd: 0 },
    });
  });

  test('the gateway fetch is a fetch an SDK takes', () => {
    const ledger = memorySpendLedger();
    const sdkFetch: typeof fetch = gatewayWith(ledger, () => json({})).call;
    expect(typeof sdkFetch).toBe('function');
  });
});

describe('merge order', () => {
  const receipt = (patch: Partial<SpendReceipt>): SpendReceipt => ({
    attemptId: 'a',
    rank: 1,
    at: '2026-11-24T00:00:01.000Z',
    outcome: 'succeeded',
    facts: { costStatus: 'pending' },
    ...patch,
  });

  test('an orphan close never replaces a real one, and a real close replaces an orphan', () => {
    const real = receipt({ facts: { costStatus: 'pending', inputTokens: 3 } });
    const orphan = receipt({
      at: '2026-11-24T02:00:00.000Z',
      outcome: 'orphaned',
      facts: { costStatus: 'unknown' },
    });
    expect(mergeSpendReceipt(real, orphan)).toEqual(mergeSpendReceipt(undefined, real));
    expect(mergeSpendReceipt(orphan, real)).toEqual(mergeSpendReceipt(undefined, real));
  });

  test('equal ranks resolve by time, whatever order they arrive in', () => {
    const early = receipt({
      at: '2026-11-24T00:00:01.000Z',
      facts: { costStatus: 'pending', inputTokens: 1 },
    });
    const late = receipt({
      at: '2026-11-24T00:00:09.000Z',
      facts: { costStatus: 'pending', inputTokens: 2 },
    });
    expect(mergeSpendReceipt(early, late).facts.inputTokens).toBe(2);
    expect(mergeSpendReceipt(late, early).facts.inputTokens).toBe(2);
  });
});

test('a record an application writes with an undefined key is still spooled and delivered', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stitchkit-spend-undefined-'));
  try {
    const ledger = memorySpendLedger();
    const spooled = createSpooledSpendStore({
      store: ledger.store,
      path: join(directory, 's.ndjson'),
    });
    await spooled.begin({
      attemptId: 'app',
      gateway: 'models',
      startedAt: '2026-11-24T00:00:00.000Z',
      attribution: { purpose: 'live', scope: undefined },
      request: { method: 'POST', origin: ORIGIN, path: '/v1' },
    });
    await spooled.settle({
      attemptId: 'app',
      rank: 1,
      at: '2026-11-24T00:00:01.000Z',
      outcome: 'failed',
      facts: { costStatus: 'unknown', costUsd: undefined },
    });
    expect(ledger.order).toEqual(['begin:app', 'settle:app']);
    expect(spooled.pending()).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('openAiCompatibleUsage preserves providerRequestId and token counts when optional nested fields or cost are null', () => {
  const facts = openAiCompatibleUsage.event?.({
    id: 'gen-or-nulls',
    model: 'anthropic/claude-sonnet',
    usage: {
      prompt_tokens: 120,
      completion_tokens: 45,
      cost: null,
      prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: null },
      completion_tokens_details: { reasoning_tokens: null },
    },
  });
  expect(facts).toEqual({
    providerRequestId: 'gen-or-nulls',
    resolvedModel: 'anthropic/claude-sonnet',
    inputTokens: 120,
    outputTokens: 45,
    cacheReadTokens: 30,
  });
});
