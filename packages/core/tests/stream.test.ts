import { describe, expect, test } from 'bun:test';
import { parseSSE, streamSSE } from '../src/server/stream';

describe('SSE streaming', () => {
  test('streamSSE creates valid SSE response from generator', async () => {
    async function* gen() {
      yield { text: 'hello' };
      yield { text: 'world' };
    }

    const response = streamSSE(gen());
    expect(response.headers.get('content-type')).toBe('text/event-stream');

    const text = await response.text();
    expect(text).toContain('data: {"text":"hello"}');
    expect(text).toContain('data: {"text":"world"}');
    expect(text).toContain('data: [DONE]');
  });

  test('streamSSE handles errors in generator', async () => {
    async function* gen() {
      yield { chunk: 1 };
      throw new Error('Stream failed');
    }

    const response = streamSSE(gen());
    const text = await response.text();
    expect(text).toContain('data: {"chunk":1}');
    // A generic error is normalised — the raw message never leaks into the stream.
    expect(text).toContain('INTERNAL_SERVER_ERROR');
    expect(text).not.toContain('Stream failed');
  });

  test('client cancellation closes the generator without emitting an error event', async () => {
    let released = false;
    let calls = 0;
    const generator: AsyncGenerator<unknown> = {
      next: async () => {
        calls += 1;
        if (calls === 1) return { done: false, value: { chunk: 1 } };
        return new Promise(() => undefined);
      },
      return: async () => {
        released = true;
        return { done: true, value: undefined };
      },
      throw: async (error?: unknown) => {
        throw error;
      },
      [Symbol.asyncIterator]() {
        return this;
      },
      [Symbol.asyncDispose]: async () => undefined,
    };

    const response = streamSSE(generator);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('SSE response must expose a body');
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('"chunk":1');
    await reader.cancel('consumer disconnected');

    expect(released).toBe(true);
  });

  test('parseSSE reads SSE stream back into objects', async () => {
    async function* gen() {
      yield { id: 1, text: 'first' };
      yield { id: 2, text: 'second' };
      yield { id: 3, text: 'third' };
    }

    const response = streamSSE(gen());
    const chunks: Array<{ id: number; text: string }> = [];

    for await (const chunk of parseSSE<{ id: number; text: string }>(response)) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { id: 1, text: 'first' },
      { id: 2, text: 'second' },
      { id: 3, text: 'third' },
    ]);
  });

  test('SSE round-trip through HTTP server', async () => {
    async function* generate() {
      for (let i = 0; i < 5; i++) {
        yield { n: i };
      }
    }

    const server = Bun.serve({
      port: 0,
      fetch() {
        return streamSSE(generate());
      },
    });

    const response = await fetch(`http://localhost:${server.port}`);
    expect(response.headers.get('content-type')).toBe('text/event-stream');

    const chunks: Array<{ n: number }> = [];
    for await (const chunk of parseSSE<{ n: number }>(response)) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([{ n: 0 }, { n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);

    server.stop();
  });
});

describe('cancelling an SSE stream does not wait on the generator', () => {
  test('cancel settles even when the generator is parked on a value that never comes', async () => {
    // An async generator serialises its requests: a `return()` issued while a
    // `next()` is in flight is queued behind it. `cancel` used to await that
    // return, so cancelling waited for the very value the departed consumer was
    // no longer there to receive — for a source that waits rather than produces,
    // forever.
    let closed = false;
    async function* parked(): AsyncGenerator<unknown> {
      try {
        yield 'first';
        await new Promise<never>(() => undefined);
      } finally {
        closed = true;
      }
    }
    const response = streamSSE(parked());
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    if (!reader) return;

    // Drain the first frame so the generator is inside the endless await.
    expect((await reader.read()).done).toBe(false);

    const settled = await Promise.race([
      reader.cancel().then(() => 'cancelled'),
      Bun.sleep(2_000).then(() => 'hung'),
    ]);
    expect(settled).toBe('cancelled');
    // And the ask still happened — it is simply not waited on. A generator
    // parked on a value nobody will send cannot run its own `finally`, which is
    // exactly why the cancel must not depend on it.
    expect(closed).toBe(false);
  }, 15_000);
});
