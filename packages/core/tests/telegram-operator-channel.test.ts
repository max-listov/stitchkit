import { describe, expect, test } from 'bun:test';
import { callTelegramBotApi, TelegramBotApiError } from '../src/telegram/bot-api';
import {
  createTelegramOperatorChannel,
  type TelegramOperatorDrop,
  type TelegramOperatorMessage,
  telegramOperatorSender,
} from '../src/telegram/operator-channel';
import { classifyTelegramSendFailure } from '../src/telegram/send-failure';

/*
 * The operator chat must never slow the bot down and never take the journal's
 * place: `post` returns at once, a 429 waits the time Telegram named, and what
 * cannot arrive is reported with why.
 */

const noSleep = (_milliseconds: number, signal: AbortSignal) =>
  signal.aborted ? Promise.reject(signal.reason) : Promise.resolve();

function refusal(error_code: number, description: string, retry_after?: number) {
  return new TelegramBotApiError('sendMessage', {
    error_code,
    description,
    ...(retry_after !== undefined && { parameters: { retry_after } }),
  });
}

describe('createTelegramOperatorChannel', () => {
  test('posts to the topic thread, in order, paced by minIntervalMs', async () => {
    const sent: TelegramOperatorMessage[] = [];
    const waits: number[] = [];
    const channel = createTelegramOperatorChannel<'payments' | 'errors'>({
      chatId: -100,
      topics: { payments: 12, errors: 34 },
      send: async (message) => void sent.push(message),
      minIntervalMs: 1_500,
      sleep: (milliseconds, signal) => {
        waits.push(milliseconds);
        return noSleep(milliseconds, signal);
      },
    });
    channel.post('paid 10', 'payments');
    channel.post('crash', 'errors');
    channel.post('hello');
    await channel.drain();
    expect(sent).toEqual([
      { chatId: -100, threadId: 12, text: 'paid 10' },
      { chatId: -100, threadId: 34, text: 'crash' },
      { chatId: -100, text: 'hello' },
    ]);
    expect(waits).toEqual([1_500, 1_500]);
  });

  test('a 429 waits the retry_after Telegram named and sends the same message again', async () => {
    const waits: number[] = [];
    let calls = 0;
    const channel = createTelegramOperatorChannel({
      chatId: 1,
      minIntervalMs: 10,
      send: async () => {
        calls += 1;
        if (calls === 1) throw refusal(429, 'Too Many Requests: retry after 7', 7);
      },
      sleep: (milliseconds, signal) => {
        waits.push(milliseconds);
        return noSleep(milliseconds, signal);
      },
    });
    channel.post('once');
    await channel.drain();
    expect(calls).toBe(2);
    expect(waits).toEqual([7_000]);
  });

  test('a refusal repeating will not fix is dropped with its classification; overflow drops the oldest', async () => {
    const drops: TelegramOperatorDrop<never>[] = [];
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const channel = createTelegramOperatorChannel({
      chatId: 1,
      maxQueued: 2,
      sleep: noSleep,
      onDropped: (drop) => void drops.push(drop),
      send: async () => {
        if (first) {
          first = false;
          await blocked;
          throw refusal(400, "Bad Request: can't parse entities");
        }
      },
    });
    channel.post('a');
    channel.post('b');
    channel.post('c');
    channel.post('d');
    expect(channel.pending).toBe(3);
    release();
    await channel.drain();
    expect(drops.map((drop) => `${drop.text}:${drop.reason}`)).toEqual([
      'b:overflow',
      'a:refused',
    ]);
    expect(drops[1]?.failure?.reason).toBe('message-invalid');
  });

  test('post never throws, even when the observer and the sender do', async () => {
    const channel = createTelegramOperatorChannel({
      chatId: 1,
      sleep: noSleep,
      maxAttempts: 2,
      onDropped: () => {
        throw new Error('observer broke');
      },
      send: () => {
        throw refusal(502, 'Bad Gateway');
      },
    });
    expect(() => channel.post('x')).not.toThrow();
    await channel.drain();
    expect(channel.pending).toBe(0);
  });

  test('close abandons the message in flight and drops the queue as closed', async () => {
    const drops: string[] = [];
    const channel = createTelegramOperatorChannel({
      chatId: 1,
      sleep: noSleep,
      onDropped: (drop) => void drops.push(`${drop.text}:${drop.reason}`),
      send: (_message, signal) =>
        new Promise((_, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason)),
        ),
    });
    channel.post('in flight');
    channel.post('queued');
    await Bun.sleep(1);
    channel.close();
    await channel.drain();
    channel.post('late');
    expect(drops).toEqual(['queued:closed', 'in flight:closed', 'late:closed']);
  });
});

describe('callTelegramBotApi', () => {
  test('a refusal keeps Telegram answer as fields the classifier reads, and no token in the message', async () => {
    const token = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
    const requests: string[] = [];
    const fetcher: typeof fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        requests.push(String(input));
        return Response.json(
          {
            ok: false,
            error_code: 429,
            description: 'Too Many Requests',
            parameters: { retry_after: 3 },
          },
          { status: 429 },
        );
      },
      { preconnect: fetch.preconnect },
    );
    const failure = await telegramOperatorSender({ token, fetch: fetcher })(
      { chatId: 5, threadId: 9, text: 'x' },
      new AbortController().signal,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TelegramBotApiError);
    expect(String(failure)).not.toContain(token);
    expect(classifyTelegramSendFailure(failure)).toMatchObject({
      reason: 'rate-limited',
      retryAfterSeconds: 3,
      evidence: 'parameters',
    });
    expect(requests).toEqual([`https://api.telegram.org/bot${token}/sendMessage`]);
  });

  test('a transport failure names the method, never the URL', async () => {
    const token = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
    const fetcher: typeof fetch = Object.assign(
      async () => {
        throw new TypeError(`fetch failed for https://api.telegram.org/bot${token}/getMe`);
      },
      { preconnect: fetch.preconnect },
    );
    const failure = await callTelegramBotApi({ token, method: 'getMe', fetch: fetcher }).catch(
      (error: unknown) => error,
    );
    expect(String(failure)).toContain('getMe');
    expect(String(failure)).not.toContain(token);
  });
});
