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
    expect(text).toContain('"error":"Stream failed"');
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
    const PORT = 9881;

    async function* generate() {
      for (let i = 0; i < 5; i++) {
        yield { n: i };
      }
    }

    const server = Bun.serve({
      port: PORT,
      fetch() {
        return streamSSE(generate());
      },
    });

    const response = await fetch(`http://localhost:${PORT}`);
    expect(response.headers.get('content-type')).toBe('text/event-stream');

    const chunks: Array<{ n: number }> = [];
    for await (const chunk of parseSSE<{ n: number }>(response)) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([{ n: 0 }, { n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);

    server.stop();
  });
});
