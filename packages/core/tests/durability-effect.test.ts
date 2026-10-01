import { describe, expect, test } from 'bun:test';
import {
  type AgentStoreEventEnvelope,
  createLocalStepDurability,
  EffectUnresolvedError,
  type StepDurabilityLedger,
} from '../src/entrypoints/tools';

/*
 * `step` records its result after the body, so a body cut short by a crash runs
 * again. For an effect in another system — a message sent, a turn started — the
 * repeat is worse than the loss. A consumer wrote the at-most-once rule by hand
 * seven times, and one copy drifted into sending a reply twice.
 */

/** A ledger the application owns, as a consumer would put over its own table. */
function ledger(): StepDurabilityLedger & { rows: AgentStoreEventEnvelope[] } {
  const rows: AgentStoreEventEnvelope[] = [];
  return {
    rows,
    appendEvent: async (input) => {
      const row: AgentStoreEventEnvelope = {
        schemaVersion: 1,
        eventId: `e${rows.length + 1}`,
        conversationId: input.conversationId,
        seq: rows.length + 1,
        kind: input.kind,
        occurredAt: new Date().toISOString(),
        payload: input.payload,
      };
      rows.push(row);
      return row;
    },
    readEvents: async (input) => ({
      items: rows.filter(
        (row) =>
          row.conversationId === input.conversationId && row.seq >= (input.fromSeq ?? 1),
      ),
    }),
  };
}

/** A fresh engine over the same ledger — what a restarted process builds. */
function engine(store: StepDurabilityLedger, signal?: AbortSignal) {
  return createLocalStepDurability({
    store,
    conversationId: 'c1',
    runId: 'r1',
    ...(signal && { signal }),
  });
}

/** A recipient that remembers what it was sent, by the sender's own id. */
function recipient() {
  const received = new Map<string, { turnId: string }>();
  let sends = 0;
  return {
    received,
    get sends() {
      return sends;
    },
    send(clientId: string) {
      sends += 1;
      const turn = { turnId: `turn-${sends}` };
      received.set(clientId, turn);
      return turn;
    },
  };
}

describe('durability.effect', () => {
  test('runs once, records the proof, and a replay returns it without running', async () => {
    const store = ledger();
    const peer = recipient();
    const handlers = {
      run: () => peer.send('msg-1'),
      reconcile: () => peer.received.get('msg-1') ?? null,
    };
    expect(await engine(store).effect('send', handlers)).toEqual({
      outcome: 'accepted',
      proof: { turnId: 'turn-1' },
    });
    expect(await engine(store).effect('send', handlers)).toEqual({
      outcome: 'accepted',
      proof: { turnId: 'turn-1' },
    });
    expect(peer.sends).toBe(1);
    expect(store.rows.map((row) => row.payload)).toEqual([
      { runId: 'r1', effectName: 'send', phase: 'intent' },
      {
        runId: 'r1',
        effectName: 'send',
        phase: 'accepted',
        encoded: '{"turnId":"turn-1"}',
        via: 'run',
      },
    ]);
  });

  test('a crash after the intent is settled by reconcile, never by run', async () => {
    // The process that ran the effect died before recording how it ended: the
    // recipient has the message, the ledger has only the intent.
    const store = ledger();
    const peer = recipient();
    await expect(
      engine(store).effect('send', {
        run: () => {
          peer.send('msg-1');
          throw new Error('connection reset before the acknowledgement');
        },
        reconcile: () => null,
      }),
    ).rejects.toThrow(EffectUnresolvedError);

    let ran = 0;
    const settled = await engine(store).effect('send', {
      run: () => {
        ran += 1;
        return peer.send('msg-1');
      },
      reconcile: () => peer.received.get('msg-1') ?? null,
    });
    expect(ran).toBe(0);
    expect(peer.sends).toBe(1);
    expect(settled).toEqual({ outcome: 'accepted', proof: { turnId: 'turn-1' } });
    expect(store.rows.at(-1)?.payload).toMatchObject({ phase: 'accepted', via: 'reconcile' });
  });

  test('not found at the recipient is uncertain, recorded, and never retried', async () => {
    const store = ledger();
    await engine(store)
      .effect('send', {
        run: () => {
          throw new Error('crashed mid-send');
        },
        reconcile: () => null,
      })
      .catch(() => undefined);

    let ran = 0;
    let reconciled = 0;
    const handlers = {
      run: () => {
        ran += 1;
        return { turnId: 'again' };
      },
      reconcile: () => {
        reconciled += 1;
        return null;
      },
    };
    expect(await engine(store).effect('send', handlers)).toEqual({ outcome: 'uncertain' });
    expect(await engine(store).effect('send', handlers)).toEqual({ outcome: 'uncertain' });
    expect(ran).toBe(0);
    // Uncertain is an answer, not a question left open: asked once, recorded.
    expect(reconciled).toBe(1);
  });

  test('an abort before the start records nothing, and the effect can still run', async () => {
    const store = ledger();
    const controller = new AbortController();
    controller.abort();
    let ran = 0;
    const handlers = {
      run: () => {
        ran += 1;
        return 'ok';
      },
      reconcile: () => null,
    };
    await expect(
      engine(store).effect('send', handlers, { signal: controller.signal }),
    ).rejects.toThrow('aborted before it started');
    expect(store.rows).toEqual([]);
    expect(await engine(store).effect('send', handlers)).toEqual({
      outcome: 'accepted',
      proof: 'ok',
    });
    expect(ran).toBe(1);
  });

  test('a reconcile that overruns leaves the intent to be asked again', async () => {
    const store = ledger();
    await engine(store)
      .effect('send', { run: () => Promise.reject(new Error('lost')), reconcile: () => null })
      .catch(() => undefined);

    let aborted = false;
    const error = await engine(store)
      .effect(
        'send',
        {
          run: () => 'never',
          reconcile: (signal) =>
            new Promise<null>(() => {
              signal.addEventListener('abort', () => {
                aborted = true;
              });
            }),
        },
        { reconcileTimeoutMs: 30 },
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EffectUnresolvedError);
    expect((error as EffectUnresolvedError).reason).toBe('reconcile-timeout');
    expect(aborted).toBe(true);
    // Could not ask is not "not there": no outcome was recorded.
    expect(store.rows.map((row) => (row.payload as { phase: string }).phase)).toEqual([
      'intent',
    ]);
    expect(
      await engine(store).effect('send', { run: () => 'never', reconcile: () => 'found' }),
    ).toEqual({ outcome: 'accepted', proof: 'found' });
  });

  test('two callers in one process share one run', async () => {
    const store = ledger();
    const peer = recipient();
    const handlers = {
      run: async () => {
        await Bun.sleep(5);
        return peer.send('msg-1');
      },
      reconcile: () => null,
    };
    const [first, second] = await Promise.all([
      engine(store).effect('send', handlers),
      engine(store).effect('send', handlers),
    ]);
    expect(first).toEqual(second);
    expect(peer.sends).toBe(1);
  });

  test('a proof is an identity, not a payload', async () => {
    const store = ledger();
    const error = await engine(store)
      .effect('send', { run: () => 'x'.repeat(70 * 1024), reconcile: () => null })
      .catch((caught: unknown) => caught);
    expect((error as EffectUnresolvedError).reason).toBe('proof-rejected');
  });
});

test('caller abort releases a noncooperative reconcile and ignores its late accepted result', async () => {
  const store = ledger();
  await expect(
    engine(store).effect('reply', {
      run: () => {
        throw new Error('lost acknowledgement');
      },
      reconcile: () => null,
    }),
  ).rejects.toBeInstanceOf(EffectUnresolvedError);
  const controller = new AbortController();
  let release!: (proof: { id: string }) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<{ id: string }>((resolve) => {
    release = resolve;
  });
  const pending = engine(store).effect(
    'reply',
    {
      run: () => ({ id: 'must-not-run' }),
      reconcile: () => {
        entered();
        return held;
      },
    },
    { signal: controller.signal, reconcileTimeoutMs: 1000 },
  );
  await started;
  controller.abort(new Error('caller cancelled'));
  await expect(pending).rejects.toMatchObject({ name: 'StepAbortedError' });
  const count = store.rows.length;
  release({ id: 'late' });
  await new Promise((r) => setTimeout(r, 5));
  expect(store.rows).toHaveLength(count);
  const recovered = await engine(store).effect('reply', {
    run: () => ({ id: 'must-not-run' }),
    reconcile: () => ({ id: 'recipient-proof' }),
  });
  expect(recovered).toEqual({ outcome: 'accepted', proof: { id: 'recipient-proof' } });
});

test('distinct ledger adapters need an external execution lease, shared rows alone do not claim', async () => {
  const store = ledger();
  const adapter = () => ({ appendEvent: store.appendEvent, readEvents: store.readEvents });
  let runs = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handlers = {
    run: async () => {
      runs++;
      if (runs === 2) release();
      await barrier;
      return { id: `proof-${runs}` };
    },
    reconcile: () => null,
  };
  await Promise.all([
    engine(adapter()).effect('reply', handlers),
    engine(adapter()).effect('reply', handlers),
  ]);
  expect(runs).toBe(2); // Negative control of the documented lease precondition, not exactly-once evidence.
});

test('a coalesced effect caller can abort its wait without cancelling the reconcile owner', async () => {
  for (const signalSource of ['engine', 'call']) {
    const store = ledger();
    await expect(
      engine(store).effect('reply', {
        run: () => {
          throw new Error('lost acknowledgement');
        },
        reconcile: () => null,
      }),
    ).rejects.toMatchObject({ name: 'EffectUnresolvedError' });
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: (value: { id: string }) => void;
    const held = new Promise<{ id: string }>((resolve) => {
      release = resolve;
    });
    const handlers = {
      run: () => ({ id: 'must-not-run' }),
      reconcile: () => {
        started();
        return held;
      },
    };
    const owner = engine(store).effect('reply', handlers);
    await entered;
    const controller = new AbortController();
    const follower = engine(
      store,
      signalSource === 'engine' ? controller.signal : undefined,
    ).effect(
      'reply',
      handlers,
      signalSource === 'call' ? { signal: controller.signal } : undefined,
    );
    controller.abort(new Error('follower cancelled'));
    await expect(follower).rejects.toMatchObject({ name: 'StepAbortedError' });
    expect(store.rows).toHaveLength(1);
    release({ id: 'recipient-proof' });
    await expect(owner).resolves.toEqual({
      outcome: 'accepted',
      proof: { id: 'recipient-proof' },
    });
    expect(store.rows).toHaveLength(2);
    await expect(follower).rejects.toMatchObject({ name: 'StepAbortedError' });
  }
});

test('reconciliation refuses timer overflow and accepts the native timer ceiling', async () => {
  const store = ledger();
  const handlers = {
    run: () => {
      throw new Error('lost ack');
    },
    reconcile: () => ({ id: 'proof' }),
  };
  await expect(engine(store).effect('reply', handlers)).rejects.toMatchObject({
    name: 'EffectUnresolvedError',
  });
  await expect(
    engine(store).effect('reply', handlers, { reconcileTimeoutMs: 2_147_483_648 }),
  ).rejects.toThrow('at most 2147483647');
  await expect(
    engine(store).effect('reply', handlers, { reconcileTimeoutMs: 2_147_483_647 }),
  ).resolves.toEqual({ outcome: 'accepted', proof: { id: 'proof' } });
});

test('effect replay is paged and incremental but retained keys scale with history', async () => {
  const { readDurabilityLedger } = await import('../src/durability/ledger');
  const rows: AgentStoreEventEnvelope[] = Array.from({ length: 1000 }, (_, n) => ({
    schemaVersion: 1,
    eventId: `e${n + 1}`,
    seq: n + 1,
    conversationId: 'c',
    occurredAt: new Date().toISOString(),
    kind: 'durability/effect',
    payload: { runId: 'r', effectName: `effect-${n}`, phase: 'intent' },
  }));
  const calls: Array<{ fromSeq?: number; limit?: number }> = [];
  const store: StepDurabilityLedger = {
    appendEvent: async () => {
      throw new Error('read-only fixture');
    },
    readEvents: async (input) => {
      calls.push(input);
      return { items: rows.filter((row) => row.seq >= (input.fromSeq ?? 1)) };
    },
  };
  const view = {
    steps: new Map(),
    effects: new Map(),
    parks: new Map(),
    deliveries: new Map(),
    nextSeq: 1,
  };
  await readDurabilityLedger(store, 'c', view);
  expect(view.effects.size).toBe(1000);
  expect(calls[0]?.limit).toBe(10_000);
  await readDurabilityLedger(store, 'c', view);
  expect(calls[1]?.fromSeq).toBe(1001);
  expect(view.effects.size).toBe(1000);
});
