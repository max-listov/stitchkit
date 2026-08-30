import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract } from '../src/contract';
import { createHandler, defineMultipartStream, implement } from '../src/server';
import { parseMultipart } from '../src/server/multipart';

const filename = 'Снимок — 1.png';
const boundary = 'unicode-proof';

function request(headers: string, bytes?: Uint8Array, chunkSize = 1): Request {
  const body =
    bytes ??
    new TextEncoder().encode(
      `--${boundary}\r\n${headers}\r\n\r\nimage\r\n--${boundary}--\r\n`,
    );
  let offset = 0;
  return new Request('http://localhost/upload', {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body: new ReadableStream({
      pull(controller) {
        if (offset === body.length) controller.close();
        else {
          const end = Math.min(body.length, offset + chunkSize);
          controller.enqueue(body.slice(offset, end));
          offset = end;
        }
      },
    }),
  });
}

describe('multipart Unicode metadata', () => {
  const contract = defineContract(
    { prefix: 'upload' },
    {
      buffer: {
        method: 'POST',
        path: '/buffer',
        desc: 'Buffer upload',
        output: z.object({ name: z.string(), text: z.string() }),
        multipart: { files: { file: {} } },
      },
      stream: {
        method: 'POST',
        path: '/stream',
        desc: 'Stream upload',
        output: z.object({ name: z.string(), text: z.string() }),
        multipart: { delivery: 'stream', files: { file: {} } },
      },
    },
  );
  const service = implement(contract, {
    buffer: async ({ files }) => ({ name: files.file.name, text: await files.file.text() }),
    stream: defineMultipartStream(contract.endpoints.stream, {
      files: {
        file: async ({ metadata, stream }) => ({
          value: { name: metadata.filename, text: await new Response(stream).text() },
          cleanup: () => undefined,
        }),
      },
      handler: ({ files }) => files.file,
    }),
  });
  for (const delivery of ['buffer', 'stream']) {
    test(`${delivery}: browser FormData filename reaches the endpoint unchanged`, async () => {
      const form = new FormData();
      form.append('file', new File(['image'], filename, { type: 'image/png' }));
      const response = await createHandler({ services: [service] })(
        new Request(`http://localhost/upload/${delivery}`, { method: 'POST', body: form }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ name: filename, text: 'image' });
    });
  }

  test('one-byte chunks preserve Unicode and extended filename takes precedence', async () => {
    for (const disposition of [
      `name="file"; filename="${filename}"`,
      `name=file; filename="fallback.png"; filename*=UTF-8'ru'${encodeURIComponent(filename)}`,
      `filename*=utf-8''${encodeURIComponent(filename)}; name="file"`,
    ]) {
      const result = await parseMultipart(
        request(`cOnTeNt-DiSpOsItIoN: form-data; ${disposition}`),
        {
          files: { file: {} },
        },
      );
      expect(result.files.file).toBeInstanceOf(File);
      if (!(result.files.file instanceof File)) throw new Error('Expected a file');
      expect(result.files.file.name).toBe(filename);
      expect(await result.files.file.text()).toBe('image');
    }
  });

  test('quoted semicolons, escaped quotes and literal percent sequences are preserved', async () => {
    const result = await parseMultipart(
      request('Content-Disposition: form-data; name="file"; filename="a;\\"b%20.png"'),
      { files: { file: {} } },
    );
    if (!(result.files.file instanceof File)) throw new Error('Expected a file');
    expect(result.files.file.name).toBe('a;"b%20.png');
  });

  const valid = 'Content-Disposition: form-data; name="file"; filename="a.png"';
  const invalidHeaders: Array<[string, string]> = [
    ['duplicate disposition', `${valid}\r\ncontent-disposition: form-data; name="other"`],
    [
      'duplicate content-type',
      `${valid}\r\nContent-Type: image/png\r\ncontent-type: text/plain`,
    ],
    ['duplicate size', `${valid}\r\nContent-Length: 5\r\nContent-Length: 9`],
    ['folded header', `${valid}\r\n Content-Type: image/png`],
    ['space in header name', `${valid}\r\nContent Type: image/png`],
    ['space before colon', `${valid}\r\nContent-Type : image/png`],
    ['bare LF injection', `${valid}\nX-Injected: yes`],
    ['bare CR injection', `${valid}\rX-Injected: yes`],
    [
      'unterminated quoted name',
      'Content-Disposition: form-data; name="file; filename="a.png"',
    ],
    ['duplicate field name', `${valid}; name="other"`],
    [
      'unsafe field name',
      'Content-Disposition: form-data; name="__proto__"; filename="a.png"',
    ],
    [
      'unsafe constructor',
      'Content-Disposition: form-data; name="constructor"; filename="a.png"',
    ],
    ['decoded CRLF', `${valid}; filename*=UTF-8''evil%0D%0AInjected`],
    ['decoded NUL', `${valid}; filename*=UTF-8''evil%00.png`],
    ['invalid percent escape', `${valid}; filename*=UTF-8''bad%ZZ`],
    ['invalid UTF-8 escape', `${valid}; filename*=UTF-8''bad%FF`],
    ['unsupported charset', `${valid}; filename*=ISO-8859-1''caf%E9`],
    ['duplicate extended filename', `${valid}; filename*=UTF-8''a; filename*=UTF-8''b`],
    ...['', '-1', '1.5', '1e2', '+5', '0x5', '9007199254740992'].map(
      (size): [string, string] => [
        `invalid size ${JSON.stringify(size)}`,
        `${valid}\r\nContent-Length: ${size}`,
      ],
    ),
  ];
  for (const [label, headers] of invalidHeaders) {
    test(`rejects ${label} before invoking a receiver`, async () => {
      let calls = 0;
      await expect(
        parseMultipart(
          request(headers),
          {
            delivery: 'stream',
            files: { file: {} },
          },
          undefined,
          {
            file: async () => {
              calls++;
              return { value: 'unexpected', cleanup: () => undefined };
            },
          },
        ),
      ).rejects.toMatchObject({ status: 400 });
      expect(calls).toBe(0);
    });
  }

  test('invalid UTF-8 bytes and oversized header blocks are rejected', async () => {
    const bytes = new TextEncoder().encode(
      `--${boundary}\r\n${valid}\r\nX-Name: x\r\n\r\nimage\r\n--${boundary}--\r\n`,
    );
    bytes[bytes.indexOf(120)] = 255;
    await expect(
      parseMultipart(request('', bytes), { files: { file: {} } }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      parseMultipart(request(`${valid}\r\nX-Padding: ${'a'.repeat(65536)}`, undefined, 1024), {
        files: { file: {} },
      }),
    ).rejects.toThrow('headers are too large');
  });

  test('a malformed later part rolls back the Unicode receiver exactly once', async () => {
    const cleaned: string[] = [];
    const body = new TextEncoder().encode(
      [
        `--${boundary}`,
        `Content-Disposition: form-data; name="file"; filename="${filename}"`,
        '',
        'image',
        `--${boundary}`,
        'Invalid Header: value',
        '',
        'later',
        `--${boundary}--`,
        '',
      ].join('\r\n'),
    );
    await expect(
      parseMultipart(
        request('', body),
        {
          delivery: 'stream',
          files: { file: {} },
        },
        undefined,
        {
          file: async ({ metadata, stream }) => {
            await new Response(stream).arrayBuffer();
            return {
              value: metadata.filename,
              cleanup: () => {
                cleaned.push(metadata.filename);
              },
            };
          },
        },
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(cleaned).toEqual([filename]);
  });
});
