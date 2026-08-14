import { describe, expect, spyOn, test } from 'bun:test';
import { z } from 'zod';
import { defineContract } from '../src/contract';
import { createHandler, defineMultipartStream, implement } from '../src/server';
import { parseMultipart } from '../src/server/multipart';

function multipartRequest(
  body: string,
  boundary: string,
  chunkSize = body.length,
  extraHeaders?: HeadersInit,
  signal?: AbortSignal,
): Request {
  const bytes = new TextEncoder().encode(body);
  let offset = 0;
  return new Request('http://localhost/upload', {
    method: 'POST',
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      ...extraHeaders,
    },
    signal,
    body: new ReadableStream({
      pull(controller) {
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        const end = Math.min(offset + chunkSize, bytes.length);
        controller.enqueue(bytes.slice(offset, end));
        offset = end;
      },
    }),
  });
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    chunks.push(result.value);
    length += result.value.length;
  }
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(joined);
}

const boundary = 'stitchkit-stream-boundary';

class HeaderOverrideRequest extends Request {
  readonly #headers: Headers;

  constructor(input: Request, headers: Headers) {
    super(input);
    this.#headers = headers;
  }

  override get headers(): Headers {
    return this.#headers;
  }
}

describe('streaming multipart parser', () => {
  test('parses arbitrary chunk boundaries and validates late text fields', async () => {
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="hello.txt"',
      'Content-Type: text/plain',
      '',
      'hello streamed world',
      `--${boundary}`,
      'Content-Disposition: form-data; name="title"',
      '',
      'Document',
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const result = await parseMultipart(
      multipartRequest(body, boundary, 1),
      { delivery: 'stream', files: { file: { contentTypes: ['text/*'] } } },
      z.object({ title: z.string() }),
      {
        file: async ({ metadata, stream }) => ({
          value: { metadata, contents: await readStream(stream) },
          cleanup: () => undefined,
        }),
      },
    );

    expect(result.files.file).toEqual({
      metadata: {
        field: 'file',
        filename: 'hello.txt',
        contentType: 'text/plain',
        size: undefined,
      },
      contents: 'hello streamed world',
    });
    expect(result.fields).toEqual({ title: 'Document' });
  });

  test('preserves multiple receiver value order', async () => {
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="files"; filename="one.txt"',
      'Content-Type: text/plain',
      '',
      'one',
      `--${boundary}`,
      'Content-Disposition: form-data; name="files"; filename="two.txt"',
      'Content-Type: text/plain',
      '',
      'two',
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const result = await parseMultipart(
      multipartRequest(body, boundary, 3),
      { delivery: 'stream', files: { files: { multiple: true, maxFiles: 2 } } },
      undefined,
      {
        files: async ({ stream }) => ({
          value: await readStream(stream),
          cleanup: () => undefined,
        }),
      },
    );
    expect(result.files.files).toEqual(['one', 'two']);
  });

  test('rolls accepted handles back once in reverse order after late validation fails', async () => {
    const cleanupOrder: string[] = [];
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="files"; filename="one.txt"',
      'Content-Type: text/plain',
      '',
      'one',
      `--${boundary}`,
      'Content-Disposition: form-data; name="files"; filename="two.txt"',
      'Content-Type: text/plain',
      '',
      'two',
      `--${boundary}`,
      'Content-Disposition: form-data; name="count"',
      '',
      'invalid',
      `--${boundary}--`,
      '',
    ].join('\r\n');

    await expect(
      parseMultipart(
        multipartRequest(body, boundary, 5),
        { delivery: 'stream', files: { files: { multiple: true } } },
        z.object({ count: z.coerce.number() }),
        {
          files: async ({ stream }) => {
            const value = await readStream(stream);
            return {
              value,
              cleanup: () => void cleanupOrder.push(value),
            };
          },
        },
      ),
    ).rejects.toThrow();
    expect(cleanupOrder).toEqual(['two', 'one']);
  });

  test('rolls back a receiver result that did not consume its stream', async () => {
    let cleanups = 0;
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="one.txt"',
      'Content-Type: text/plain',
      '',
      'one',
      `--${boundary}--`,
      '',
    ].join('\r\n');
    await expect(
      parseMultipart(
        multipartRequest(body, boundary),
        { delivery: 'stream', files: { file: {} } },
        undefined,
        {
          file: () => ({
            value: 'unused',
            cleanup: () => {
              cleanups += 1;
            },
          }),
        },
      ),
    ).rejects.toThrow('did not consume its stream');
    expect(cleanups).toBe(1);
  });

  test('enforces request and per-file caps without trusting content-length', async () => {
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="one.txt"',
      'Content-Type: text/plain',
      '',
      'payload',
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const originalRequest = multipartRequest(body, boundary, 2);
    const spoofedHeaders = new Headers(originalRequest.headers);
    spoofedHeaders.set('content-length', '1');
    const requestWithSpoofedLength = new HeaderOverrideRequest(
      originalRequest,
      spoofedHeaders,
    );
    await expect(
      parseMultipart(
        requestWithSpoofedLength,
        {
          delivery: 'stream',
          maxRequestBytes: Math.floor(body.length / 2),
          files: { file: {} },
        },
        undefined,
        {
          file: async ({ stream }) => ({
            value: await readStream(stream),
            cleanup: () => undefined,
          }),
        },
      ),
    ).rejects.toThrow('Multipart request exceeds');

    await expect(
      parseMultipart(
        multipartRequest(body, boundary, 2),
        { delivery: 'stream', files: { file: { maxBytes: 3 } } },
        undefined,
        {
          file: async ({ stream }) => ({
            value: await readStream(stream),
            cleanup: () => undefined,
          }),
        },
      ),
    ).rejects.toThrow('Multipart field "file" exceeds 3 bytes');
  });

  test('delivers a large file incrementally instead of materialising the payload', async () => {
    const payload = 'x'.repeat(2 * 1024 * 1024);
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="large.bin"',
      'Content-Type: application/octet-stream',
      '',
      payload,
      `--${boundary}--`,
      '',
    ].join('\r\n');
    let largestChunk = 0;
    const result = await parseMultipart(
      multipartRequest(body, boundary, 64 * 1024),
      { delivery: 'stream', files: { file: {} } },
      undefined,
      {
        file: async ({ stream }) => {
          const reader = stream.getReader();
          let received = 0;
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            received += next.value.length;
            largestChunk = Math.max(largestChunk, next.value.length);
          }
          return { value: received, cleanup: () => undefined };
        },
      },
    );

    expect(result.files.file).toBe(payload.length);
    expect(largestChunk).toBeLessThan(payload.length);
  });

  test('request abort cancels the active receiver and rolls back earlier handles', async () => {
    const controller = new AbortController();
    const cleanups: string[] = [];
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="files"; filename="one.txt"',
      'Content-Type: text/plain',
      '',
      'one',
      `--${boundary}`,
      'Content-Disposition: form-data; name="files"; filename="two.txt"',
      'Content-Type: text/plain',
      '',
      'two'.repeat(10_000),
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const request = multipartRequest(body, boundary, 32, undefined, controller.signal);
    let receiverCalls = 0;

    await expect(
      parseMultipart(
        request,
        { delivery: 'stream', files: { files: { multiple: true } } },
        undefined,
        {
          files: async ({ stream }) => {
            receiverCalls += 1;
            if (receiverCalls === 1) {
              const value = await readStream(stream);
              return { value, cleanup: () => void cleanups.push(value) };
            }
            const reader = stream.getReader();
            await reader.read();
            controller.abort(new DOMException('Client disconnected', 'AbortError'));
            await reader.read();
            return { value: 'unreachable', cleanup: () => undefined };
          },
        },
      ),
    ).rejects.toThrow('Client disconnected');
    expect(cleanups).toEqual(['one']);
  });

  test('cleanup failure is diagnosed without replacing the original parse error', async () => {
    const diagnostic = spyOn(console, 'error').mockImplementation(() => undefined);
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="one.txt"',
      'Content-Type: text/plain',
      '',
      'one',
      `--${boundary}`,
      'Content-Disposition: form-data; name="count"',
      '',
      'invalid',
      `--${boundary}--`,
      '',
    ].join('\r\n');

    try {
      await expect(
        parseMultipart(
          multipartRequest(body, boundary, 7),
          { delivery: 'stream', files: { file: {} } },
          z.object({ count: z.coerce.number() }),
          {
            file: async ({ stream }) => ({
              value: await readStream(stream),
              cleanup: () => {
                throw new Error('cleanup failed');
              },
            }),
          },
        ),
      ).rejects.toThrow('expected number');
      expect(diagnostic).toHaveBeenCalledWith(
        '[stitchkit] multipart receiver cleanup failed',
        expect.objectContaining({ message: 'cleanup failed' }),
      );
    } finally {
      diagnostic.mockRestore();
    }
  });
});

describe('defineMultipartStream integration', () => {
  test('hands inferred receiver values to the handler and rolls them back on handler failure', async () => {
    const cleanups: string[] = [];
    const uploadContract = defineContract(
      { prefix: 'media' },
      {
        upload: {
          method: 'POST',
          path: '/',
          desc: 'Stream media',
          input: z.object({ fail: z.stringbool() }),
          output: z.object({ stored: z.string() }),
          multipart: {
            delivery: 'stream',
            files: { file: { contentTypes: ['text/plain'] } },
          },
        },
      },
    );
    const service = implement(uploadContract, {
      upload: defineMultipartStream(uploadContract.endpoints.upload, {
        files: {
          file: async ({ stream }) => {
            const stored = await readStream(stream);
            return {
              value: stored,
              cleanup: () => void cleanups.push(stored),
            };
          },
        },
        handler: ({ input, files }) => {
          if (input.fail) throw new Error('handler failed');
          return { stored: files.file };
        },
      }),
    });
    const handler = createHandler({
      services: [service],
      hooks: { onError: () => new Response('failed', { status: 500 }) },
    });

    const successForm = new FormData();
    successForm.append('file', new File(['kept'], 'kept.txt', { type: 'text/plain' }));
    successForm.append('fail', 'false');
    const success = await handler(
      new Request('http://localhost/media', { method: 'POST', body: successForm }),
    );
    expect(success.status).toBe(200);
    expect(await success.json()).toEqual({ stored: 'kept' });
    expect(cleanups).toEqual([]);

    const failureForm = new FormData();
    failureForm.append('file', new File(['removed'], 'removed.txt', { type: 'text/plain' }));
    failureForm.append('fail', 'true');
    const failure = await handler(
      new Request('http://localhost/media', { method: 'POST', body: failureForm }),
    );
    expect(failure.status).toBe(500);
    expect(cleanups).toEqual(['removed']);
  });
});
