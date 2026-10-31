/**
 * The budget wired into a real grammY client.
 *
 * grammY hands a transformer the Bot API's refusal as a value and turns it into
 * a `GrammyError` only after the whole chain has returned, so a budget that
 * learns about a 429 from an exception never learns about one here. These tests
 * use grammY's own `Api` over a `fetch` that answers the way Telegram does, and
 * a manual clock, so each answer is measured in intervals.
 */
import { describe, expect, test } from 'bun:test';
import { Api, GrammyError, HttpError, type Transformer } from 'grammy';
import {
  classifyTelegramSendFailure,
  TelegramNotDispatchedError,
} from '../src/entrypoints/telegram';
import { telegramBudgetTransformer } from '../src/entrypoints/telegram/grammy';
import { createManualClock, type ManualClock } from '../src/entrypoints/testing';
import { manualBudget } from './support/telegram-budget-clock';

interface BotApiCall {
  readonly chat: unknown;
  readonly at: number;
}

/** The signal type grammY declares for a call: the `abort-controller` polyfill's, not the platform's. */
type GrammySignal = NonNullable<Parameters<Transformer>[3]>;

/**
 * Named boundary: grammY declares its signal as the polyfill's type, and what a
 * running bot hands it is the platform `AbortSignal`, so a test that passes one
 * through the client must say so once, here.
 */
function grammySignal(signal: AbortSignal | LegacySignal): GrammySignal {
  return signal as unknown as GrammySignal;
}

type BotApiAnswer = { readonly status: number; readonly body: unknown } | 'hang';

const OK = { status: 200, body: { ok: true, result: { message_id: 1 } } } as const;

function tooManyRequests(retryAfter?: number): BotApiAnswer {
  return {
    status: 429,
    body: {
      ok: false,
      error_code: 429,
      description:
        retryAfter === undefined
          ? 'Too Many Requests'
          : `Too Many Requests: retry after ${retryAfter}`,
      ...(retryAfter !== undefined && { parameters: { retry_after: retryAfter } }),
    },
  };
}

/** A grammY client whose HTTP layer answers like Bot API, with the budget as its one transformer. */
function botClient(
  clock: ManualClock,
  budget: ReturnType<typeof manualBudget>['budget'],
  answerFor: (call: number) => BotApiAnswer = () => OK,
): { api: Api; calls: BotApiCall[] } {
  const calls: BotApiCall[] = [];
  const respond = async (_url: unknown, init?: RequestInit): Promise<Response> => {
    const payload: unknown = JSON.parse(String(init?.body));
    calls.push({ chat: Reflect.get(Object(payload), 'chat_id'), at: clock.now() });
    const answer = answerFor(calls.length);
    if (answer === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
          once: true,
        });
      });
    }
    return Response.json(answer.body, { status: answer.status });
  };
  const fetchBotApi = Object.assign(respond, { preconnect: () => undefined });
  const api = new Api('123456:fixture-token', { fetch: fetchBotApi });
  api.config.use(telegramBudgetTransformer(budget));
  return { api, calls };
}

describe('the budget as a grammY client transformer', () => {
  test('a 429 grammY returns as a response pauses the token for the stated wait', async () => {
    const clock = createManualClock();
    const { budget } = manualBudget(clock);
    const { api, calls } = botClient(clock, budget, (call) =>
      call === 1 ? tooManyRequests(2) : OK,
    );

    const failure = await api.sendMessage(1, 'first').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GrammyError);
    expect(classifyTelegramSendFailure(failure)).toMatchObject({
      reason: 'rate-limited',
      retryAfterSeconds: 2,
    });
    expect(budget.stats().pausedForMs).toBe(2_000);

    // Another chat, forty milliseconds later in real life: it waits for the pause.
    const second = api.sendMessage(2, 'second');
    await clock.advance(1_999);
    expect(calls.map((call) => call.chat)).toEqual([1]);
    await clock.advance(1);
    await second;
    expect(calls.map((call) => [call.chat, call.at])).toEqual([
      [1, 0],
      [2, 2_000],
    ]);
    expect(clock.pending()).toBe(0);
  });

  test('sends already waiting for their turn are held by the pause, then released one at a time', async () => {
    const clock = createManualClock();
    const { budget } = manualBudget(clock);
    const { api, calls } = botClient(clock, budget, (call) =>
      call === 1 ? tooManyRequests(2) : OK,
    );

    const sends = Array.from({ length: 5 }, (_, index) =>
      api.sendMessage(index + 1, 'campaign').catch((error: unknown) => error),
    );
    await clock.advance(0);
    expect(calls).toHaveLength(1);

    await clock.advance(1_999);
    expect(calls).toHaveLength(1);
    await clock.advance(1);
    expect(calls).toHaveLength(2);
    await clock.until(() => calls.length === 5, { limitMs: 1_000, stepMs: 1 });
    await Promise.all(sends);

    const times = calls.map((call) => call.at);
    expect(times[1]).toBe(2_000);
    for (let index = 2; index < times.length; index += 1) {
      expect((times[index] ?? 0) - (times[index - 1] ?? 0)).toBeCloseTo(1_000 / 24, 3);
    }
    expect(clock.pending()).toBe(0);
  });

  test('a 429 without retry_after pauses for the declared fallback', async () => {
    const clock = createManualClock();
    const { budget } = manualBudget(clock, { retryAfterFallbackMs: 500 });
    const { api, calls } = botClient(clock, budget, (call) =>
      call === 1 ? tooManyRequests() : OK,
    );

    await api.sendMessage(1, 'first').catch(() => undefined);
    expect(budget.stats().pausedForMs).toBe(500);
    const second = api.sendMessage(2, 'second');
    await clock.advance(499);
    expect(calls).toHaveLength(1);
    await clock.advance(1);
    await second;
    expect(calls[1]?.at).toBe(500);
  });

  test('another refusal and a success leave the token running', async () => {
    const clock = createManualClock();
    const { budget } = manualBudget(clock);
    const { api } = botClient(clock, budget, () => ({
      status: 400,
      body: { ok: false, error_code: 400, description: 'Bad Request: chat not found' },
    }));
    await expect(api.sendMessage(1, 'nobody')).rejects.toBeInstanceOf(GrammyError);
    expect(budget.stats().pausedForMs).toBe(0);

    const fine = manualBudget(clock);
    const sender = botClient(clock, fine.budget);
    await sender.api.sendMessage(1, 'fine');
    expect(fine.budget.stats()).toMatchObject({ granted: 1, pausedForMs: 0 });
  });

  test('a cancellation while the send waits for its turn is a request that never left', async () => {
    const clock = createManualClock();
    const { budget } = manualBudget(clock);
    const { api, calls } = botClient(clock, budget);

    const first = api.sendMessage(1, 'first');
    const controller = new AbortController();
    const second = api
      .sendMessage(2, 'second', undefined, grammySignal(controller.signal))
      .catch((error: unknown) => error);
    const third = api.sendMessage(3, 'third');

    await clock.advance(0);
    controller.abort();
    const refused = await second;

    expect(refused).toBeInstanceOf(TelegramNotDispatchedError);
    expect(refused).toMatchObject({ code: 'TELEGRAM_NOT_DISPATCHED', stage: 'request' });
    expect(classifyTelegramSendFailure(refused)).toMatchObject({
      reason: 'not-dispatched',
      retryable: true,
      evidence: 'transport',
    });
    expect(String(refused)).not.toContain('fixture-token');

    await clock.advance(42);
    await Promise.all([first, third]);
    // Chat 2 never reached the HTTP layer and left no slot behind: the third is one interval after the first.
    expect(calls.map((call) => call.chat)).toEqual([1, 3]);
    expect(calls[1]?.at).toBeCloseTo(41.666_666, 3);
    expect(clock.pending()).toBe(0);
  });

  test('a signal already aborted, or aborted in the instant after the grant, sends nothing', async () => {
    const clock = createManualClock();
    const { budget } = manualBudget(clock);
    const { api, calls } = botClient(clock, budget);

    const before = new AbortController();
    before.abort(new Error('before'));
    await expect(
      api.sendMessage(1, 'x', undefined, grammySignal(before.signal)),
    ).rejects.toBeInstanceOf(TelegramNotDispatchedError);
    expect(budget.stats().granted).toBe(0);

    // Granted, then cancelled before the request was handed to the client: nothing was sent,
    // although the slot is spent.
    const after = new AbortController();
    const run = api.sendMessage(2, 'y', undefined, grammySignal(after.signal));
    after.abort(new Error('after the grant'));
    await expect(run).rejects.toBeInstanceOf(TelegramNotDispatchedError);
    expect(budget.stats().granted).toBe(1);
    expect(calls).toHaveLength(0);
  });

  test('a cancellation after the request was handed on stays an ordinary error', async () => {
    const clock = createManualClock();
    const { budget } = manualBudget(clock);
    const { api, calls } = botClient(clock, budget, () => 'hang');

    const controller = new AbortController();
    const inFlight = api
      .sendMessage(1, 'maybe delivered', undefined, grammySignal(controller.signal))
      .catch((error: unknown) => error);
    await clock.advance(0);
    expect(calls).toHaveLength(1);
    controller.abort();
    const failure = await inFlight;

    expect(failure).toBeInstanceOf(HttpError);
    expect(failure).not.toBeInstanceOf(TelegramNotDispatchedError);
    expect(classifyTelegramSendFailure(failure).reason).toBe('unknown');
    expect(budget.stats().pausedForMs).toBe(0);
  });
});

/** A signal typed and shaped like the polyfill grammY declares: no `reason`, only events. */
class LegacySignal {
  aborted = false;
  readonly listeners = new Set<() => void>();
  addEventListener(_type: 'abort', listener: () => void): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: 'abort', listener: () => void): void {
    this.listeners.delete(listener);
  }
  abort(): void {
    this.aborted = true;
    for (const listener of [...this.listeners]) listener();
  }
}

describe('a signal that is not the platform AbortSignal', () => {
  test('cancels a waiting send as a request that never left and detaches afterwards', async () => {
    const clock = createManualClock();
    const { budget } = manualBudget(clock);
    const { api, calls } = botClient(clock, budget);
    budget.pause(1_000);

    const signal = new LegacySignal();
    const waiting = api
      .sendMessage(1, 'held', undefined, grammySignal(signal))
      .catch((error: unknown) => error);
    await clock.advance(0);
    expect(signal.listeners.size).toBe(1);

    signal.abort();
    const refused = await waiting;
    expect(refused).toBeInstanceOf(TelegramNotDispatchedError);
    // The polyfill states no reason; the cause says what happened.
    expect(Reflect.get(Object(refused), 'cause')).toMatchObject({ name: 'AbortError' });
    expect(signal.listeners.size).toBe(0);
    expect(calls).toHaveLength(0);

    await clock.advance(1_000);
    expect(clock.pending()).toBe(0);
  });

  test('carries the reason a signal states, and refuses one already aborted', async () => {
    const clock = createManualClock();
    const { budget } = manualBudget(clock);
    const { api, calls } = botClient(clock, budget);

    const stated = new Error('operator stopped the campaign');
    const signal = Object.assign(new LegacySignal(), { reason: stated });
    signal.abort();
    const refused = await api
      .sendMessage(1, 'late', undefined, grammySignal(signal))
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(TelegramNotDispatchedError);
    expect(Reflect.get(Object(refused), 'cause')).toBe(stated);
    expect(signal.listeners.size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test('sends normally and detaches when nothing was cancelled', async () => {
    const clock = createManualClock();
    const { budget } = manualBudget(clock);
    const { api, calls } = botClient(clock, budget);

    const signal = new LegacySignal();
    await api.sendMessage(1, 'sent', undefined, grammySignal(signal));
    expect(calls).toHaveLength(1);
    expect(signal.listeners.size).toBe(0);
    expect(budget.stats().granted).toBe(1);
  });
});
