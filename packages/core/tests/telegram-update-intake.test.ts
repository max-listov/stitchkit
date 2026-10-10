/**
 * `stitchkit/telegram` update intake: recorded before Telegram is answered,
 * handled after, in chat order, and never lost to a restart or a slow handler.
 * The store rules are in `telegram-update-store.test.ts`.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  createTelegramUpdateIntake,
  memoryTelegramUpdateStore,
  sqliteTelegramUpdateStore,
  TelegramBotApiError,
  type TelegramUpdateAttemptContext,
  type TelegramUpdateAttemptIntakeConfig,
  type TelegramUpdateDurableStore,
  type TelegramUpdateEnvelope,
  type TelegramUpdateFailure,
  type TelegramUpdateIntakeConfig,
  type TelegramUpdateStore,
} from '../src/entrypoints/telegram';

interface Message extends TelegramUpdateEnvelope {
  readonly message: { readonly chat: { readonly id: number }; readonly text: string };
}

function body(updateId: number, text: string, chat = 1): string {
  return JSON.stringify({ update_id: updateId, message: { chat: { id: chat }, text } });
}

function gate() {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

describe('telegram update intake', () => {
  test('accepts both legacy optional-envelope handlers and attempt-aware handlers', () => {
    type LegacyEnvelope = { send(payload: string): Promise<void> };
    const legacy = async (_update: Message, _envelope?: LegacyEnvelope): Promise<void> => {
      // A direct grammY-style handler may still own this optional second parameter.
    };
    const attemptAware = (_update: Message, context: TelegramUpdateAttemptContext): void => {
      void context.ownerLost;
    };
    const legacyConfig: TelegramUpdateIntakeConfig<Message> = {
      store: memoryTelegramUpdateStore(),
      handle: legacy,
    };
    const attemptConfig: TelegramUpdateAttemptIntakeConfig<Message> = {
      store: memoryTelegramUpdateStore(),
      handleAttempt: attemptAware,
    };
    expect(legacyConfig.handle).toBe(legacy);
    expect(attemptConfig.handleAttempt).toBe(attemptAware);
  });

  test('calls a legacy handler with exactly one argument', async () => {
    let argumentCount = 0;
    let second: unknown = Symbol('not called');
    const intake = createTelegramUpdateIntake<Message>({
      store: memoryTelegramUpdateStore(),
      handle: (...args: [Message, unknown?]) => {
        const [update, envelope] = args;
        void update;
        argumentCount = args.length;
        second = envelope;
      },
    });
    await intake.start();
    await intake.accept(body(1, 'legacy'));
    await intake.idle();
    expect(argumentCount).toBe(1);
    expect(second).toBeUndefined();
    await intake.close();
  });

  test('refuses an attempt-aware handler backed by an unfenced store at runtime', () => {
    const durable = memoryTelegramUpdateStore();
    const base: TelegramUpdateStore = {
      add: durable.add,
      claim: durable.claim,
      renew: durable.renew,
      settle: durable.settle,
      due: durable.due,
      prune: durable.prune,
    };
    const config = {
      store: base,
      handleAttempt: () => undefined,
    } as unknown as TelegramUpdateAttemptIntakeConfig<Message>;
    expect(() => createTelegramUpdateIntake(config)).toThrow(
      'handleAttempt requires a TelegramUpdateFencedStore',
    );
  });

  test('answers before a slow update finishes, keeps chat order, runs other chats alongside', async () => {
    const seen: string[] = [];
    const slow = gate();
    const intake = createTelegramUpdateIntake<Message>({
      store: memoryTelegramUpdateStore(),
      handle: async (update) => {
        if (update.message.text === 'slow') await slow.opened;
        seen.push(update.message.text);
      },
    });
    await intake.start();
    expect(await intake.accept(body(1, 'slow'))).toBe('accepted');
    expect(await intake.accept(body(2, 'next'))).toBe('accepted');
    expect(await intake.accept(body(3, 'other chat', 2))).toBe('accepted');
    expect(await intake.accept(body(1, 'slow'))).toBe('duplicate');
    expect(await intake.accept('{"not":"an update"}')).toBe('invalid');
    expect(await intake.accept('not json')).toBe('invalid');
    await Bun.sleep(5);
    expect(seen).toEqual(['other chat']);
    slow.open();
    await intake.idle();
    expect(seen).toEqual(['other chat', 'slow', 'next']);
    await intake.close();
  });

  test('a failure is retried from the stored body when due; a refusal repeating cannot fix is abandoned', async () => {
    let clock = 1_000;
    let calls = 0;
    const failures: TelegramUpdateFailure[] = [];
    const intake = createTelegramUpdateIntake<Message>({
      store: memoryTelegramUpdateStore(),
      now: () => clock,
      handle: (update) => {
        calls += 1;
        if (update.message.text === 'refused') {
          throw new TelegramBotApiError('sendMessage', {
            error_code: 400,
            description: "Bad Request: can't parse entities",
          });
        }
        if (calls === 1) throw new Error('database is down');
      },
      onFailure: (failure) => failures.push(failure),
    });
    await intake.start();
    await intake.accept(body(1, 'flaky'));
    await intake.idle();
    expect(failures.map(({ retrying }) => retrying)).toEqual([true]);
    expect(await intake.sweep()).toBe(0);
    clock += 5_000;
    expect(await intake.sweep()).toBe(1);
    await intake.idle();
    expect(calls).toBe(2);
    await intake.accept(body(2, 'refused', 2));
    await intake.idle();
    expect(failures.at(-1)).toMatchObject({ updateId: 2, attempt: 1, retrying: false });
    clock += 3_600_000;
    expect(await intake.sweep()).toBe(0);
    await intake.close();
  });

  test('a retry receives a new immutable attempt identity', async () => {
    let clock = 1_000;
    const contexts: TelegramUpdateAttemptContext[] = [];
    const intake = createTelegramUpdateIntake<Message>({
      store: memoryTelegramUpdateStore(),
      now: () => clock,
      retry: () => 10,
      handleAttempt: (_update, context) => {
        contexts.push(context);
        if (context.attempt === 1) throw new Error('retry me');
      },
    });
    await intake.start();
    await intake.accept(body(7, 'flaky'));
    await intake.idle();
    clock += 10;
    await intake.sweep();
    await intake.idle();
    expect(contexts.map(({ updateId, attempt }) => ({ updateId, attempt }))).toEqual([
      { updateId: 7, attempt: 1 },
      { updateId: 7, attempt: 2 },
    ]);
    for (const context of contexts) {
      expect(context.claimId).toBeString();
      expect(context.fence).toEqual({
        updateId: context.updateId,
        attempt: context.attempt,
        claimId: context.claimId,
      });
      expect(Object.isFrozen(context.fence)).toBe(true);
    }
    expect(contexts[0]?.fence).not.toBe(contexts[1]?.fence);
    await intake.close();
  });

  test('an update stops after maxAttempts', async () => {
    let clock = 0;
    const failures: TelegramUpdateFailure[] = [];
    const intake = createTelegramUpdateIntake<Message>({
      store: memoryTelegramUpdateStore(),
      now: () => clock,
      maxAttempts: 2,
      retry: () => 10,
      handle: () => {
        throw new Error('always');
      },
      onFailure: (failure) => failures.push(failure),
    });
    await intake.start();
    await intake.accept(body(1, 'x'));
    await intake.idle();
    clock += 10;
    await intake.sweep();
    await intake.idle();
    clock += 10;
    expect(await intake.sweep()).toBe(0);
    expect(failures.map(({ attempt, retrying }) => [attempt, retrying])).toEqual([
      [1, true],
      [2, false],
    ]);
    await intake.close();
  });

  test("grammY's BotError is unwrapped: retry, onFailure and the stored error see the handler's own", async () => {
    class Terminal extends Error {}
    /** What `bot.handleUpdate` throws: grammY's wrapper, the original on `.error`. */
    class BotError extends Error {
      constructor(
        readonly error: unknown,
        readonly ctx: object,
      ) {
        super(`Error in middleware: ${error instanceof Error ? error.message : ''}`);
        this.name = 'BotError';
      }
    }
    const seen: unknown[] = [];
    const failures: TelegramUpdateFailure[] = [];
    const settled: string[] = [];
    const inner = memoryTelegramUpdateStore();
    const store: TelegramUpdateStore = {
      ...inner,
      settle: async (updateId, attempt, settlement) => {
        if (settlement.state !== 'completed') settled.push(settlement.error);
        return inner.settle(updateId, attempt, settlement);
      },
    };
    const intake = createTelegramUpdateIntake<Message>({
      store,
      handle: () => {
        throw new BotError(new Terminal('account is closed'), {});
      },
      retry: (error) => {
        seen.push(error);
        return error instanceof Terminal ? false : 10;
      },
      onFailure: (failure) => failures.push(failure),
    });
    await intake.start();
    await intake.accept(body(1, 'x'));
    await intake.idle();
    expect(seen[0]).toBeInstanceOf(Terminal);
    expect(failures[0]?.error).toBeInstanceOf(Terminal);
    expect(failures[0]?.retrying).toBe(false);
    expect(settled).toEqual(['account is closed']);
    await intake.close();
  });

  test('what was recorded before the start is handled at the start', async () => {
    const seen: string[] = [];
    const store = memoryTelegramUpdateStore();
    const intake = createTelegramUpdateIntake<Message>({
      store,
      handle: (update) => {
        seen.push(update.message.text);
      },
    });
    await intake.accept(body(1, 'early'));
    await Bun.sleep(5);
    expect(seen).toEqual([]);
    await intake.start();
    await intake.idle();
    expect(seen).toEqual(['early']);
    await intake.close();
  });

  test("a live handler's lease keeps a second process off it; a dead one's lapses to the second", async () => {
    const database = new Database(':memory:');
    const store = sqliteTelegramUpdateStore({ database });
    const held = gate();
    const handled: string[] = [];
    const first = createTelegramUpdateIntake<Message>({
      store,
      leaseMs: 40,
      handle: async () => {
        await held.opened;
        handled.push('first');
      },
    });
    const second = createTelegramUpdateIntake<Message>({
      store,
      leaseMs: 40,
      pendingGraceMs: 0,
      handle: () => {
        handled.push('second');
      },
    });
    await first.start();
    await second.start();
    await first.accept(body(1, 'long'));
    await Bun.sleep(120);
    expect(await second.sweep()).toBe(0);
    held.open();
    await first.idle();
    expect(handled).toEqual(['first']);
    await first.close();

    // A process that died mid-attempt leaves `processing` behind; its lease lapses.
    const dead = memoryTelegramUpdateStore();
    await dead.add({ updateId: 5, body: body(5, 'orphan'), receivedAt: 0 });
    await dead.claim(5, { now: 0, leaseUntil: Date.now() - 1, maxAttempts: 5 });
    const survivor = createTelegramUpdateIntake<Message>({
      store: dead,
      handle: (update) => {
        handled.push(update.message.text);
      },
    });
    await survivor.start();
    await survivor.idle();
    expect(handled).toEqual(['first', 'orphan']);
    await survivor.close();
    await second.close();
  });

  test('owner loss aborts the old handler and its fence cannot authorize the reclaimed attempt', async () => {
    const database = new Database(':memory:');
    const shared = sqliteTelegramUpdateStore({ database });
    const oldStore: TelegramUpdateDurableStore = {
      ...shared,
      renewOwned: async (identity, leaseUntil, at) =>
        identity.attempt === 1 ? false : shared.renewOwned(identity, leaseUntil, at),
    };
    const releaseOld = gate();
    const oldStarted = gate();
    let oldContext: TelegramUpdateAttemptContext | undefined;
    const domain: string[] = [];
    const old = createTelegramUpdateIntake<Message>({
      store: oldStore,
      leaseMs: 30,
      handleAttempt: async (_update, context) => {
        oldContext = context;
        oldStarted.open();
        await releaseOld.opened;
        if (await shared.owns(context.fence, Date.now())) domain.push('old');
      },
    });
    const replacement = createTelegramUpdateIntake<Message>({
      store: shared,
      leaseMs: 30,
      pendingGraceMs: 0,
      handleAttempt: async (_update, context) => {
        if (await shared.owns(context.fence, Date.now())) domain.push('replacement');
      },
    });
    await old.start();
    await replacement.start();
    await old.accept(body(20, 'lease'));
    await oldStarted.opened;
    await Bun.sleep(45);
    expect(oldContext?.ownerLost.aborted).toBe(true);
    expect(await replacement.sweep()).toBe(1);
    await replacement.idle();
    releaseOld.open();
    await old.idle();
    expect(domain).toEqual(['replacement']);
    if (!oldContext) throw new Error('old handler did not expose its context');
    expect(await shared.owns(oldContext.fence, Date.now())).toBe(false);
    await old.close();
    await replacement.close();
  });

  test('a renewal resolving after settlement cannot rearm owner loss', async () => {
    const inner = memoryTelegramUpdateStore();
    const renewalStarted = gate();
    const releaseRenewal = gate();
    const store: TelegramUpdateDurableStore = {
      ...inner,
      renewOwned: async (...args) => {
        const held = await inner.renewOwned(...args);
        renewalStarted.open();
        await releaseRenewal.opened;
        return held;
      },
    };
    let context: TelegramUpdateAttemptContext | undefined;
    const storeErrors: unknown[] = [];
    const intake = createTelegramUpdateIntake<Message>({
      store,
      leaseMs: 20,
      handleAttempt: async (_update, attemptContext) => {
        context = attemptContext;
        await renewalStarted.opened;
      },
      onStoreError: (error) => storeErrors.push(error),
    });
    await intake.start();
    await intake.accept(body(24, 'late renewal'));
    await intake.idle();
    if (!context) throw new Error('handler did not expose its context');
    expect(context.ownerLost.aborted).toBe(false);
    releaseRenewal.open();
    await Bun.sleep(40);
    expect(context.ownerLost.aborted).toBe(false);
    expect(storeErrors).toEqual([]);
    await intake.close();
  });

  test('renewals are serialized and an older deadline cannot abort a live fence', async () => {
    const inner = memoryTelegramUpdateStore();
    const firstRenewalStarted = gate();
    const releaseFirstRenewal = gate();
    const secondRenewalStarted = gate();
    const releaseHandler = gate();
    let renewals = 0;
    let inFlight = 0;
    let peak = 0;
    let firstLeaseUntil = 0;
    const store: TelegramUpdateDurableStore = {
      ...inner,
      renewOwned: async (identity, leaseUntil, at) => {
        renewals += 1;
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        const held = await inner.renewOwned(identity, leaseUntil, at);
        if (renewals === 1) {
          firstLeaseUntil = leaseUntil;
          firstRenewalStarted.open();
          await releaseFirstRenewal.opened;
        } else {
          secondRenewalStarted.open();
        }
        inFlight -= 1;
        return held;
      },
    };
    let context: TelegramUpdateAttemptContext | undefined;
    const intake = createTelegramUpdateIntake<Message>({
      store,
      leaseMs: 200,
      handleAttempt: async (_update, attemptContext) => {
        context = attemptContext;
        await releaseHandler.opened;
      },
    });
    await intake.start();
    await intake.accept(body(241, 'serialized renewal'));
    await firstRenewalStarted.opened;
    await Bun.sleep(70);
    expect(renewals).toBe(1);
    releaseFirstRenewal.open();
    await secondRenewalStarted.opened;
    expect(peak).toBe(1);
    await Bun.sleep(Math.max(1, firstLeaseUntil - Date.now() + 5));
    if (!context) throw new Error('handler did not expose its context');
    expect(context.ownerLost.aborted).toBe(false);
    expect(await inner.owns(context.fence, Date.now())).toBe(true);
    releaseHandler.open();
    await intake.idle();
    await intake.close();
  });

  test('a terminal result after owner loss reports the retry that reclaim will perform', async () => {
    const inner = memoryTelegramUpdateStore();
    const store: TelegramUpdateDurableStore = {
      ...inner,
      renewOwned: async () => false,
    };
    const began = gate();
    const release = gate();
    const failures: TelegramUpdateFailure[] = [];
    let calls = 0;
    const intake = createTelegramUpdateIntake<Message>({
      store,
      leaseMs: 20,
      maxAttempts: 2,
      retry: () => false,
      handleAttempt: async (_update, context) => {
        calls += 1;
        if (context.attempt === 1) {
          began.open();
          await release.opened;
          throw new Error('late terminal result');
        }
      },
      onFailure: (failure) => failures.push(failure),
    });
    await intake.start();
    await intake.accept(body(25, 'owner loss'));
    await began.opened;
    await Bun.sleep(30);
    release.open();
    await intake.idle();
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ updateId: 25, attempt: 1, retrying: true });

    expect(await intake.sweep()).toBe(1);
    await intake.idle();
    expect(calls).toBe(2);
    await intake.close();
  });

  test('a durable exhaustion survives a restart and repeats until acknowledgement', async () => {
    const stored = memoryTelegramUpdateStore();
    await stored.add({ updateId: 30, body: body(30, 'terminal'), receivedAt: 0 });
    const identity = await stored.claimOwned(30, { now: 0, leaseUntil: 10, maxAttempts: 5 });
    if (!identity) throw new Error('fixture claim was not taken');
    await stored.exhaust(identity, { at: 1, error: 'terminal refusal' });

    let refuseDelivery = true;
    let refuseAck = true;
    const steps: string[] = [];
    const store: TelegramUpdateDurableStore = {
      ...stored,
      acknowledgeExhaustion: async (...args) => {
        if (refuseAck) throw new Error('process stopped before acknowledgement');
        return stored.acknowledgeExhaustion(...args);
      },
    };
    const delivered: Array<{ updateId: number; attempt: number; error: string }> = [];
    const deliveryFailures: unknown[] = [];
    const intake = createTelegramUpdateIntake<Message>({
      store,
      now: () => 100,
      handle: () => {
        throw new Error('an exhausted update must not run as a new handler attempt');
      },
      handleExhaustion: ({ updateId, attempt, error }) => {
        delivered.push({ updateId, attempt, error });
        if (refuseDelivery) throw new Error('terminal destination is unavailable');
      },
      onExhaustionFailure: ({ error }) => deliveryFailures.push(error),
      onStoreError: (_error, step) => steps.push(step),
    });
    await intake.start();
    await intake.idle();
    expect(delivered).toEqual([{ updateId: 30, attempt: 1, error: 'terminal refusal' }]);
    expect(deliveryFailures).toHaveLength(1);
    expect(steps).toEqual([]);
    expect(await stored.dueExhaustions({ limit: 10 })).toHaveLength(1);

    refuseDelivery = false;
    expect(await intake.sweep()).toBe(1);
    await intake.idle();
    expect(delivered).toHaveLength(2);
    expect(steps).toEqual(['settle']);
    expect(await stored.dueExhaustions({ limit: 10 })).toHaveLength(1);

    refuseAck = false;
    expect(await intake.sweep()).toBe(1);
    await intake.idle();
    expect(delivered).toEqual([
      { updateId: 30, attempt: 1, error: 'terminal refusal' },
      { updateId: 30, attempt: 1, error: 'terminal refusal' },
      { updateId: 30, attempt: 1, error: 'terminal refusal' },
    ]);
    expect(await stored.dueExhaustions({ limit: 10 })).toEqual([]);
    await intake.close();
  });

  test('durable exhaustion paging reaches rows after a failing first batch', async () => {
    const store = memoryTelegramUpdateStore();
    for (let updateId = 1; updateId <= 101; updateId++) {
      await store.add({ updateId, body: body(updateId, 'terminal'), receivedAt: 0 });
      const identity = await store.claimOwned(updateId, {
        now: 0,
        leaseUntil: 10,
        maxAttempts: 1,
      });
      if (!identity) throw new Error(`fixture claim ${updateId} was not taken`);
      await store.exhaust(identity, { at: 1, error: `terminal ${updateId}` });
    }
    const delivered = new Set<number>();
    const intake = createTelegramUpdateIntake<Message>({
      store,
      now: () => 2,
      handle: () => undefined,
      handleExhaustion: ({ updateId }) => {
        delivered.add(updateId);
        if (updateId <= 100) throw new Error('first page remains unavailable');
      },
    });
    await intake.start();
    await intake.idle();
    expect(delivered.size).toBe(100);
    expect(delivered.has(101)).toBe(false);

    expect(await intake.sweep()).toBe(1);
    await intake.idle();
    expect(delivered.has(101)).toBe(true);
    await intake.close();
  });

  test('a pending update waits pendingGraceMs for its own process, then any process takes it; finished ones are forgotten after retainMs', async () => {
    let clock = 0;
    const store = memoryTelegramUpdateStore();
    const handled: string[] = [];
    const taker = createTelegramUpdateIntake<Message>({
      store,
      now: () => clock,
      pendingGraceMs: 1_000,
      retainMs: 5_000,
      handle: (update) => {
        handled.push(update.message.text);
      },
    });
    await taker.start();
    // Another process recorded it and has not handled it yet — maybe it died.
    const recorder = createTelegramUpdateIntake<Message>({
      store,
      now: () => clock,
      handle: () => undefined,
    });
    await recorder.accept(body(1, 'orphan'));
    clock = 999;
    expect(await taker.sweep()).toBe(0);
    clock = 1_000;
    expect(await taker.sweep()).toBe(1);
    await taker.idle();
    expect(handled).toEqual(['orphan']);
    await taker.accept(body(2, 'own'));
    await taker.idle();
    expect(await taker.accept(body(2, 'own'))).toBe('duplicate');
    clock += 5_001;
    await taker.sweep();
    expect(await taker.accept(body(2, 'own'))).toBe('accepted');
    await taker.close();
  });

  test('the sweep runs on its own every sweepEveryMs', async () => {
    let calls = 0;
    const intake = createTelegramUpdateIntake<Message>({
      store: memoryTelegramUpdateStore(),
      sweepEveryMs: 10,
      retry: () => 0,
      handle: () => {
        calls += 1;
        if (calls === 1) throw new Error('once');
      },
    });
    await intake.start();
    await intake.accept(body(1, 'x'));
    await intake.idle();
    expect(calls).toBe(1);
    await Bun.sleep(60);
    await intake.idle();
    expect(calls).toBe(2);
    await intake.close();
  });

  test('close during the initial sweep prevents that start from installing a timer', async () => {
    const inner = memoryTelegramUpdateStore();
    const entered = gate();
    const release = gate();
    let dueCalls = 0;
    const store: TelegramUpdateStore = {
      ...inner,
      due: async (query) => {
        dueCalls += 1;
        if (dueCalls === 1) {
          entered.open();
          await release.opened;
        }
        return inner.due(query);
      },
    };
    const intake = createTelegramUpdateIntake<Message>({
      store,
      sweepEveryMs: 10,
      handle: () => undefined,
    });
    const starting = intake.start();
    await entered.opened;
    const closing = intake.close();
    release.open();
    await Promise.all([starting, closing]);
    await Bun.sleep(30);
    expect(dueCalls).toBe(1);
  });

  test('close waits for a blocked initial sweep before a fresh lifecycle starts', async () => {
    const inner = memoryTelegramUpdateStore();
    const entered = gate();
    const release = gate();
    let dueCalls = 0;
    const handled: string[] = [];
    const store: TelegramUpdateStore = {
      ...inner,
      due: async (query) => {
        dueCalls += 1;
        if (dueCalls === 1) {
          entered.open();
          await release.opened;
        }
        return inner.due(query);
      },
    };
    const intake = createTelegramUpdateIntake<Message>({
      store,
      sweepEveryMs: 10,
      handle: (update) => {
        handled.push(update.message.text);
      },
    });

    const first = intake.start();
    await entered.opened;
    const closing = intake.close();
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await Bun.sleep(0);
    expect(closed).toBe(false);

    release.open();
    await closing;
    await first;
    expect(await intake.accept(body(1, 'after restart'))).toBe('accepted');
    const second = intake.start();
    expect(second).not.toBe(first);
    await second;
    await intake.idle();
    expect(handled).toEqual(['after restart']);
    await Bun.sleep(30);
    expect(dueCalls).toBeGreaterThanOrEqual(3);
    await intake.close();
  });

  test('a failed initial sweep leaves start retryable', async () => {
    const inner = memoryTelegramUpdateStore();
    let dueCalls = 0;
    const store: TelegramUpdateStore = {
      ...inner,
      due: async (query) => {
        dueCalls += 1;
        if (dueCalls === 1) throw new Error('database warming up');
        return inner.due(query);
      },
    };
    const intake = createTelegramUpdateIntake<Message>({
      store,
      handle: () => undefined,
    });
    await expect(intake.start()).rejects.toThrow('database warming up');
    await intake.start();
    expect(dueCalls).toBe(2);
    await intake.close();
  });

  test('concurrent starts share a failed initial sweep and one retry lifecycle', async () => {
    const inner = memoryTelegramUpdateStore();
    const entered = gate();
    const release = gate();
    let dueCalls = 0;
    const store: TelegramUpdateStore = {
      ...inner,
      due: async (query) => {
        dueCalls += 1;
        if (dueCalls === 1) {
          entered.open();
          await release.opened;
          throw new Error('initial sweep failed');
        }
        return inner.due(query);
      },
    };
    const intake = createTelegramUpdateIntake<Message>({
      store,
      handle: () => undefined,
    });
    const first = intake.start();
    await entered.opened;
    const second = intake.start();
    expect(second).toBe(first);
    release.open();
    const results = await Promise.allSettled([first, second]);
    expect(results.map(({ status }) => status)).toEqual(['rejected', 'rejected']);
    expect(
      results.map((result) => (result.status === 'rejected' ? result.reason.message : '')),
    ).toEqual(['initial sweep failed', 'initial sweep failed']);

    await intake.start();
    expect(dueCalls).toBe(2);
    await intake.close();
  });

  test('at most maxConcurrent chats are handled at once', async () => {
    let active = 0;
    let peak = 0;
    const intake = createTelegramUpdateIntake<Message>({
      store: memoryTelegramUpdateStore(),
      maxConcurrent: 2,
      handle: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await Bun.sleep(5);
        active -= 1;
      },
    });
    await intake.start();
    for (let chat = 1; chat <= 6; chat += 1) await intake.accept(body(chat, 'x', chat));
    await intake.idle();
    expect(peak).toBe(2);
    await intake.close();
  });

  test('a store that fails a step is reported, and the update is not lost', async () => {
    const inner = memoryTelegramUpdateStore();
    let failSettle = true;
    const steps: string[] = [];
    const store: TelegramUpdateStore = {
      ...inner,
      settle: async (...args) => {
        if (failSettle) throw new Error('store is down');
        return inner.settle(...args);
      },
    };
    let clock = 0;
    let calls = 0;
    const intake = createTelegramUpdateIntake<Message>({
      store,
      now: () => clock,
      leaseMs: 1_000,
      handle: () => {
        calls += 1;
      },
      onStoreError: (_error, step) => steps.push(step),
    });
    await intake.start();
    await intake.accept(body(1, 'x'));
    await intake.idle();
    expect(steps).toEqual(['settle']);
    failSettle = false;
    clock += 1_001;
    expect(await intake.sweep()).toBe(1);
    await intake.idle();
    expect(calls).toBe(2);
    await intake.close();
  });
});
