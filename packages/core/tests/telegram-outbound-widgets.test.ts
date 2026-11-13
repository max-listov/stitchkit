import { describe, expect, test } from 'bun:test';
import { telegramOutboundBudget } from '../src/entrypoints/telegram';
import { createManualClock } from '../src/entrypoints/testing';
import { sendCost } from '../src/telegram/outbound-cost';
import { manualBudget } from './support/telegram-budget-clock';

const MESSAGE_METHODS = ['sendWidget', 'sendSharedWidget', 'editMessageWidgetData'];
const FREE_METHODS = ['answerWidgetQuery', 'editSharedWidgetData', 'editMessageText'];
const REFUSALS = [
  { name: 'thrown', throws: true },
  { name: 'returned', throws: false },
];

function floodWait() {
  return {
    ok: false,
    error_code: 429,
    description: 'Too Many Requests: retry after 2',
    parameters: { retry_after: 2 },
  };
}

/** Identity alone cannot distinguish a preserved rejection from a swallowed one. */
async function expectRefusal(
  call: Promise<unknown>,
  failure: unknown,
  throws: boolean,
): Promise<void> {
  const [outcome] = await Promise.allSettled([call]);
  expect(outcome?.status).toBe(throws ? 'rejected' : 'fulfilled');
  if (outcome?.status === 'rejected') expect(outcome.reason).toBe(failure);
  else expect(outcome?.value).toBe(failure);
}

describe('widget calls in the token outbound budget', () => {
  for (const method of MESSAGE_METHODS) {
    test(`${method} costs exactly one message`, () => {
      expect(sendCost(method, { chat_id: 1 })).toBe(1);
      expect(sendCost(method, { inline_message_id: 'inline-fixture' })).toBe(1);
      expect(sendCost(method, undefined)).toBe(1);
    });

    test(`${method} shares the sendMessage schedule and counters across token aliases`, async () => {
      const clock = createManualClock();
      const { config, budget } = manualBudget(clock, { messagesPerSecond: 10 });
      const alias = telegramOutboundBudget(config);
      await budget.run('sendMessage', { chat_id: 1 }, undefined, async () => undefined, {
        lane: 'bulk',
      });

      const calls: { method: string; at: number }[] = [];
      const result = { widget: 'fixture' };
      const widget = alias.run(method, { chat_id: 2 }, undefined, async () => {
        calls.push({ method, at: clock.now() });
        return result;
      });
      const message = budget.run('sendMessage', { chat_id: 3 }, undefined, async () => {
        calls.push({ method: 'sendMessage', at: clock.now() });
      });

      await clock.advance(99);
      expect(calls).toEqual([]);
      await clock.advance(1);
      expect(calls).toEqual([{ method, at: 100 }]);
      expect(await widget).toBe(result);
      await clock.advance(100);
      await message;
      expect(calls).toEqual([
        { method, at: 100 },
        { method: 'sendMessage', at: 200 },
      ]);
      expect(budget.stats()).toMatchObject({ granted: 3, messages: 3, queued: 0 });
      expect(clock.pending()).toBe(0);
    });

    for (const refusal of REFUSALS) {
      test(`${method}: a ${refusal.name} 429 holds its chat, passes other chats and is never retried`, async () => {
        const clock = createManualClock();
        const { budget } = manualBudget(clock, { messagesPerSecond: 10 });
        const failure = floodWait();
        let attempts = 0;
        const call = budget.run(method, { chat_id: 1 }, undefined, async () => {
          attempts += 1;
          if (refusal.throws) throw failure;
          return failure;
        });
        await expectRefusal(call, failure, refusal.throws);
        expect(attempts).toBe(1);
        expect(budget.stats()).toMatchObject({ pausedChats: 1, pausedForMs: 0, messages: 1 });

        const sameAt: number[] = [];
        const otherAt: number[] = [];
        const same = budget.run('sendMessage', { chat_id: 1 }, undefined, async () => {
          sameAt.push(clock.now());
        });
        const other = budget.run('sendMessage', { chat_id: 2 }, undefined, async () => {
          otherAt.push(clock.now());
        });
        await clock.advance(1_999);
        expect(sameAt).toEqual([]);
        expect(otherAt).toEqual([100]);
        expect(attempts).toBe(1);
        await clock.advance(1);
        await Promise.all([same, other]);
        expect(sameAt).toEqual([2_000]);
        expect(budget.stats()).toMatchObject({ granted: 3, messages: 3, pausedChats: 0 });
        expect(clock.pending()).toBe(0);
      });

      test(`${method}: refusal call waits and spends one but a ${refusal.name} 429 pauses nothing`, async () => {
        const clock = createManualClock();
        const { budget } = manualBudget(clock, { messagesPerSecond: 10 });
        budget.pause(1_000);
        const failure = floodWait();
        let attempts = 0;
        const failed = expectRefusal(
          budget.run(
            method,
            { chat_id: 1 },
            undefined,
            async () => {
              attempts += 1;
              if (refusal.throws) throw failure;
              return failure;
            },
            { refusal: 'call' },
          ),
          failure,
          refusal.throws,
        );
        await clock.advance(999);
        expect(attempts).toBe(0);
        expect(budget.stats().messages).toBe(0);
        await clock.advance(1);
        await failed;
        expect(attempts).toBe(1);
        expect(budget.stats()).toMatchObject({ messages: 1, pausedChats: 0, pausedForMs: 0 });
        const at: number[] = [];
        const next = budget.run('sendMessage', { chat_id: 1 }, undefined, async () => {
          at.push(clock.now());
        });
        await clock.advance(100);
        await next;
        expect(at).toEqual([1_100]);
        expect(clock.pending()).toBe(0);
      });
    }

    test(`${method}: cancelling a queued call sends nothing and leaves its slot to the next message`, async () => {
      const clock = createManualClock();
      const { budget } = manualBudget(clock, { messagesPerSecond: 10 });
      await budget.run('sendMessage', {}, undefined, async () => undefined);
      const controller = new AbortController();
      let attempts = 0;
      const waiting = budget.run(method, { chat_id: 1 }, controller.signal, async () => {
        attempts += 1;
      });
      await clock.advance(0);
      expect(attempts).toBe(0);
      controller.abort(new Error('fixture cancellation'));
      await expect(waiting).rejects.toBe(controller.signal.reason);
      const at: number[] = [];
      const next = budget.run('sendMessage', {}, undefined, async () => {
        at.push(clock.now());
      });
      await clock.advance(100);
      await next;
      expect(at).toEqual([100]);
      expect(attempts).toBe(0);
      expect(budget.stats()).toMatchObject({ granted: 2, messages: 2, queued: 0 });
      expect(clock.pending()).toBe(0);
    });
  }

  for (const refusal of REFUSALS) {
    test(`an inline widget edit's ${refusal.name} 429 pauses the token without a chat`, async () => {
      const clock = createManualClock();
      const { budget } = manualBudget(clock, { messagesPerSecond: 10 });
      const failure = floodWait();
      let attempts = 0;
      const call = budget.run(
        'editMessageWidgetData',
        { inline_message_id: 'fixture' },
        undefined,
        async () => {
          attempts += 1;
          if (refusal.throws) throw failure;
          return failure;
        },
      );
      await expectRefusal(call, failure, refusal.throws);
      expect(attempts).toBe(1);
      expect(budget.stats()).toMatchObject({
        messages: 1,
        pausedChats: 0,
        pausedForMs: 2_000,
      });
      const at: number[] = [];
      const next = budget.run('sendMessage', { chat_id: 2 }, undefined, async () => {
        at.push(clock.now());
      });
      await clock.advance(1_999);
      expect(at).toEqual([]);
      await clock.advance(1);
      await next;
      expect(at).toEqual([2_000]);
      expect(attempts).toBe(1);
      expect(clock.pending()).toBe(0);
    });
  }

  for (const method of FREE_METHODS) {
    test(`${method} remains free during a pause and its 429 does not extend it`, async () => {
      expect(sendCost(method, { chat_id: 1 })).toBe(0);
      const clock = createManualClock();
      const { budget } = manualBudget(clock, { messagesPerSecond: 10 });
      budget.pause(1_000);
      for (const refusal of REFUSALS) {
        const failure = floodWait();
        let attempts = 0;
        const call = budget.run(method, { chat_id: 1 }, undefined, async () => {
          attempts += 1;
          if (refusal.throws) throw failure;
          return failure;
        });
        await expectRefusal(call, failure, refusal.throws);
        expect(attempts).toBe(1);
        expect(clock.now()).toBe(0);
        expect(budget.stats()).toMatchObject({ granted: 0, messages: 0, pausedForMs: 1_000 });
      }
      const at: number[] = [];
      const next = budget.run('sendMessage', { chat_id: 1 }, undefined, async () => {
        at.push(clock.now());
      });
      await clock.advance(999);
      expect(at).toEqual([]);
      await clock.advance(1);
      await next;
      expect(at).toEqual([1_000]);
      expect(clock.pending()).toBe(0);
    });
  }
});
