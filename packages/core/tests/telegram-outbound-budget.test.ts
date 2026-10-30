/**
 * One token has one outbound budget.
 *
 * The questions a shared limiter answers badly by hand: does a second campaign
 * get its own quota, does an album cost one message or five, does a 429 stop
 * every sender or only the one that saw it, and does a cancelled wait leave a
 * token behind for the next caller. The clock is manual so the answers are
 * measured in intervals rather than in the speed of the test machine.
 */
import { describe, expect, test } from 'bun:test';
import {
  type TelegramOutboundBudgetConfig,
  telegramOutboundBudget,
} from '../src/entrypoints/telegram';
import { createManualClock, type ManualClock } from '../src/entrypoints/testing';

/** A Bot API-shaped refusal the classifier reads without prose guessing. */
function refusal(error_code: number, description: string, retry_after?: number): Error {
  return Object.assign(new Error(description), {
    error_code,
    description,
    ...(retry_after !== undefined && { parameters: { retry_after } }),
  });
}

/** An abortable sleeper driven by the same manual clock the budget reads. */
function sleepOn(clock: ManualClock) {
  return (milliseconds: number, signal?: AbortSignal): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      let settled = false;
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        timer.cancel();
        reject(signal?.reason);
      };
      const timer = clock.schedule(() => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, milliseconds);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
}

function manualBudget(
  clock: ManualClock,
  overrides: Partial<TelegramOutboundBudgetConfig> = {},
): {
  config: TelegramOutboundBudgetConfig;
  budget: ReturnType<typeof telegramOutboundBudget>;
} {
  const config: TelegramOutboundBudgetConfig = {
    token: `fixture-${crypto.randomUUID()}`,
    messagesPerSecond: 24,
    now: () => clock.now(),
    sleep: sleepOn(clock),
    ...overrides,
  };
  return { config, budget: telegramOutboundBudget(config) };
}

describe('the token outbound budget', () => {
  test('one token has one budget; a pause on one client stops its aliases and not another token', async () => {
    const clock = createManualClock();
    const { config, budget } = manualBudget(clock);
    const other = manualBudget(clock);

    // The same token, a second Bot API alias in the same process.
    expect(telegramOutboundBudget(config)).toBe(budget);

    budget.pause(1_000);
    const firstAt: number[] = [];
    const otherAt: number[] = [];
    const first = budget.run('sendMessage', {}, undefined, async () => {
      firstAt.push(clock.now());
    });
    const otherRun = other.budget.run('sendMessage', {}, undefined, async () => {
      otherAt.push(clock.now());
    });

    await clock.advance(0);
    expect(otherAt).toEqual([0]);
    expect(firstAt).toEqual([]);

    await clock.advance(1_000);
    expect(firstAt).toEqual([1_000]);
    await Promise.all([first, otherRun]);
    expect(clock.pending()).toBe(0);

    // The registry never carries the credential in its public state.
    expect(JSON.stringify(budget.stats())).not.toContain(config.token);
  });

  test('a token keeps one object after a long idle period', async () => {
    const clock = createManualClock();
    const { config, budget } = manualBudget(clock);
    await clock.advance(600_001);
    expect(telegramOutboundBudget(config)).toBe(budget);
  });

  test('20 workers, two campaigns and ordinary replies share one 24/s budget without a burst', async () => {
    const clock = createManualClock();
    const { budget } = manualBudget(clock);
    const lanes = [
      ...Array.from({ length: 20 }, () => 'campaign-a'),
      ...Array.from({ length: 20 }, () => 'campaign-b'),
      ...Array.from({ length: 10 }, () => 'reply'),
    ];
    const sends: { lane: string; at: number }[] = [];

    const runs = lanes.map((lane) =>
      budget.run('sendMessage', {}, undefined, async () => {
        sends.push({ lane, at: clock.now() });
      }),
    );
    await clock.until(() => sends.length === lanes.length, { limitMs: 5_000, stepMs: 1 });
    await Promise.all(runs);

    expect(sends).toHaveLength(50);
    expect(new Set(sends.map((send) => send.lane)).size).toBe(3);
    const times = sends.map((send) => send.at).sort((left, right) => left - right);
    const elapsed = (times.at(-1) ?? 0) - (times[0] ?? 0);
    // 49 intervals at 24/s. 20/s, 25/s and 30/s all land outside this band.
    expect(elapsed).toBeGreaterThanOrEqual(2_000);
    expect(elapsed).toBeLessThanOrEqual(2_100);

    // No burst: a quarter-second window can hold at most 7 grants at 24/s.
    // The elapsed band above, not this count, is what separates 24/s from 25/s.
    const busiest = Math.max(
      ...times.map((start) => times.filter((at) => at >= start && at < start + 250).length),
    );
    expect(busiest).toBeLessThanOrEqual(7);
    expect(clock.pending()).toBe(0);
  });

  test('an album costs its media length, a follow-up CTA is one more, and a read costs nothing', async () => {
    const clock = createManualClock();
    const { budget } = manualBudget(clock);
    const albumAt: number[] = [];
    const ctaAt: number[] = [];
    const readAt: number[] = [];

    const album = budget.run('sendMediaGroup', { media: [1, 2, 3] }, undefined, async () => {
      albumAt.push(clock.now());
    });
    const cta = budget.run('sendMessage', { chat_id: 1 }, undefined, async () => {
      ctaAt.push(clock.now());
    });
    const read = budget.run('getMe', {}, undefined, async () => {
      readAt.push(clock.now());
    });
    await clock.until(() => albumAt.length + ctaAt.length + readAt.length === 3, {
      limitMs: 1_000,
      stepMs: 1,
    });

    expect(albumAt).toEqual([0]);
    expect(ctaAt[0]).toBeCloseTo(125, 5);
    expect(readAt).toEqual([0]);
    expect(budget.stats()).toMatchObject({ granted: 2, messages: 4 });

    const nextAt: number[] = [];
    const next = budget.run('sendMessage', {}, undefined, async () => {
      nextAt.push(clock.now());
    });
    await clock.until(() => nextAt.length === 1, { limitMs: 1_000, stepMs: 1 });
    expect(nextAt[0]).toBeCloseTo(166.666_666, 3);
    await Promise.all([album, cta, read, next]);
    expect(clock.pending()).toBe(0);
  });

  test('each weighted method costs exactly its array length; malformed media costs one', async () => {
    const weighted = [
      { method: 'sendMediaGroup', payload: { media: [1, 2, 3] }, cost: 3 },
      { method: 'sendPaidMedia', payload: { media: [1, 2] }, cost: 2 },
      { method: 'copyMessages', payload: { message_ids: [1, 2, 3] }, cost: 3 },
      { method: 'forwardMessages', payload: { message_ids: [1, 2] }, cost: 2 },
    ] as const;

    for (const item of weighted) {
      const clock = createManualClock();
      const { budget } = manualBudget(clock);
      const at: number[] = [];
      const first = budget.run(item.method, item.payload, undefined, async () => {
        at.push(clock.now());
      });
      const second = budget.run('sendMessage', {}, undefined, async () => {
        at.push(clock.now());
      });
      await clock.until(() => at.length === 2, { limitMs: 1_000, stepMs: 1 });
      expect(at[0]).toBe(0);
      expect(at[1]).toBeCloseTo((item.cost * 1_000) / 24, 3);
      await Promise.all([first, second]);
      expect(clock.pending()).toBe(0);
    }

    const clock = createManualClock();
    const { budget } = manualBudget(clock);
    const malformed: number[] = [];
    const afterMalformed: number[] = [];
    const malformedRun = budget.run(
      'sendMediaGroup',
      { media: 'not-an-array' },
      undefined,
      async () => {
        malformed.push(clock.now());
      },
    );
    const afterMalformedRun = budget.run('sendMessage', {}, undefined, async () => {
      afterMalformed.push(clock.now());
    });
    await clock.until(() => malformed.length + afterMalformed.length === 2, {
      limitMs: 1_000,
      stepMs: 1,
    });
    expect(afterMalformed[0]).toBeCloseTo(1_000 / 24, 3);
    await Promise.all([malformedRun, afterMalformedRun]);
  });

  test('429 pauses every path of the token and resumes one message at a time', async () => {
    const clock = createManualClock();
    const { budget } = manualBudget(clock);
    const failure = refusal(429, 'Too Many Requests: retry after 1', 1);

    const failed = await budget
      .run('sendMessage', {}, undefined, async () => {
        throw failure;
      })
      .catch((error: unknown) => error);
    expect(failed).toBe(failure);
    expect(budget.stats().pausedForMs).toBe(1_000);

    const times: number[] = [];
    const runs = Array.from({ length: 5 }, () =>
      budget.run('sendMessage', {}, undefined, async () => {
        times.push(clock.now());
      }),
    );

    await clock.advance(999);
    expect(times).toHaveLength(0);
    await clock.advance(1);
    expect(times).toHaveLength(1);
    await clock.advance(1);
    expect(times).toHaveLength(1);
    await clock.advance(41);
    expect(times).toHaveLength(2);
    expect(times[0]).toBe(1_000);
    expect((times[1] ?? 0) - (times[0] ?? 0)).toBeGreaterThanOrEqual(41);

    await clock.until(() => times.length === 5, { limitMs: 1_000, stepMs: 1 });
    await Promise.all(runs);
    const intervals = times.slice(1).map((at, index) => at - (times[index] ?? 0));
    for (const interval of intervals) expect(interval).toBeCloseTo(1_000 / 24, 3);
    expect(clock.pending()).toBe(0);
  });

  test('a later 429 with a smaller retry_after cannot shorten the pause', () => {
    const clock = createManualClock();
    const { budget } = manualBudget(clock);
    budget.pauseAfter(refusal(429, 'Too Many Requests: retry after 10', 10));
    expect(budget.stats().pausedForMs).toBe(10_000);
    budget.pauseAfter(refusal(429, 'Too Many Requests: retry after 1', 1));
    expect(budget.stats().pausedForMs).toBe(10_000);
  });

  test('a 429 from a non-send call still pauses the token for later sends', async () => {
    const clock = createManualClock();
    const { budget } = manualBudget(clock);
    await budget
      .run('editMessageText', {}, undefined, async () => {
        throw refusal(429, 'Too Many Requests: retry after 1', 1);
      })
      .catch(() => undefined);
    expect(budget.stats().pausedForMs).toBe(1_000);

    const times: number[] = [];
    const run = budget.run('sendMessage', {}, undefined, async () => {
      times.push(clock.now());
    });
    await clock.advance(999);
    expect(times).toHaveLength(0);
    await clock.advance(1);
    expect(times).toEqual([1_000]);
    await run;
  });

  test('waitUntilResumed waits out a pause without spending a message', async () => {
    const clock = createManualClock();
    const { budget } = manualBudget(clock);
    budget.pause(1_000);
    let resumed = false;
    const waiting = budget.waitUntilResumed().then(() => {
      resumed = true;
    });
    await clock.advance(999);
    expect(resumed).toBe(false);
    await clock.advance(1);
    await waiting;
    expect(resumed).toBe(true);
    expect(budget.stats().granted).toBe(0);
  });

  test('a negative clock start still sends immediately and has no pause', async () => {
    const clock = createManualClock({ startMs: -1_000 });
    const { budget } = manualBudget(clock);
    const at: number[] = [];
    const run = budget.run('sendMessage', {}, undefined, async () => {
      at.push(clock.now());
    });
    await clock.advance(0);
    expect(at).toEqual([-1_000]);
    expect(budget.stats().pausedForMs).toBe(0);
    await run;
  });

  test('an infinite pause is a real pause, and NaN or negative is refused', () => {
    const clock = createManualClock();
    const { budget } = manualBudget(clock);
    budget.pause(Infinity);
    expect(budget.stats().pausedForMs).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => budget.pause(NaN)).toThrow(RangeError);
    expect(() => budget.pause(-1)).toThrow(RangeError);

    const huge = manualBudget(clock);
    huge.budget.pauseAfter(refusal(429, 'Too Many Requests', 1e306));
    expect(huge.budget.stats().pausedForMs).toBe(Number.MAX_SAFE_INTEGER);
  });

  test('a later pause cannot shorten the one already in force', async () => {
    const clock = createManualClock();
    const { budget } = manualBudget(clock);
    budget.pause(1_000);
    budget.pause(100);
    const times: number[] = [];
    const run = budget.run('sendMessage', {}, undefined, async () => {
      times.push(clock.now());
    });
    await clock.advance(999);
    expect(times).toHaveLength(0);
    await clock.advance(1);
    expect(times).toEqual([1_000]);
    await run;
  });

  test('a 429 without retry_after uses the declared fallback, never a zero wait', async () => {
    const clock = createManualClock();
    const { budget } = manualBudget(clock, { retryAfterFallbackMs: 500 });
    const failure = refusal(429, 'Too Many Requests');

    await budget
      .run('sendMessage', {}, undefined, async () => {
        throw failure;
      })
      .catch(() => undefined);

    const times: number[] = [];
    const run = budget.run('sendMessage', {}, undefined, async () => {
      times.push(clock.now());
    });
    await clock.advance(499);
    expect(times).toHaveLength(0);
    await clock.advance(1);
    expect(times).toEqual([500]);
    await run;
  });

  test('a 5xx and a network failure are sent once, are not paused, and are not retried', async () => {
    const clock = createManualClock();
    const { budget } = manualBudget(clock);
    let calls = 0;
    const server = refusal(502, 'Bad Gateway');
    const result = await budget
      .run('sendMessage', {}, undefined, async () => {
        calls += 1;
        throw server;
      })
      .catch((error: unknown) => error);
    expect(result).toBe(server);
    expect(calls).toBe(1);
    expect(budget.stats().pausedForMs).toBe(0);

    const times: number[] = [];
    const next = budget.run('sendMessage', {}, undefined, async () => {
      times.push(clock.now());
    });
    await clock.advance(42);
    expect(times).toHaveLength(1);
    await next;

    const networkClock = createManualClock();
    const network = manualBudget(networkClock);
    let networkCalls = 0;
    const networkFailure = new TypeError('fetch failed');
    const networkResult = await network.budget
      .run('sendMessage', {}, undefined, async () => {
        networkCalls += 1;
        throw networkFailure;
      })
      .catch((error: unknown) => error);
    expect(networkResult).toBe(networkFailure);
    expect(networkCalls).toBe(1);
    expect(network.budget.stats().pausedForMs).toBe(0);
  });

  test('a waiting acquire is cancelled without spending its slot or calling the provider', async () => {
    const clock = createManualClock();
    const { budget } = manualBudget(clock);
    const firstAt: number[] = [];
    const thirdAt: number[] = [];
    let secondSent = false;

    const first = budget.run('sendMessage', {}, undefined, async () => {
      firstAt.push(clock.now());
    });
    const controller = new AbortController();
    const second = budget.run('sendMessage', {}, controller.signal, async () => {
      secondSent = true;
    });
    const third = budget.run('sendMessage', {}, undefined, async () => {
      thirdAt.push(clock.now());
    });

    await clock.advance(0);
    expect(firstAt).toEqual([0]);
    controller.abort();
    await expect(second).rejects.toBe(controller.signal.reason);
    expect(secondSent).toBe(false);

    await clock.advance(42);
    // The cancelled waiter did not reserve a slot: the third is at one
    // interval, not two.
    expect(thirdAt[0]).toBeCloseTo(41.666_666, 3);
    await Promise.all([first, third]);
    expect(clock.pending()).toBe(0);
  });

  test('abort before enqueue and abort after a grant both call no provider', async () => {
    const clock = createManualClock();
    const { budget } = manualBudget(clock);
    let sentBefore = false;
    const before = new AbortController();
    before.abort(new Error('before enqueue'));
    await expect(
      budget.run('sendMessage', {}, before.signal, async () => {
        sentBefore = true;
      }),
    ).rejects.toBe(before.signal.reason);
    expect(sentBefore).toBe(false);
    expect(budget.stats().granted).toBe(0);

    let sentAfter = false;
    const after = new AbortController();
    const run = budget.run('sendMessage', {}, after.signal, async () => {
      sentAfter = true;
    });
    after.abort(new Error('after grant'));
    await expect(run).rejects.toBe(after.signal.reason);
    expect(sentAfter).toBe(false);
    expect(budget.stats().granted).toBe(1);
  });

  test('waitUntilResumed can be cancelled without spending a message', async () => {
    const clock = createManualClock();
    const { budget } = manualBudget(clock);
    budget.pause(1_000);
    const stop = new AbortController();
    const waiting = budget.waitUntilResumed(stop.signal);
    stop.abort(new Error('stop waiting'));
    await expect(waiting).rejects.toBe(stop.signal.reason);
    expect(budget.stats().granted).toBe(0);
    expect(clock.pending()).toBe(0);
  });

  test('a wait cancelled during a pause does not send when the pause ends', async () => {
    const clock = createManualClock();
    const { budget } = manualBudget(clock);
    budget.pause(1_000);
    let sent = false;
    const controller = new AbortController();
    const waiting = budget.run('sendMessage', {}, controller.signal, async () => {
      sent = true;
    });

    await clock.advance(0);
    controller.abort();
    await expect(waiting).rejects.toBe(controller.signal.reason);
    await clock.advance(1_000);
    expect(sent).toBe(false);
    expect(clock.pending()).toBe(0);
  });

  test('different options for the same token are refused without naming the token', () => {
    const clock = createManualClock();
    const { config } = manualBudget(clock);
    let failure: unknown;
    try {
      telegramOutboundBudget({ ...config, messagesPerSecond: 20 });
    } catch (error) {
      failure = error;
    }
    expect(String(failure)).toMatch(/different options/);
    expect(String(failure)).not.toContain(config.token);
  });
});
