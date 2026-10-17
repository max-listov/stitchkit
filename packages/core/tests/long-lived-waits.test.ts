import { describe, expect, test } from 'bun:test';
import { Bot } from 'grammy';
import { z } from 'zod';
import { updateAdmissionGate } from '../src/application/grammy-update-admission';
import { defineContract } from '../src/entrypoints/contract';
import { createHandler, implement } from '../src/entrypoints/server';
import { SpeechQueue } from '../src/entrypoints/voice';
import { createMcpHandler } from '../src/tools/mcp/handler';

/*
 * A wait that outlives one step must not leave anything behind per step. A promise or signal
 * that lives as long as a stream, a queue or a handler keeps a reaction for every `race`
 * against it, and through the race result keeps what the step produced. Each test runs a
 * small and a large number of steps and requires that what is retained does not follow it.
 */

function alive(refs: readonly WeakRef<object>[]): number {
  Bun.gc(true);
  return refs.filter((ref) => ref.deref() !== undefined).length;
}

const BOUND = 50;

const streamContract = defineContract(
  { prefix: 'wait' },
  {
    tail: {
      method: 'GET',
      path: '/tail',
      desc: 'An open stream',
      stream: { item: z.object({ n: z.number() }), lifetimeMs: 30, format: 'sse' },
    },
    open: {
      method: 'GET',
      path: '/open',
      desc: 'An open stream without a lifetime',
      stream: { item: z.object({ n: z.number() }) },
    },
  },
);

async function* idle(): AsyncGenerator<{ n: number }> {
  yield* [];
}

async function holdOpenStream(frames: number): Promise<{ read: number; retained: number }> {
  const items: WeakRef<object>[] = [];
  const handler = createHandler({
    services: [
      implement(streamContract, {
        open: async function* ({ signal }) {
          for (let n = 0; n < frames; n++) {
            const item = { n };
            items.push(new WeakRef(item));
            yield item;
          }
          await new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true }),
          );
        },
        tail: idle,
      }),
    ],
  });
  const response = await handler(new Request('http://local/wait/open'));
  const reader = response.body?.getReader();
  if (!reader) throw new Error('stream has no body');
  const decoder = new TextDecoder();
  let read = 0;
  while (read < frames) {
    const chunk = await reader.read();
    if (chunk.done) break;
    read += decoder.decode(chunk.value).match(/"n":/g)?.length ?? 0;
  }
  const retained = alive(items);
  await reader.cancel();
  return { read, retained };
}

describe('an open contract stream', () => {
  test('retains no delivered item however many frames it has sent', async () => {
    const small = await holdOpenStream(200);
    const large = await holdOpenStream(1000);
    expect(large.read).toBe(1000);
    expect(large.retained).toBeLessThan(BOUND);
    expect(large.retained).toBeLessThanOrEqual(small.retained + 20);
  });

  test('ends at its lifetime even when the source never has to wait', async () => {
    const handler = createHandler({
      services: [
        implement(streamContract, {
          open: idle,
          tail: () => ({
            [Symbol.asyncIterator]: () => ({
              next: () => Promise.resolve({ done: false as const, value: { n: 1 } }),
            }),
          }),
        }),
      ],
    });
    const response = await handler(new Request('http://local/wait/tail'));
    const reader = response.body?.getReader();
    if (!reader) throw new Error('stream has no body');
    const decoder = new TextDecoder();
    let text = '';
    const deadline = Date.now() + 2000;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value);
      if (Date.now() > deadline) break;
    }
    expect(text).toContain('STREAM_LIFETIME_EXCEEDED');
  });
});

async function speakSentences(count: number): Promise<number> {
  const clips: WeakRef<object>[] = [];
  const queue = new SpeechQueue<object>({
    prepare: async () => {
      const clip = {};
      clips.push(new WeakRef(clip));
      return clip;
    },
    play: async () => undefined,
  });
  for (let n = 0; n < count; n++) {
    queue.push(`Sentence number ${n}.`);
    if (n % 20 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  queue.close();
  await queue.done;
  const retained = alive(clips);
  expect(queue.isCancelled).toBe(false);
  return retained;
}

describe('a speech queue', () => {
  test('retains no spoken clip however many sentences it has said', async () => {
    const small = await speakSentences(100);
    const large = await speakSentences(500);
    expect(large).toBeLessThan(BOUND);
    expect(large).toBeLessThanOrEqual(small + 20);
  });

  test('still stops the sentence in flight when it is cancelled', async () => {
    let played = 0;
    const queue = new SpeechQueue<string>({
      prepare: async (text) => text,
      play: (_clip, signal) =>
        new Promise<void>((resolve) => {
          played += 1;
          signal.addEventListener('abort', () => resolve(), { once: true });
        }),
    });
    queue.push('One.');
    queue.push('Two.');
    await new Promise((resolve) => setTimeout(resolve, 10));
    queue.cancel();
    await queue.done;
    expect(played).toBe(1);
    expect(queue.isCancelled).toBe(true);
  });
});

describe('an MCP handler', () => {
  test('retains no authenticated principal of a request it has answered', async () => {
    const principals: WeakRef<object>[] = [];
    const handler = createMcpHandler({
      serverInfo: { name: 'test', version: '1' },
      auth: () => {
        const principal = { owner: 'alpha' };
        principals.push(new WeakRef(principal));
        return principal;
      },
      context: (auth) => auth,
      services: [],
    });
    const ask = async (count: number): Promise<number> => {
      for (let n = 0; n < count; n++) {
        const response = await handler.fetch(
          new Request('http://localhost/mcp', {
            method: 'POST',
            headers: {
              accept: 'application/json, text/event-stream',
              'content-type': 'application/json',
              host: 'localhost',
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: n, method: 'tools/list', params: {} }),
          }),
        );
        await response.text();
      }
      return alive(principals);
    };
    const small = await ask(50);
    const large = await ask(300);
    expect(principals.length).toBeGreaterThanOrEqual(350);
    expect(large).toBeLessThan(BOUND);
    expect(large).toBeLessThanOrEqual(small + 20);
    await handler.close();
  });

  test('answers a request that arrives while it closes with 503', async () => {
    let release: () => void = () => undefined;
    const handler = createMcpHandler({
      serverInfo: { name: 'test', version: '1' },
      auth: () =>
        new Promise<{ owner: string }>((resolve) => (release = () => resolve({ owner: 'a' }))),
      context: (auth) => auth,
      services: [],
    });
    const pending = handler.fetch(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          host: 'localhost',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    await handler.close();
    expect((await pending).status).toBe(503);
    release();
  });
});

describe('the grammY update gate', () => {
  test('follows one polling signal once however many polls it sees', async () => {
    const bot = new Bot('1:fixture', {
      botInfo: {
        id: 1,
        is_bot: true,
        first_name: 'F',
        username: 'f_bot',
        can_join_groups: true,
        can_read_all_group_messages: false,
        supports_inline_queries: false,
        can_connect_to_business: false,
        has_main_web_app: false,
        has_topics_enabled: false,
        allows_users_to_create_topics: false,
        can_manage_bots: false,
        supports_join_request_queries: false,
      },
    });
    // A Bot API that answers every call with an empty batch; the transformer type is generic.
    bot.api.config.use((async () => ({ ok: true, result: [] })) as never);
    const gate = updateAdmissionGate(bot);
    gate.bind({
      acquire: () => undefined,
      acquireWhenAccepting: async () => ({ release: () => undefined }),
    } as never);
    const controller = new AbortController();
    let listeners = 0;
    const add = controller.signal.addEventListener.bind(controller.signal);
    controller.signal.addEventListener = ((type: string, listener: never, options?: never) => {
      if (type === 'abort') listeners += 1;
      add(type, listener, options);
    }) as typeof controller.signal.addEventListener;
    for (let poll = 0; poll < 200; poll++) {
      await bot.api.raw.getUpdates({ timeout: 0 }, controller.signal as never);
    }
    expect(listeners).toBe(1);
  });
});
