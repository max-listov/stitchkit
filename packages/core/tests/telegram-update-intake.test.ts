/**
 * `stitchkit/telegram` update intake: recorded before Telegram is answered,
 * handled after, in chat order, and never lost to a restart or a slow handler.
 * The store rules are checked on every reference store alike.
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  createTelegramUpdateIntake,
  memoryTelegramUpdateStore,
  sqliteTelegramUpdateStore,
  TelegramBotApiError,
  type TelegramUpdateEnvelope,
  type TelegramUpdateFailure,
  type TelegramUpdateStore,
} from '../src/entrypoints/telegram';

// `node:sqlite` exists in Node 22.5+ and in Bun from 1.4; a Bun that predates it
// runs the rules on the other two stores instead of failing the file.
const nodeSqlite = await import('node:sqlite').catch(() => undefined);

const STORES: Readonly<Record<string, () => TelegramUpdateStore>> = {
  memory: memoryTelegramUpdateStore,
  'bun:sqlite': () => sqliteTelegramUpdateStore({ database: new Database(':memory:') }),
  ...(nodeSqlite && {
    'node:sqlite': () =>
      sqliteTelegramUpdateStore({ database: new nodeSqlite.DatabaseSync(':memory:') }),
  }),
};

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

for (const [name, make] of Object.entries(STORES)) {
  describe(`telegram update store rules: ${name}`, () => {
    const claim = { maxAttempts: 2 };

    test('one record per update; a live lease is not taken; a lapsed one is', async () => {
      const store = make();
      expect(await store.add({ updateId: 7, body: 'b', receivedAt: 0 })).toBe(true);
      expect(await store.add({ updateId: 7, body: 'other', receivedAt: 1 })).toBe(false);
      expect(await store.claim(7, { ...claim, now: 10, leaseUntil: 100 })).toBe(1);
      expect(await store.claim(7, { ...claim, now: 50, leaseUntil: 150 })).toBeUndefined();
      expect(await store.due({ now: 50, pendingBefore: 50, limit: 10 })).toEqual([]);
      expect(await store.due({ now: 101, pendingBefore: 0, limit: 10 })).toEqual([
        { updateId: 7, body: 'b' },
      ]);
      expect(await store.claim(7, { ...claim, now: 101, leaseUntil: 200 })).toBe(2);
    });

    test('only the attempt holding the update renews or settles it', async () => {
      const store = make();
      await store.add({ updateId: 1, body: 'b', receivedAt: 0 });
      await store.claim(1, { ...claim, now: 0, leaseUntil: 10 });
      await store.claim(1, { ...claim, now: 11, leaseUntil: 50 });
      expect(await store.renew(1, 1, 500)).toBe(false);
      expect(await store.renew(1, 2, 60)).toBe(true);
      await store.settle(1, 1, { state: 'completed', at: 20 });
      // Attempt 1 lost the lease: its "completed" did not land, attempt 2 still holds it.
      expect(await store.due({ now: 61, pendingBefore: 0, limit: 10 })).toHaveLength(1);
      await store.settle(1, 2, { state: 'completed', at: 30 });
      expect(await store.due({ now: 1_000, pendingBefore: 1_000, limit: 10 })).toEqual([]);
    });

    test('a failed update is due at its retry; spent attempts abandon it; settled ones are pruned', async () => {
      const store = make();
      await store.add({ updateId: 2, body: 'b', receivedAt: 0 });
      await store.add({ updateId: 1, body: 'a', receivedAt: 5 });
      await store.claim(2, { ...claim, now: 0, leaseUntil: 10 });
      await store.settle(2, 1, { state: 'failed', at: 1, retryAt: 30, error: 'x' });
      expect(await store.due({ now: 29, pendingBefore: 0, limit: 10 })).toEqual([]);
      expect(
        (await store.due({ now: 30, pendingBefore: 5, limit: 10 })).map((row) => row.updateId),
      ).toEqual([1, 2]);
      await store.claim(2, { ...claim, now: 30, leaseUntil: 40 });
      await store.settle(2, 2, { state: 'failed', at: 31, retryAt: 35, error: 'x' });
      expect(await store.claim(2, { ...claim, now: 36, leaseUntil: 50 })).toBeUndefined();
      expect(await store.due({ now: 100, pendingBefore: 0, limit: 10 })).toEqual([]);
      expect(await store.prune(36)).toBe(0);
      expect(await store.prune(37)).toBe(1);
      expect(await store.add({ updateId: 2, body: 'b', receivedAt: 40 })).toBe(true);
    });
  });
}

describe('telegram update intake', () => {
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
