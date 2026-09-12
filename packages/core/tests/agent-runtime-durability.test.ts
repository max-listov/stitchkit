import { describe, expect, test } from 'bun:test';
import { createMemoryAgentRuntimeStore } from '../src/agent-runtime';
import {
  createLocalStepDurability,
  ParkAbortedError,
  ParkRecordDecodeError,
  StepAbortedError,
  StepResultDecodeError,
} from '../src/agent-runtime/durability';

const conversationId = 'conversation-durability';
const runId = 'run-durability';

interface TestTimerEntry {
  readonly id: number;
  readonly at: number;
  readonly callback: () => void;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/** Yield microtasks until `predicate` holds; the memory store chains several. */
async function flushUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  if (!predicate()) throw new Error(`Timed out waiting for ${label}`);
}

/** Manual clock mirroring the repository's fake-clock pattern. */
class TestClock {
  private current = 0;
  private sequence = 0;
  private readonly timers = new Map<number, TestTimerEntry>();

  now(): number {
    return this.current;
  }

  schedule(callback: () => void, delayMs: number): { cancel(): void } {
    const id = ++this.sequence;
    this.timers.set(id, { id, at: this.current + delayMs, callback });
    return { cancel: () => this.timers.delete(id) };
  }

  pendingTimers(): number {
    return this.timers.size;
  }

  async advanceBy(deltaMs: number): Promise<void> {
    const target = this.current + deltaMs;
    for (;;) {
      let due: TestTimerEntry | undefined;
      for (const entry of this.timers.values()) {
        if (entry.at > target) continue;
        if (!due || entry.at < due.at || (entry.at === due.at && entry.id < due.id)) {
          due = entry;
        }
      }
      if (!due) break;
      this.current = due.at;
      this.timers.delete(due.id);
      due.callback();
      await flushMicrotasks();
    }
    this.current = target;
    await flushMicrotasks();
  }
}

describe('local step durability', () => {
  test('successive reads advance the canonical ledger cursor', async () => {
    const store = createMemoryAgentRuntimeStore();
    const cursors: Array<number | undefined> = [];
    const durability = createLocalStepDurability({
      conversationId,
      runId,
      store: {
        appendEvent: store.appendEvent,
        readEvents: (input) => {
          cursors.push(input.fromSeq);
          return store.readEvents(input);
        },
      },
    });
    await durability.step('one', () => 1);
    await durability.step('two', () => 2);
    await durability.step('three', () => 3);
    expect(cursors).toEqual([1, 1, 2]);
    expect(await durability.readRecordedStep('three')).toBe(3);
    expect(cursors.at(-1)).toBe(3);
  });
  test('equal keys in different stores never share in-flight results', async () => {
    const a = createLocalStepDurability({
      store: createMemoryAgentRuntimeStore(),
      conversationId,
      runId,
    });
    const b = createLocalStepDurability({
      store: createMemoryAgentRuntimeStore(),
      conversationId,
      runId,
    });
    const release = Promise.withResolvers<void>();
    const first = a.step('same', async () => {
      await release.promise;
      return 'a';
    });
    const second = b.step('same', () => 'b');
    release.resolve();
    expect(await Promise.all([first, second])).toEqual(['a', 'b']);
    expect(await b.readRecordedStep('same')).toBe('b');
  });

  // The load-bearing test: a process that dies after one step must not re-run
  // that step when a fresh durability object resumes from the same store.
  test('replays a completed step and runs only the unfinished one after reconstruction', async () => {
    const store = createMemoryAgentRuntimeStore();
    const executed: string[] = [];
    const first = createLocalStepDurability({ store, conversationId, runId });

    await expect(
      (async () => {
        await first.step('charge', () => {
          executed.push('charge');
          return { receipt: 'receipt-1' };
        });
        throw new Error('process died after the first step');
      })(),
    ).rejects.toThrow('process died after the first step');

    expect(executed).toEqual(['charge']);

    const second = createLocalStepDurability({ store, conversationId, runId });
    const charge = await second.step('charge', () => {
      executed.push('charge');
      return { receipt: 'receipt-2' };
    });
    const ship = await second.step('ship', () => {
      executed.push('ship');
      return { shipped: true };
    });

    expect(charge).toEqual({ receipt: 'receipt-1' });
    expect(ship).toEqual({ shipped: true });
    expect(executed).toEqual(['charge', 'ship']);
  });

  test('deduplicates concurrent calls so the body runs once', async () => {
    const store = createMemoryAgentRuntimeStore();
    let calls = 0;
    const durability = createLocalStepDurability({ store, conversationId, runId });
    const body = () =>
      durability.step('once', async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return calls;
      });

    const [left, right] = await Promise.all([body(), body()]);

    expect(calls).toBe(1);
    expect(left).toBe(1);
    expect(right).toBe(1);
  });

  test('fails closed on an undecodable recorded result without running the body', async () => {
    const store = createMemoryAgentRuntimeStore();
    await store.appendEvent({
      conversationId,
      kind: 'durability/step',
      payload: { runId, stepName: 'effect', encoded: '{not-json' },
    });
    const durability = createLocalStepDurability({ store, conversationId, runId });
    let ran = false;

    await expect(
      durability.step('effect', () => {
        ran = true;
        return 1;
      }),
    ).rejects.toThrow(StepResultDecodeError);
    expect(ran).toBe(false);
  });

  test('returns a completed record even when the replay has already aborted', async () => {
    const store = createMemoryAgentRuntimeStore();
    const writer = createLocalStepDurability({ store, conversationId, runId });
    await writer.step('recorded', () => 'kept');

    const replayed = createLocalStepDurability({ store, conversationId, runId });
    const controller = new AbortController();
    controller.abort();

    await expect(
      replayed.step<string>('recorded', () => 'should-not-run', { signal: controller.signal }),
    ).resolves.toBe('kept');
    await expect(
      replayed.step('unrecorded', () => 'never', { signal: controller.signal }),
    ).rejects.toThrow(StepAbortedError);
  });

  test('sleep resumes after the deadline using the injectable clock', async () => {
    const store = createMemoryAgentRuntimeStore();
    const clock = new TestClock();
    const durability = createLocalStepDurability({ store, conversationId, runId, clock });
    let resumed = false;

    const parking = durability.sleep({ seconds: 30, name: 'nap' }).then(() => {
      resumed = true;
    });
    await flushUntil(() => clock.pendingTimers() === 1, 'sleep timer');

    await clock.advanceBy(29_999);
    expect(resumed).toBe(false);

    await clock.advanceBy(1);
    await parking;
    expect(resumed).toBe(true);
  });

  test('reconstruction mid-sleep continues from the recorded deadline', async () => {
    const store = createMemoryAgentRuntimeStore();
    const clock = new TestClock();
    await store.appendEvent({
      conversationId,
      kind: 'durability/park',
      payload: { runId, kind: 'sleep', name: 'nap', deadline: 30_000 },
    });

    const replayed = createLocalStepDurability({ store, conversationId, runId, clock });
    let resumed = false;
    const parking = replayed.sleep({ seconds: 30, name: 'nap' }).then(() => {
      resumed = true;
    });
    await flushUntil(() => clock.pendingTimers() === 1, 'sleep timer');

    await clock.advanceBy(29_999);
    expect(resumed).toBe(false);

    await clock.advanceBy(1);
    await parking;
    expect(resumed).toBe(true);
  });

  test('waitFor resumes from an event delivered after reconstruction', async () => {
    const store = createMemoryAgentRuntimeStore();
    await store.appendEvent({
      conversationId,
      kind: 'durability/park',
      payload: { runId, kind: 'wait', event: 'approval', id: 'req-1' },
    });

    const replayed = createLocalStepDurability({ store, conversationId, runId });
    const waiting = replayed.waitFor<{ approved: boolean }>({
      event: 'approval',
      id: 'req-1',
    });
    await flushMicrotasks();

    await replayed.deliver({ event: 'approval', id: 'req-1', payload: { approved: true } });
    await expect(waiting).resolves.toEqual({ approved: true });

    // A waiter that arrives after delivery returns the recorded payload without
    // waiting for another delivery.
    await expect(replayed.waitFor({ event: 'approval', id: 'req-1' })).resolves.toEqual({
      approved: true,
    });
  });

  test('aborting a sleep clears its timer and preserves the park record', async () => {
    const store = createMemoryAgentRuntimeStore();
    const clock = new TestClock();
    const durability = createLocalStepDurability({ store, conversationId, runId, clock });
    const controller = new AbortController();

    const parking = durability.sleep(
      { seconds: 60, name: 'nap' },
      { signal: controller.signal },
    );
    await flushUntil(() => clock.pendingTimers() === 1, 'sleep timer');
    expect(clock.pendingTimers()).toBe(1);

    controller.abort();
    await expect(parking).rejects.toThrow(ParkAbortedError);
    expect(clock.pendingTimers()).toBe(0);

    // The park record survives abort: a fresh replay with the deadline ahead
    // resumes it instead of starting over.
    const replay = createLocalStepDurability({ store, conversationId, runId, clock });
    let resumed = false;
    const again = replay.sleep({ seconds: 60, name: 'nap' }).then(() => {
      resumed = true;
    });
    await flushUntil(() => clock.pendingTimers() === 1, 'sleep timer');
    await clock.advanceBy(59_999);
    expect(resumed).toBe(false);
    await clock.advanceBy(1);
    await again;
    expect(resumed).toBe(true);
  });

  test('aborting a wait releases the waiter without removing the park', async () => {
    const store = createMemoryAgentRuntimeStore();
    const durability = createLocalStepDurability({ store, conversationId, runId });
    const controller = new AbortController();

    const waiting = durability.waitFor(
      { event: 'approval', id: 'req-2' },
      { signal: controller.signal },
    );
    await flushMicrotasks();
    controller.abort();
    await expect(waiting).rejects.toThrow(ParkAbortedError);

    // Delivering after abort must not trip over a stale waiter, and the park
    // record stays: the later waiter resolves from the durable delivery.
    await durability.deliver({ event: 'approval', id: 'req-2', payload: 'late' });
    await expect(durability.waitFor({ event: 'approval', id: 'req-2' })).resolves.toBe('late');
  });

  test('does not duplicate a park or waiter for two calls with the same key', async () => {
    const store = createMemoryAgentRuntimeStore();
    const clock = new TestClock();
    const durability = createLocalStepDurability({ store, conversationId, runId, clock });

    const [left, right] = [
      durability.sleep({ seconds: 5, name: 'dup' }),
      durability.sleep({ seconds: 5, name: 'dup' }),
    ];
    await flushUntil(() => clock.pendingTimers() === 1, 'sleep timer');

    const parks = (await store.readEvents({ conversationId, limit: 10_000 })).items.filter(
      (event) => event.kind === 'durability/park',
    );
    expect(parks).toHaveLength(1);

    await clock.advanceBy(5_000);
    await Promise.all([left, right]);
  });

  test('fails closed on an undecodable park record without parking', async () => {
    const store = createMemoryAgentRuntimeStore();
    await store.appendEvent({
      conversationId,
      kind: 'durability/park',
      payload: { runId, kind: 'sleep' },
    });
    const clock = new TestClock();
    const durability = createLocalStepDurability({ store, conversationId, runId, clock });

    await expect(durability.sleep({ seconds: 5, name: 'nap' })).rejects.toThrow(
      ParkRecordDecodeError,
    );
    expect(clock.pendingTimers()).toBe(0);
  });
});
