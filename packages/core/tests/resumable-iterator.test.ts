import { describe, expect, test } from 'bun:test';
import {
  createBackoff,
  type ResumableAttempt,
  resumableIterator,
} from '../src/browser/resumable';

async function* fromArray<T>(items: readonly T[], failAfter?: number): AsyncGenerator<T> {
  let delivered = 0;
  for (const item of items) {
    yield item;
    delivered += 1;
    if (failAfter !== undefined && delivered >= failAfter) {
      throw new Error(`source dropped after ${delivered}`);
    }
  }
}

const FAST = { minDelayMs: 1, maxDelayMs: 4, jitter: 0 } as const;

describe('createBackoff', () => {
  test('doubles to the ceiling and subtracts jitter without exceeding it', () => {
    const plain = createBackoff({ minDelayMs: 10, maxDelayMs: 40, jitter: 0 });
    expect([plain.next(), plain.next(), plain.next(), plain.next()]).toEqual([10, 20, 40, 40]);
    plain.reset();
    expect(plain.next()).toBe(10);

    // Jitter only ever shortens: the declared ceiling stays a real bound.
    const jittered = createBackoff({ minDelayMs: 100, maxDelayMs: 100, jitter: 0.5 }, () => 1);
    expect(jittered.next()).toBe(50);
    const unlucky = createBackoff({ minDelayMs: 100, maxDelayMs: 100, jitter: 0.5 }, () => 0);
    expect(unlucky.next()).toBe(100);
  });

  test('two consumers of the same recovering server do not wait in lockstep', () => {
    const draws = [0.1, 0.9];
    const policy = { minDelayMs: 1_000, maxDelayMs: 1_000, jitter: 0.5 } as const;
    const delays = draws.map((draw) => createBackoff(policy, () => draw).next());
    expect(new Set(delays).size).toBe(2);
    // Every one of them still respects the declared bounds.
    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(500);
      expect(delay).toBeLessThanOrEqual(1_000);
    }
  });

  test('refuses a ceiling below the floor', () => {
    expect(() => createBackoff({ minDelayMs: 100, maxDelayMs: 10, jitter: 0 })).toThrow();
  });
});

describe('resumableIterator', () => {
  test('re-opens from the last delivered cursor rather than restarting', async () => {
    const opened: (number | undefined)[] = [];
    const attempts: ResumableAttempt[] = [];
    const pages: Record<string, readonly number[]> = {
      start: [1, 2],
      '2': [3, 4],
      '4': [5],
    };

    const delivered: number[] = [];
    for await (const item of resumableIterator<number, number>({
      retry: FAST,
      open(cursor) {
        opened.push(cursor);
        const page = pages[cursor === undefined ? 'start' : String(cursor)] ?? [];
        return fromArray(page, page.length);
      },
      advance: (item) => item,
      isTerminal: (item) => item === 5,
      onAttempt: (attempt) => attempts.push(attempt),
    })) {
      delivered.push(item);
    }

    expect(delivered).toEqual([1, 2, 3, 4, 5]);
    // Resumed, not restarted: no item is delivered twice and each re-open carries the cursor.
    expect(opened).toEqual([undefined, 2, 4]);
    expect(attempts.map((attempt) => attempt.number)).toEqual([1, 1]);
    expect(attempts.every((attempt) => attempt.delayMs > 0)).toBe(true);
  });

  test('a terminal item ends iteration instead of triggering a re-open', async () => {
    let opens = 0;
    const delivered: string[] = [];
    for await (const item of resumableIterator<string, number>({
      retry: FAST,
      open() {
        opens += 1;
        return fromArray(['a', 'end']);
      },
      advance: (_item, cursor) => (cursor ?? 0) + 1,
      isTerminal: (item) => item === 'end',
    })) {
      delivered.push(item);
    }
    expect(delivered).toEqual(['a', 'end']);
    expect(opens).toBe(1);
  });

  test('a repeatedly failing source keeps its attempt counter growing until a delivery', async () => {
    const attempts: ResumableAttempt[] = [];
    let opens = 0;
    const delivered: number[] = [];
    for await (const item of resumableIterator<number, number>({
      retry: { minDelayMs: 1, maxDelayMs: 8, jitter: 0 },
      open() {
        opens += 1;
        if (opens <= 3) throw new Error(`open failed ${opens}`);
        return fromArray([1]);
      },
      advance: (item) => item,
      isTerminal: () => true,
      onAttempt: (attempt) => attempts.push(attempt),
    })) {
      delivered.push(item);
    }
    expect(delivered).toEqual([1]);
    expect(attempts.map((attempt) => attempt.number)).toEqual([1, 2, 3]);
    // The delay grows with the attempt, which is the whole point of backing off.
    expect(attempts.map((attempt) => attempt.delayMs)).toEqual([1, 2, 4]);
    expect(attempts.map((attempt) => String(attempt.error))).toEqual([
      'Error: open failed 1',
      'Error: open failed 2',
      'Error: open failed 3',
    ]);
  });

  test('an aborted signal ends iteration promptly, mid-wait', async () => {
    const controller = new AbortController();
    const delivered: number[] = [];
    const started = performance.now();

    for await (const item of resumableIterator<number, number>({
      // A wait long enough that returning on time cannot be an accident.
      retry: { minDelayMs: 5_000, maxDelayMs: 5_000, jitter: 0 },
      signal: controller.signal,
      open() {
        return fromArray([1], 1);
      },
      advance: (item) => item,
      onAttempt: () => setTimeout(() => controller.abort(), 5),
    })) {
      delivered.push(item);
    }

    expect(delivered).toEqual([1]);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test('an already-aborted signal opens nothing at all', async () => {
    let opens = 0;
    const delivered: number[] = [];
    for await (const item of resumableIterator<number, number>({
      retry: FAST,
      signal: AbortSignal.abort(),
      open() {
        opens += 1;
        return fromArray([1]);
      },
      advance: (item) => item,
    })) {
      delivered.push(item);
    }
    expect(opens).toBe(0);
    expect(delivered).toEqual([]);
  });
});
