import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelegramBotApiError } from '../src/telegram/bot-api';
import {
  runTelegramBroadcast,
  type TelegramBroadcastConfig,
  type TelegramBroadcastReport,
  telegramBroadcastSender,
} from '../src/telegram/broadcast';

/*
 * The questions a broadcast answers badly by hand: after a crash, does anyone
 * get it twice; after a 429, does it wait what Telegram said; does a blocked
 * user stay blocked; and when the message itself is wrong, who is blamed.
 */

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function stateRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'stitchkit-broadcast-'));
  directories.push(path);
  return path;
}

const refusal = (error_code: number, description: string, retry_after?: number) =>
  new TelegramBotApiError('copyMessage', {
    error_code,
    description,
    ...(retry_after !== undefined && { parameters: { retry_after } }),
  });

function harness(
  directory: string,
  refuse: (recipient: number, attempt: number) => unknown = () => undefined,
) {
  const sent: number[] = [];
  const sleeps: number[] = [];
  let clock = 0;
  const config = (
    overrides: Partial<TelegramBroadcastConfig> = {},
  ): TelegramBroadcastConfig => ({
    name: 'price-lock',
    directory,
    recipients: () => [1, 2, 3, 2, 4],
    send: async ({ recipient, attempt }) => {
      const recipientId = Number(recipient);
      const error = refuse(recipientId, attempt);
      if (error) throw error;
      sent.push(recipientId);
    },
    now: () => clock,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      clock += milliseconds;
    },
    ...overrides,
  });
  return { sent, sleeps, config };
}

describe('runTelegramBroadcast', () => {
  test('a resumed broadcast never writes again to anyone already delivered', async () => {
    const directory = await stateRoot();
    const stop = new AbortController();
    const { sent, config } = harness(directory);
    const first = await runTelegramBroadcast(
      config({
        send: async ({ recipient }) => {
          sent.push(Number(recipient));
          if (sent.length === 2) stop.abort();
        },
        signal: stop.signal,
      }),
    );
    expect(first).toMatchObject({ outcome: 'stopped', total: 4, delivered: 2, pending: 2 });

    // The audience grew since; a resumed broadcast keeps the one it started with.
    const second = await runTelegramBroadcast(
      config({ recipients: () => [1, 2, 3, 4, 5, 6] }),
    );
    expect(second).toMatchObject({ outcome: 'finished', total: 4, delivered: 4, pending: 0 });
    expect(sent).toEqual([1, 2, 3, 4]);
    expect(await readdir(directory)).not.toContain('price-lock.lock');
  });

  test('a send in flight when the process died is uncertain and not repeated', async () => {
    const directory = await stateRoot();
    await writeFile(join(directory, 'price-lock.recipients.json'), JSON.stringify([1, 2, 3]));
    await writeFile(
      join(directory, 'price-lock.journal.ndjson'),
      '{"i":0,"s":"sending"}\n{"i":0,"o":"delivered"}\n{"i":1,"s":"sending"}\n{"i":2,"s":"sen',
    );
    const { sent, config } = harness(directory);
    const result = await runTelegramBroadcast(config());
    expect(sent).toEqual([3]);
    expect(result).toMatchObject({
      delivered: 2,
      uncertain: 1,
      pending: 0,
      outcome: 'finished',
    });
  });

  test('a 429 waits the retry_after Telegram named and sends the same recipient again', async () => {
    const directory = await stateRoot();
    const { sent, sleeps, config } = harness(directory, (recipient, attempt) =>
      recipient === 2 && attempt === 1
        ? refusal(429, 'Too Many Requests: retry after 9', 9)
        : undefined,
    );
    const result = await runTelegramBroadcast(config({ ratePerSecond: 1_000 }));
    expect(result).toMatchObject({ delivered: 4, outcome: 'finished' });
    expect(sent).toEqual([1, 2, 3, 4]);
    expect(sleeps).toContain(9_000);
  });

  test('a blocked recipient is unreachable and is not addressed again on resume', async () => {
    const directory = await stateRoot();
    let attempts = 0;
    const { sent, config } = harness(directory, (recipient) => {
      if (recipient !== 3) return undefined;
      attempts += 1;
      return refusal(403, 'Forbidden: bot was blocked by the user');
    });
    const result = await runTelegramBroadcast(config());
    expect(result).toMatchObject({
      delivered: 3,
      unreachable: 1,
      failed: 0,
      outcome: 'finished',
    });
    await runTelegramBroadcast(config());
    expect(attempts).toBe(1);
    expect(sent).toEqual([1, 2, 4]);
    const journal = await readFile(join(directory, 'price-lock.journal.ndjson'), 'utf8');
    expect(journal).toContain('"o":"unreachable","r":"blocked-by-user"');
  });

  test('a defect in the message halts the run and is not counted against the recipient', async () => {
    const directory = await stateRoot();
    let broken = true;
    const { sent, config } = harness(directory, (recipient) =>
      broken && recipient === 2
        ? refusal(400, "Bad Request: can't parse entities")
        : undefined,
    );
    const halted = await runTelegramBroadcast(config());
    expect(halted).toMatchObject({ outcome: 'halted', delivered: 1, failed: 0, pending: 3 });
    expect(halted.halt?.reason).toBe('message-invalid');

    broken = false;
    const fixed = await runTelegramBroadcast(config());
    expect(fixed).toMatchObject({ outcome: 'finished', delivered: 4, failed: 0 });
    expect(sent).toEqual([1, 2, 3, 4]);
  });

  test('Telegram unreachable halts after the attempts and leaves the recipient pending', async () => {
    const directory = await stateRoot();
    const { sent, config } = harness(directory, (recipient) =>
      recipient === 2 ? new TypeError('fetch failed') : undefined,
    );
    const result = await runTelegramBroadcast(config({ maxAttempts: 3 }));
    expect(result).toMatchObject({ outcome: 'halted', delivered: 1, pending: 3, failed: 0 });
    expect(sent).toEqual([1]);
  });

  test('a server error retried past maxAttempts is failed, and the broadcast goes on', async () => {
    const directory = await stateRoot();
    const { sent, config } = harness(directory, (recipient) =>
      recipient === 2 ? refusal(502, 'Bad Gateway') : undefined,
    );
    const result = await runTelegramBroadcast(config({ maxAttempts: 2 }));
    expect(result).toMatchObject({ outcome: 'finished', delivered: 3, failed: 1 });
    expect(sent).toEqual([1, 3, 4]);
  });

  test('dry-run counts without sending or writing; sends are paced at ratePerSecond', async () => {
    const directory = await stateRoot();
    const { sent, sleeps, config } = harness(directory);
    const dry = await runTelegramBroadcast(config({ dryRun: true }));
    expect(dry).toMatchObject({ outcome: 'dry-run', total: 4, pending: 4 });
    expect(await readdir(directory)).toEqual([]);
    expect(sent).toEqual([]);

    const progress: TelegramBroadcastReport[] = [];
    await runTelegramBroadcast(
      config({ ratePerSecond: 20, onProgress: (report) => void progress.push(report) }),
    );
    expect(sleeps).toEqual([50, 50, 50]);
    expect(progress.map((report) => report.outcome)).toEqual(['running', 'finished']);
  });

  test('progressEveryMs sets how often progress is reported while sending', async () => {
    const directory = await stateRoot();
    const { config } = harness(directory);
    const progress: string[] = [];
    await runTelegramBroadcast(
      config({
        progressEveryMs: 0,
        onProgress: (report) => void progress.push(`${report.outcome}:${report.delivered}`),
      }),
    );
    expect(progress).toEqual([
      'running:0',
      'running:1',
      'running:2',
      'running:3',
      'running:4',
      'finished:4',
    ]);
  });

  test('one runner per name: a second concurrent run is refused', async () => {
    const directory = await stateRoot();
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { config } = harness(directory);
    const running = runTelegramBroadcast(config({ send: () => blocked }));
    await Bun.sleep(20);
    await expect(runTelegramBroadcast(config())).rejects.toThrow('already running');
    release();
    expect((await running).outcome).toBe('finished');
  });

  test('the standard sender copies a prepared message to each recipient', async () => {
    const bodies: unknown[] = [];
    const fetcher: typeof fetch = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json({ ok: true, result: { message_id: 1 } });
      },
      { preconnect: fetch.preconnect },
    );
    const send = telegramBroadcastSender({
      token: '1:test',
      message: { copyFrom: { chatId: -100, messageId: 77 } },
      fetch: fetcher,
    });
    await send({ recipient: 5, attempt: 1 });
    expect(bodies).toEqual([{ chat_id: 5, from_chat_id: -100, message_id: 77 }]);
  });
});
