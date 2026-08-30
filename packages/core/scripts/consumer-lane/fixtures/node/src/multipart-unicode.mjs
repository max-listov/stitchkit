import assert from 'node:assert/strict';
import { defineContract } from 'stitchkit/contract';
import { createHandler, defineMultipartStream, implement } from 'stitchkit/server';
import { z } from 'zod';

const name = 'Снимок — 1.png';
for (const delivery of ['buffer', 'stream']) {
  const contract = defineContract(
    { prefix: 'upload' },
    {
      file: {
        method: 'POST',
        path: '/',
        desc: 'Unicode upload',
        output: z.object({ name: z.string(), text: z.string() }),
        multipart: { delivery, files: { file: { maxBytes: 20 } } },
      },
    },
  );
  const service = implement(contract, {
    file:
      delivery === 'stream'
        ? defineMultipartStream(contract.endpoints.file, {
            files: {
              file: async ({ metadata, stream }) => ({
                value: { name: metadata.filename, text: await new Response(stream).text() },
                cleanup: () => undefined,
              }),
            },
            handler: ({ files }) => files.file,
          })
        : async ({ files }) => ({ name: files.file.name, text: await files.file.text() }),
  });
  const handler = createHandler({ services: [service] });
  const form = new FormData();
  form.append('file', new File(['image'], name, { type: 'image/png' }));
  const browser = await handler(
    new Request('http://localhost/upload', { method: 'POST', body: form }),
  );
  assert.equal(browser.status, 200);
  assert.deepEqual(await browser.json(), { name, text: 'image' });
  const boundary = 'packed-unicode';
  for (const encoded of [encodeURIComponent(name), 'bad%0D%0Ainjection', 'bad%FF']) {
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fallback.png"; filename*=UTF-8''${encoded}\r\n\r\nimage\r\n--${boundary}--\r\n`;
    const response = await handler(
      new Request('http://localhost/upload', {
        method: 'POST',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        body,
      }),
    );
    if (encoded === encodeURIComponent(name)) {
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { name, text: 'image' });
    } else assert.equal(response.status, 400);
  }
}
console.log('packed multipart Unicode: ok');
