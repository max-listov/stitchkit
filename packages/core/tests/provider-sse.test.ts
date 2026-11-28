import { describe, expect, test } from 'bun:test';
import {
  AgentProviderError,
  AgentProviderStreamCutError,
} from '../src/agent-runtime/provider-failure';
import {
  headersToRecord,
  joinProviderUrl,
  postProviderStream,
} from '../src/agent-runtime/provider-http';
import {
  parseSseJson,
  parseSseStream,
  type SseFrame,
} from '../src/agent-runtime/provider-sse';

function streamFromChunks(
  chunks: readonly (string | Uint8Array)[],
  onCancel?: () => void,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      const next = chunks[index];
      index += 1;
      if (next !== undefined) {
        controller.enqueue(typeof next === 'string' ? encoder.encode(next) : next);
      }
    },
    cancel() {
      onCancel?.();
    },
  });
}

async function collectFrames(stream: AsyncIterable<SseFrame>): Promise<SseFrame[]> {
  const frames: SseFrame[] = [];
  for await (const frame of stream) frames.push(frame);
  return frames;
}

describe('provider-sse: WHATWG framing, split UTF-8/CRLF, O(N) linearity, and bounds', () => {
  test('parses 2 MiB single SSE line across tiny chunks in linear O(N) time', async () => {
    const payloadSize = 2 * 1024 * 1024;
    const payload = 'a'.repeat(payloadSize);
    const full = `data: ${payload}\n\n`;
    const chunkSize = 256;
    const chunks: Uint8Array[] = [];
    const encoder = new TextEncoder();
    for (let offset = 0; offset < full.length; offset += chunkSize) {
      chunks.push(encoder.encode(full.slice(offset, offset + chunkSize)));
    }

    const startedAt = performance.now();
    const frames = await collectFrames(
      parseSseStream(streamFromChunks(chunks), { provider: 'perf-test' }),
    );
    const elapsedMs = performance.now() - startedAt;

    expect(frames).toHaveLength(1);
    expect(frames[0]?.kind === 'event' && frames[0].data.length).toBe(payloadSize);
    expect(elapsedMs).toBeLessThan(2000);
  });

  test('handles split 4-byte UTF-8 characters and \\r -> empty decoded chunk -> \\n without splitting a frame', async () => {
    // 4-byte UTF-8 rocket U+1F680 = F0 9F 9A 80
    const rocket = new TextEncoder().encode('🚀');
    expect(rocket.byteLength).toBe(4);

    // Case 1: 4-byte UTF-8 split 1 byte per chunk inside data payload
    const splitEmojiStream = streamFromChunks([
      new TextEncoder().encode('data: hi '),
      rocket.subarray(0, 1),
      rocket.subarray(1, 2),
      rocket.subarray(2, 3),
      rocket.subarray(3, 4),
      new TextEncoder().encode('\n\n'),
    ]);
    const emojiFrames = await collectFrames(
      parseSseStream(splitEmojiStream, { provider: 'utf8-test' }),
    );
    expect(emojiFrames).toEqual([{ kind: 'event', data: 'hi 🚀' }]);

    // Case 2: \r followed by a 0-byte chunk (decoding to "") followed by \n must NOT flush early
    const splitCrEmptyLf = streamFromChunks([
      new TextEncoder().encode('event: delta\r'),
      new Uint8Array(0),
      new TextEncoder().encode('\ndata: line1\r'),
      new Uint8Array(0),
      new TextEncoder().encode('\ndata: line2\r\n\r\n'),
    ]);
    const crLfFrames = await collectFrames(
      parseSseStream(splitCrEmptyLf, { provider: 'crlf-test' }),
    );
    expect(crLfFrames).toEqual([{ kind: 'event', event: 'delta', data: 'line1\nline2' }]);

    // Case 3: \r followed by first byte of 4-byte UTF-8 (decodes to "") then remaining bytes
    const crThenSplitUtf8 = streamFromChunks([
      new TextEncoder().encode('data: a\r'),
      rocket.subarray(0, 1),
      new Uint8Array([...rocket.subarray(1), ...new TextEncoder().encode('\n\n')]),
    ]);
    const mixedFrames = await collectFrames(
      parseSseStream(crThenSplitUtf8, { provider: 'mixed-test' }),
    );
    // Line 1 is "data: a", line 2 is "🚀" (no colon -> ignored field), blank line flushes event "a"
    expect(mixedFrames).toEqual([{ kind: 'event', data: 'a' }]);
  });

  test('flushes trailing unterminated EOF line without \\n and classifies pings, ids, and spaces', async () => {
    const eofFrames = await collectFrames(
      parseSseStream(
        streamFromChunks([
          ': keepalive\n',
          'data: null\n\n',
          'data: : proxy-ping\n\n',
          'id: evt-1\nevent: msg\ndata:  leading-space\n\n',
          'id: bad\0id\ndata: trailing-no-newline',
        ]),
        { provider: 'eof-test' },
      ),
    );
    expect(eofFrames).toEqual([
      { kind: 'ping' },
      { kind: 'ping' },
      { kind: 'ping' },
      { kind: 'event', id: 'evt-1', event: 'msg', data: ' leading-space' },
      { kind: 'event', data: 'trailing-no-newline' },
    ]);
  });

  test('cancels reader on early break, abort signal, and maxEventBytes overflow', async () => {
    let cancelledOnBreak = false;
    const breakStream = streamFromChunks(
      ['data: one\n\n', 'data: two\n\n', 'data: three\n\n'],
      () => {
        cancelledOnBreak = true;
      },
    );
    for await (const frame of parseSseStream(breakStream, { provider: 'break-test' })) {
      if (frame.kind === 'event' && frame.data === 'one') break;
    }
    expect(cancelledOnBreak).toBe(true);

    let cancelledOnAbort = false;
    const stallingStream = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise(() => {
          /* never resolves until cancelled */
        });
      },
      cancel() {
        cancelledOnAbort = true;
      },
    });
    const controller = new AbortController();
    const iter = parseSseStream(stallingStream, {
      provider: 'abort-test',
      signal: controller.signal,
    });
    const pending = iter.next();
    controller.abort(new Error('stop now'));
    await expect(pending).rejects.toThrow('stop now');
    expect(cancelledOnAbort).toBe(true);

    let cancelledOnLimit = false;
    const hugeLine = streamFromChunks(['data: ', 'x'.repeat(200), '\n\n'], () => {
      cancelledOnLimit = true;
    });
    await expect(
      collectFrames(parseSseStream(hugeLine, { provider: 'limit-test', maxEventBytes: 64 })),
    ).rejects.toBeInstanceOf(AgentProviderError);
    expect(cancelledOnLimit).toBe(true);
  });

  test('aborts promptly without hanging when reader.cancel() ignores cancellation and enforces UTF-8 byte cap accurately', async () => {
    // 1. Mid-read abort on a stream whose pull() and cancel() both never settle
    let cancelCalled = false;
    const uncooperative = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise(() => {
          /* stalls forever */
        });
      },
      cancel() {
        cancelCalled = true;
        return new Promise(() => {
          /* never settles */
        });
      },
    });
    const controller = new AbortController();
    const iter = parseSseStream(uncooperative, {
      provider: 'hang-test',
      signal: controller.signal,
    });
    const pending = iter.next();
    controller.abort(new Error('uncooperative abort'));
    await expect(pending).rejects.toThrow('uncooperative abort');
    expect(cancelCalled).toBe(true);

    // 2. Pre-aborted signal with never-settling cancel() still cancels and throws immediately
    let preCancelCalled = false;
    const preUncooperative = new ReadableStream<Uint8Array>({
      cancel() {
        preCancelCalled = true;
        return new Promise(() => {
          /* never settles */
        });
      },
    });
    const preAborted = new AbortController();
    preAborted.abort(new Error('already aborted'));
    await expect(
      collectFrames(
        parseSseStream(preUncooperative, { provider: 'pre-abort', signal: preAborted.signal }),
      ),
    ).rejects.toThrow('already aborted');
    expect(preCancelCalled).toBe(true);

    // 3. UTF-8 byte cap: 16 rockets = 64 UTF-8 bytes passes at 64 (line is "data: " + 64 = 70 -> allow 70);
    //    20 rockets = 40 UTF-16 code units = 80 UTF-8 bytes MUST fail at maxEventBytes: 64
    const twentyRockets = '🚀'.repeat(20);
    expect(twentyRockets.length).toBe(40);
    expect(new TextEncoder().encode(twentyRockets).byteLength).toBe(80);
    await expect(
      collectFrames(
        parseSseStream(streamFromChunks([`data: ${twentyRockets}\n\n`]), {
          provider: 'utf8-cap',
          maxEventBytes: 64,
        }),
      ),
    ).rejects.toBeInstanceOf(AgentProviderError);

    const exactRockets = '🚀'.repeat(14); // 56 UTF-8 bytes; line "data: " (6) + 56 = 62 <= 64
    const exactFrames = await collectFrames(
      parseSseStream(streamFromChunks([`data: ${exactRockets}\n\n`]), {
        provider: 'utf8-cap-ok',
        maxEventBytes: 64,
      }),
    );
    expect(exactFrames).toEqual([{ kind: 'event', data: exactRockets }]);
  });

  test('parseSseJson wraps truncated JSON in AgentProviderStreamCutError inheriting AgentProviderError', () => {
    expect(parseSseJson('openai', '{"ok":true}')).toEqual({ ok: true });
    let caught: unknown;
    try {
      parseSseJson('openai', '{"incomplete":');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AgentProviderStreamCutError);
    expect(caught).toBeInstanceOf(AgentProviderError);
    if (caught instanceof AgentProviderError) {
      expect(caught.provider).toBe('openai');
      expect(caught.failureReason).toBe('stream-cut');
      expect(caught.cause).toBeInstanceOf(SyntaxError);
    }
  });
});

describe('provider-http: error body prefix, header redaction, joinProviderUrl, and pre-read abort', () => {
  test('preserves error body prefix with truncation marker when error body exceeds maxErrorBytes', async () => {
    const bigBody = `Upstream gateway exploded with Bearer secret-abc-123: ${'Z'.repeat(80_000)}`;
    let caught: unknown;
    try {
      await postProviderStream({
        provider: 'test-provider',
        url: 'https://api.example.test/v1/chat',
        headers: {},
        body: {},
        signal: new AbortController().signal,
        fetcher: async () => new Response(bigBody, { status: 502 }),
        parseError: (_parsed, rawText) => ({ message: rawText }),
        maxErrorBytes: 256,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AgentProviderError);
    if (caught instanceof AgentProviderError) {
      expect(caught.statusCode).toBe(502);
      expect(caught.message).toContain('Upstream gateway exploded');
      expect(caught.message).toContain('[REDACTED]');
      expect(caught.message).not.toContain('secret-abc-123');
      expect(caught.responseBody).toContain('Upstream gateway exploded');
      expect(caught.responseBody).toContain('[truncated after 256 bytes]');
    }
  });

  test('headersToRecord strips x-provider-api-keys, proxy-authorization, cookie, authorization, x-api-key, and set-cookie', () => {
    const headers = new Headers({
      Authorization: 'Bearer sk-123',
      'Proxy-Authorization': 'Basic abc',
      'X-Api-Key': 'sk-ant-123',
      'X-Provider-API-Keys': '{"openai":"sk-1"}',
      Cookie: 'session=secret',
      'Set-Cookie': 'session=secret',
      'X-Request-Id': 'req-42',
    });
    expect(headersToRecord(headers)).toEqual({ 'x-request-id': 'req-42' });
  });

  test('joinProviderUrl preserves query strings, avoids duplicating suffix, and rejects invalid schemes', () => {
    expect(
      joinProviderUrl(
        'https://proxy.example.test/openai/v1?api-version=2025-04-01',
        '/responses',
      ),
    ).toBe('https://proxy.example.test/openai/v1/responses?api-version=2025-04-01');
    expect(
      joinProviderUrl(
        'https://proxy.example.test/openai/v1/responses/?api-version=2025-04-01',
        '/responses',
      ),
    ).toBe('https://proxy.example.test/openai/v1/responses?api-version=2025-04-01');
    expect(joinProviderUrl('http://127.0.0.1:8080/', 'chat/completions')).toBe(
      'http://127.0.0.1:8080/chat/completions',
    );
    expect(() => joinProviderUrl('file:///etc/passwd', '/v1')).toThrow(TypeError);
    expect(() => joinProviderUrl('ftp://example.test/v1', '/responses')).toThrow(TypeError);
    expect(() => joinProviderUrl('not a url', '/responses')).toThrow(TypeError);
  });

  test('cancels uniterated SSE response.body when AbortSignal fires before iteration starts', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise(() => {
          /* stays open */
        });
      },
      cancel() {
        cancelled = true;
      },
    });
    const controller = new AbortController();
    const response = await postProviderStream({
      provider: 'test-provider',
      url: 'https://api.example.test/v1/stream',
      headers: {},
      body: {},
      signal: controller.signal,
      fetcher: async () =>
        new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      parseError: (_p, raw) => ({ message: raw }),
    });
    expect(response.kind).toBe('sse');
    expect(cancelled).toBe(false);
    // Abort without ever iterating response.body
    controller.abort(new Error('cancelled before read'));
    await Promise.resolve();
    expect(cancelled).toBe(true);
  });

  test('propagates caller abort instead of AgentProviderError while reading unexpected content-type preview', async () => {
    const controller = new AbortController();
    const stallingHtml = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise(() => {
          /* stalls until aborted */
        });
      },
    });
    const pending = postProviderStream({
      provider: 'test-provider',
      url: 'https://api.example.test/v1/stream',
      headers: {},
      body: {},
      signal: controller.signal,
      fetcher: async () =>
        new Response(stallingHtml, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      parseError: (_p, raw) => ({ message: raw }),
    });
    await Promise.resolve();
    controller.abort(new Error('aborted during html preview'));
    let caught: unknown;
    try {
      await pending;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(AgentProviderError);
    expect((caught as Error).message).toBe('aborted during html preview');
  });
});
