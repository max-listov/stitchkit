import { describe, expect, test } from 'bun:test';
import {
  createTelegramOperatorChannel,
  createTelegramOperatorDedupe,
  type TelegramOperatorDrop,
  telegramOperatorSender,
} from '../src/entrypoints/telegram';

/*
 * The operator chat is read by a person: one failure repeated a hundred times,
 * or a storm of a hundred different ones, is a line with a count — never a
 * hundred messages, and never a silence that hides how many there were.
 */

/** A fetch stand-in; Bun's `typeof fetch` also carries `preconnect`. */
function asFetch(
  handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return Object.assign(handler, { preconnect: (): void => undefined });
}

const noSleep = (_milliseconds: number, signal: AbortSignal) =>
  signal.aborted ? Promise.reject(signal.reason) : Promise.resolve();

function channel(
  dedupe: { windowMs?: number; maxPerWindow?: number },
  clock: { now: number },
) {
  const sent: string[] = [];
  const drops: TelegramOperatorDrop<'errors'>[] = [];
  const operator = createTelegramOperatorChannel<'errors'>({
    chatId: -1,
    send: async (message) => void sent.push(message.text),
    minIntervalMs: 0,
    sleep: noSleep,
    onDropped: (drop) => drops.push(drop),
    dedupe: { ...dedupe, now: () => clock.now },
  });
  return { operator, sent, drops };
}

describe('operator channel dedupe', () => {
  test('one failure is sent once per window; the next one says how many were held back', async () => {
    const clock = { now: 0 };
    const { operator, sent, drops } = channel({ windowMs: 1_000 }, clock);
    operator.post('Payment pay_1 expired after 30s', 'errors');
    operator.post('Payment pay_2 expired after 31s', 'errors');
    operator.post('Payment pay_3 expired after 32s', 'errors');
    operator.post('Payment pay_3 expired after 32s');
    await operator.drain();
    // Another topic is another message, even with the same text.
    expect(sent).toEqual([
      'Payment pay_1 expired after 30s',
      'Payment pay_3 expired after 32s',
    ]);
    expect(drops.map((drop) => drop.reason)).toEqual(['repeated', 'repeated']);
    clock.now = 1_000;
    operator.post('Payment pay_4 expired after 33s', 'errors');
    await operator.drain();
    expect(sent.at(-1)).toBe('Payment pay_4 expired after 33s\n\n(+2 more like this)');
  });

  test('a storm of different messages spends the budget; the overflow rides on the next one sent', async () => {
    const clock = { now: 0 };
    const { operator, sent, drops } = channel({ windowMs: 1_000, maxPerWindow: 2 }, clock);
    for (const source of ['db', 'queue', 'cache', 'mail', 'search']) {
      operator.post(`${source} is down`);
    }
    await operator.drain();
    expect(sent).toEqual(['db is down', 'queue is down']);
    expect(drops.filter((drop) => drop.reason === 'over-budget')).toHaveLength(3);
    clock.now = 1_000;
    operator.post('recovered');
    await operator.drain();
    expect(sent.at(-1)).toBe('recovered\n\n(+3 more messages over the limit)');
  });

  test('the lines and the fingerprint are the application to word', async () => {
    const clock = { now: 0 };
    const sent: string[] = [];
    const operator = createTelegramOperatorChannel({
      chatId: -1,
      send: async (message) => void sent.push(message.text),
      minIntervalMs: 0,
      sleep: noSleep,
      dedupe: {
        now: () => clock.now,
        windowMs: 10,
        maxPerWindow: 1,
        fingerprint: (text) => text.split(':')[0] ?? text,
        repeatedLine: (count) => `Ещё таких: ${count}`,
        overBudgetLine: (count) => `Сверх лимита: ${count}`,
      },
    });
    operator.post('db: timeout');
    operator.post('db: refused');
    operator.post('net: reset');
    clock.now = 10;
    operator.post('db: timeout');
    await operator.drain();
    expect(sent).toEqual(['db: timeout', 'db: timeout\n\nЕщё таких: 1\n\nСверх лимита: 1']);
  });

  test('exact secret values are masked before anything else sees the text', async () => {
    const sent: string[] = [];
    const drops: TelegramOperatorDrop<string>[] = [];
    const operator = createTelegramOperatorChannel({
      chatId: -1,
      send: async (message) => void sent.push(message.text),
      minIntervalMs: 0,
      sleep: noSleep,
      sensitiveValues: ['provider-key-12345', 'provider-key-12345-extended'],
      onDropped: (drop) => drops.push(drop),
      dedupe: { now: () => 0 },
    });
    operator.post('failed with provider-key-12345-extended and provider-key-12345');
    operator.post('failed with provider-key-12345-extended and provider-key-12345');
    await operator.drain();
    expect(sent).toEqual(['failed with [redacted] and [redacted]']);
    expect(drops[0]?.text).toBe('failed with [redacted] and [redacted]');
  });

  test('a long text is cut to the limit, and the HTML sender leaves no tag the cut opened', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetch = asFetch(async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true, result: {} });
    });
    const html = telegramOperatorSender({ token: '1:x', parseMode: 'HTML', fetch });
    await html(
      { chatId: -1, text: `<b>${'x'.repeat(5_000)}</b>` },
      new AbortController().signal,
    );
    expect(bodies[0]?.text).toBe(`<b>${'x'.repeat(4_095)}</b>…`);
    // Through the channel: its character cut ends inside a tag, and the sender repairs it.
    const operator = createTelegramOperatorChannel({
      chatId: -1,
      send: html,
      minIntervalMs: 0,
      sleep: noSleep,
    });
    operator.post(`${'y'.repeat(4_094)}<b>bold</b>`);
    await operator.drain();
    expect(bodies[1]?.text).toBe(`${'y'.repeat(4_094)}&lt;…`);
    const received: string[] = [];
    const plain = createTelegramOperatorChannel({
      chatId: -1,
      send: async (message) => void received.push(message.text),
      minIntervalMs: 0,
      sleep: noSleep,
    });
    plain.post('z'.repeat(5_000));
    await plain.drain();
    expect(Array.from(received[0] ?? '')).toHaveLength(4_096);
  });
});

describe('the dedupe window on its own', () => {
  test('decides for a sender of its own: what goes, with its counts, and what is held and why', () => {
    let clock = 0;
    const admit = createTelegramOperatorDedupe<'errors'>({
      windowMs: 1_000,
      maxPerWindow: 2,
      now: () => clock,
    });
    expect(admit('db down 17', 'errors')).toEqual({ send: true, text: 'db down 17' });
    expect(admit('db down 18', 'errors')).toEqual({ send: false, reason: 'repeated' });
    expect(admit('disk full')).toEqual({ send: true, text: 'disk full' });
    expect(admit('queue stuck')).toEqual({ send: false, reason: 'over-budget' });
    clock = 1_000;
    expect(admit('db down 19', 'errors')).toEqual({
      send: true,
      text: 'db down 19\n\n(+1 more like this)\n\n(+1 more messages over the limit)',
    });
  });
});
