import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createClient } from '../src/browser/client';
import { ApiError } from '../src/browser/http';
import { parseNDJSON } from '../src/browser/stream';
import { defineContract } from '../src/contract';
import { createHandler, implement } from '../src/server';

const StreamItem = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('line'), text: z.string() }).strict(),
  z.object({ kind: z.literal('complete'), count: z.number().int() }).strict(),
]);

const contract = defineContract(
  { prefix: 'contract-stream' },
  {
    log: {
      method: 'GET',
      path: '/log/:id',
      desc: 'Read one finite validated log',
      params: z.object({ id: z.string() }).strict(),
      stream: {
        item: StreamItem,
        maxFrameBytes: 512,
        terminal: z.object({ kind: z.literal('complete') }).loose(),
      },
    },
    observe: {
      method: 'GET',
      path: '/observe',
      desc: 'Observe quiet progress until cancelled',
      stream: { item: z.object({ revision: z.number().int() }).strict(), format: 'sse' },
    },
    invalid: {
      method: 'GET',
      path: '/invalid',
      desc: 'Prove producer validation',
      stream: { item: z.object({ value: z.number() }).strict() },
    },
  },
);

function localClient(services: ReturnType<typeof implement<typeof contract.endpoints>>) {
  const handler = createHandler({ services: [services] });
  return createClient(contract, {
    baseUrl: 'http://local',
    fetch: (input, init) => handler(new Request(input, init)),
  });
}

describe('contract-first bounded streams', () => {
  test('the typed client yields validated NDJSON items and requires a terminal', async () => {
    const client = localClient(
      implement(contract, {
        log: async function* ({ params }) {
          yield { kind: 'line' as const, text: `start:${params.id}` };
          yield { kind: 'complete' as const, count: 1 };
        },
        observe: async function* () {
          yield { revision: 1 };
        },
        invalid: async function* () {
          yield { value: 1 };
        },
      }),
    );

    const values = [];
    for await (const item of await client.log({ id: 'a' })) values.push(item);
    expect(values).toEqual([
      { kind: 'line', text: 'start:a' },
      { kind: 'complete', count: 1 },
    ]);
  });

  test('post-header producer failures are typed and scrub internal messages', async () => {
    const client = localClient(
      implement(contract, {
        log: async function* () {
          yield { kind: 'complete' as const, count: 0 };
        },
        observe: async function* () {
          yield { revision: 1 };
        },
        // The runtime check covers JavaScript and contracts assembled past TypeScript.
        invalid: async function* () {
          yield { value: 'private-secret' } as never;
        },
      }),
    );

    const stream = await client.invalid();
    await expect(stream.next()).rejects.toMatchObject({ code: 'STREAM_ITEM_INVALID' });
    await expect(stream.next()).resolves.toEqual({ done: true, value: undefined });
  });

  test('client return aborts a quiet server source through the same operation signal', async () => {
    let markClosed: () => void = () => undefined;
    const closed = new Promise<void>((resolve) => {
      markClosed = resolve;
    });
    const client = localClient(
      implement(contract, {
        log: async function* () {
          yield { kind: 'complete' as const, count: 0 };
        },
        observe: async function* ({ signal }) {
          try {
            await new Promise<void>((resolve) => {
              if (signal.aborted) resolve();
              else signal.addEventListener('abort', () => resolve(), { once: true });
            });
          } finally {
            markClosed();
          }
        },
        invalid: async function* () {
          yield { value: 1 };
        },
      }),
    );

    const stream = await client.observe();
    await stream.return?.();
    await expect(
      Promise.race([closed.then(() => 'closed'), Bun.sleep(1_000).then(() => 'leaked')]),
    ).resolves.toBe('closed');
  });

  test('malformed, invalid UTF-8 and oversized unterminated lines fail closed', async () => {
    const malformed = new Response('{nope}\n');
    await expect(parseNDJSON(malformed).next()).rejects.toBeInstanceOf(SyntaxError);

    const invalidUtf8 = new Response(new Uint8Array([0xc3, 0x28, 0x0a]));
    await expect(parseNDJSON(invalidUtf8).next()).rejects.toBeInstanceOf(TypeError);

    const oversized = new Response('123456');
    await expect(parseNDJSON(oversized, { maxLineBytes: 5 }).next()).rejects.toBeInstanceOf(
      RangeError,
    );
  });

  test('a truncated wire and missing declared terminal are explicit client failures', async () => {
    const client = createClient(contract, {
      baseUrl: 'http://local',
      fetch: async () =>
        new Response('{"type":"data","data":{"kind":"line","text":"x"}}\n', {
          headers: { 'content-type': 'application/x-ndjson' },
        }),
    });
    const stream = await client.log({ id: 'a' });
    expect(await stream.next()).toEqual({
      done: false,
      value: { kind: 'line', text: 'x' },
    });
    await expect(stream.next()).rejects.toMatchObject({
      code: 'STREAM_TRUNCATED',
    });
  });

  test('one oversized producer frame becomes a bounded safe stream error', async () => {
    const client = localClient(
      implement(contract, {
        log: async function* () {
          yield { kind: 'line' as const, text: 'x'.repeat(1_000) };
          yield { kind: 'complete' as const, count: 1 };
        },
        observe: async function* () {
          yield { revision: 1 };
        },
        invalid: async function* () {
          yield { value: 1 };
        },
      }),
    );
    const stream = await client.log({ id: 'a' });
    try {
      await stream.next();
      throw new Error('expected stream failure');
    } catch (error) {
      expect(ApiError.is(error)).toBe(true);
      expect(error).toMatchObject({ code: 'STREAM_FRAME_TOO_LARGE' });
      expect(String(error)).not.toContain('1000');
    }
  });
});

function compileTimeOnly(): void {
  const client = createClient(contract, { baseUrl: 'http://local' });
  const stream: Promise<AsyncIterableIterator<z.output<typeof StreamItem>>> = client.log({
    id: 'x',
  });
  void stream;

  implement(contract, {
    // @ts-expect-error the item schema makes a string count impossible.
    log: async function* () {
      yield { kind: 'complete' as const, count: 'wrong' };
    },
    observe: async function* () {
      yield { revision: 1 };
    },
    invalid: async function* () {
      yield { value: 1 };
    },
  });
}
void compileTimeOnly;
