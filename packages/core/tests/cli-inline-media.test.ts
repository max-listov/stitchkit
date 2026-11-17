import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { AppError } from '../src/contract/errors';
import { createManagedFileBoundary } from '../src/files/boundary';
import { isRecord } from '../src/internal/typed';
import { inlineFileBytes } from '../src/tools/cli/inline-files';
import { defineRuntimeTool } from '../src/tools/runtime-tool';
import { defineViewFileTool } from '../src/tools/transfer/define-view-file-tool';
import { MCP_FILE_NAME_META_KEY } from '../src/tools/transfer/view-file-contract';
import {
  AUDIO,
  AUDIO_BYTES,
  IMAGE,
  IMAGE_BYTES,
  named,
  runMediaCli,
  savedLink,
} from './support/cli-media';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sk-cli-inline-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function viewFileTool() {
  return defineViewFileTool({
    description: 'Inspect synthetic media',
    identity: { serviceName: 'media', action: 'view' },
    transports: ['CLI'],
    files: await createManagedFileBoundary({ root }),
  });
}

test('defineViewFileTool saves a file under its source name without a download callback', async () => {
  await mkdir(join(root, 'feedback'));
  await writeFile(join(root, 'feedback', 'source.png'), IMAGE_BYTES);
  const output = join(root, 'output');
  const result = await runMediaCli(
    null,
    ['view_file', 'feedback/source.png', '--output-dir', output],
    { runtimeTools: [await viewFileTool()] },
  );
  expect(result.code).toBe(0);
  expect(await readdir(output)).toEqual(['source.png']);
  expect(new Uint8Array(await readFile(join(output, 'source.png')))).toEqual(IMAGE_BYTES);
  expect(result.err).toBe(`saved ${join(output, 'source.png')} (0KB)\n`);
  // The bytes left stdout with the file: the block is a link to where they are now.
  expect(JSON.parse(result.out)).toEqual({
    content: [
      {
        type: 'resource_link',
        uri: `file://${join(output, 'source.png')}`,
        name: 'source.png',
        mimeType: 'image/png',
        size: IMAGE_BYTES.length,
      },
      { type: 'text', text: '[image] image/png, 0KB' },
    ],
    errors: [],
  });
  expect(result.out).not.toContain(IMAGE.data);
});

test('two viewed sources with one file name keep the first file and refuse the second', async () => {
  for (const [dir, bytes] of [
    ['first', IMAGE_BYTES],
    ['second', AUDIO_BYTES],
  ] satisfies [string, Uint8Array][]) {
    await mkdir(join(root, dir));
    await writeFile(join(root, dir, 'shot.png'), bytes);
  }
  const output = join(root, 'output');
  const result = await runMediaCli(
    null,
    [
      'view_file',
      `--paths:=${JSON.stringify(['first/shot.png', 'second/shot.png'])}`,
      '--output-dir',
      output,
      '--json',
    ],
    { runtimeTools: [await viewFileTool()] },
  );
  expect(result.code).toBe(1);
  expect(await readdir(output)).toEqual(['shot.png']);
  expect(new Uint8Array(await readFile(join(output, 'shot.png')))).toEqual(IMAGE_BYTES);
  expect(result.err).toBe(
    `saved ${join(output, 'shot.png')} (0KB)\n` +
      'failed to save content[2]: another file of this batch is already saved as "shot.png"\n',
  );
  const { content } = JSON.parse(result.out);
  expect(content[0]).toEqual(savedLink(output, 'shot.png', 'image/png', IMAGE_BYTES.length));
  // The refused block keeps its bytes: nothing the operation returned is lost.
  expect(content[2]).toMatchObject({
    type: 'image',
    _meta: { [MCP_FILE_NAME_META_KEY]: 'shot.png' },
    data: Buffer.from(AUDIO_BYTES).toString('base64'),
  });
});

test('named image and audio are direct children and stdout links each saved file', async () => {
  const text = { type: 'text', text: 'Synthetic files' };
  const foreign = { type: 'resource_link', uri: 'custom:ignored' };
  const data = {
    content: [
      text,
      named(IMAGE, '../../preview.png'),
      foreign,
      named(AUDIO, '/somewhere/voice.ogg'),
      { ...named(IMAGE, 'empty.png'), data: '' },
    ],
    count: 3,
  };
  const result = await runMediaCli(data, ['media', '--output-dir', root, '--json']);
  expect(result.code).toBe(0);
  expect((await readdir(root)).sort()).toEqual(['empty.png', 'preview.png', 'voice.ogg']);
  expect(new Uint8Array(await readFile(join(root, 'preview.png')))).toEqual(IMAGE_BYTES);
  expect(new Uint8Array(await readFile(join(root, 'voice.ogg')))).toEqual(AUDIO_BYTES);
  expect((await readFile(join(root, 'empty.png'))).length).toBe(0);
  expect(result.out).toBe(
    `${JSON.stringify({
      content: [
        text,
        savedLink(root, 'preview.png', 'image/png', IMAGE_BYTES.length),
        foreign,
        savedLink(root, 'voice.ogg', 'audio/ogg', AUDIO_BYTES.length),
        savedLink(root, 'empty.png', 'image/png', 0),
      ],
      count: 3,
    })}\n`,
  );
  expect(result.err.match(/^saved /gm)).toHaveLength(3);
});

test('unnamed media use their type, full byte digest and MIME extension deterministically', async () => {
  const data = { content: [IMAGE, AUDIO, { ...IMAGE, mimeType: 'image/unknown' }] };
  const digest = createHash('sha256').update(IMAGE_BYTES).digest('hex');
  const audioDigest = createHash('sha256').update(AUDIO_BYTES).digest('hex');
  const expected = [`image-${digest}.png`, `audio-${audioDigest}.ogg`, `image-${digest}.bin`];
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await runMediaCli(data, ['media', '--output-dir', root, '--quiet']);
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect((await readdir(root)).sort()).toEqual(expected.toSorted());
    expect(new Uint8Array(await readFile(join(root, expected[0] ?? 'missing')))).toEqual(
      IMAGE_BYTES,
    );
    expect(JSON.parse(result.out).content.map((part: { name: string }) => part.name)).toEqual(
      expected,
    );
  }
});

test('an embedded resource of any type is saved under the file name of its URI', async () => {
  const pdf = new Uint8Array([37, 80, 68, 70, 45, 0, 255]);
  const table = 'id,name\n1,Zoë\n';
  const blob = (uri: string, mimeType?: string) => ({
    type: 'resource',
    resource: {
      uri,
      ...(mimeType && { mimeType }),
      blob: Buffer.from(pdf).toString('base64'),
    },
  });
  const data = {
    content: [
      blob('file:///reports/2026/report.pdf', 'application/pdf'),
      {
        type: 'resource',
        resource: { uri: 'app://exports/table.csv', mimeType: 'text/csv', text: table },
      },
      blob('app://exports/', 'application/x-unknown'),
      { type: 'resource', resource: { uri: 'app://broken.bin', blob: '!!' } },
      { type: 'resource', resource: { uri: 'app://no-content' } },
    ],
  };
  const digest = createHash('sha256').update(pdf).digest('hex');
  const result = await runMediaCli(data, ['media', '--output-dir', root, '--json', '--quiet']);
  expect(result.code).toBe(1);
  expect(result.err).toBe('failed to save content[3]: invalid base64\n');
  expect((await readdir(root)).sort()).toEqual(
    ['report.pdf', `resource-${digest}.bin`, 'table.csv'].sort(),
  );
  expect(new Uint8Array(await readFile(join(root, 'report.pdf')))).toEqual(pdf);
  expect(await readFile(join(root, 'table.csv'), 'utf8')).toBe(table);
  // A link carries the media type only when the resource declared one; a resource
  // without bytes or text is not a file and stays as it is.
  expect(JSON.parse(result.out)).toEqual({
    content: [
      savedLink(root, 'report.pdf', 'application/pdf', pdf.length),
      savedLink(root, 'table.csv', 'text/csv', Buffer.byteLength(table)),
      savedLink(root, `resource-${digest}.bin`, 'application/x-unknown', pdf.length),
      data.content[3],
      data.content[4],
    ],
  });
  const untyped = await runMediaCli({ content: [blob('app://exports/untyped.dat')] }, [
    'media',
    '--output-dir',
    root,
    '--json',
    '--quiet',
  ]);
  expect(JSON.parse(untyped.out).content).toEqual([
    {
      type: 'resource_link',
      uri: `file://${join(root, 'untyped.dat')}`,
      name: 'untyped.dat',
      size: pdf.length,
    },
  ]);
});

test('a text resource is capped by its UTF-8 bytes', async () => {
  const text = (value: string) => ({
    content: [{ type: 'resource', resource: { uri: 'app://notes/note.txt', text: value } }],
  });
  const argv = ['media', '--output-dir', root, '--quiet'];
  // "é" is two bytes: three characters fit a six-byte cap, four characters of it do not.
  expect((await runMediaCli(text('ééé'), argv, { maxDownloadBytes: 6 })).code).toBe(0);
  expect(await readFile(join(root, 'note.txt'), 'utf8')).toBe('ééé');
  for (const value of ['éééé', 'abcdefg']) {
    const refused = await runMediaCli(text(value), argv, { maxDownloadBytes: 6 });
    expect(refused.code).toBe(1);
    expect(refused.err).toBe('failed to save content[0]: file exceeds the 6-byte cap\n');
  }
  expect(await readFile(join(root, 'note.txt'), 'utf8')).toBe('ééé');
});

test('without output-dir inline media stay JSON and create no files', async () => {
  const data = { content: [IMAGE] };
  const result = await runMediaCli(data, ['media', '--json']);
  expect(result).toEqual({ out: `${JSON.stringify(data)}\n`, err: '', code: 0 });
  expect(await readdir(root)).toEqual([]);
});

test('a media block with broken bytes fails alone and keeps its bytes on stdout', async () => {
  const broken = { ...IMAGE, data: '!!' };
  const data = { content: [broken, named(AUDIO, 'voice.ogg')] };
  const result = await runMediaCli(data, ['media', '--output-dir', root, '--quiet', '--json']);
  expect(result.code).toBe(1);
  expect(result.err).toBe('failed to save content[0]: invalid base64\n');
  expect(result.out).toBe(
    `${JSON.stringify({
      content: [broken, savedLink(root, 'voice.ogg', 'audio/ogg', AUDIO_BYTES.length)],
    })}\n`,
  );
  expect(await readdir(root)).toEqual(['voice.ogg']);
  expect(new Uint8Array(await readFile(join(root, 'voice.ogg')))).toEqual(AUDIO_BYTES);
});

test('base64 accepts canonical padded and unpadded bytes and rejects silent decoder repair', async () => {
  for (const data of ['A', 'AA=A', 'AAA===', '!!', 'AB==', 'AAB=', 'AA=', 'AA==\n']) {
    const result = await runMediaCli({ content: [{ ...IMAGE, data }] }, [
      'media',
      '--output-dir',
      root,
    ]);
    expect(result.code).toBe(1);
    expect(result.err).toContain('invalid base64');
    expect(result.err).not.toContain('saved ');
    expect(await readdir(root)).toEqual([]);
  }
  for (const data of ['AAEC', 'AA==', 'AA', 'AAE=', 'AAE']) {
    const result = await runMediaCli({ content: [{ ...named(IMAGE, 'bytes'), data }] }, [
      'media',
      '--output-dir',
      root,
    ]);
    expect(result.code).toBe(0);
    expect(await readFile(join(root, 'bytes'))).toEqual(Buffer.from(data, 'base64'));
  }
});

test('the decoded byte cap allows its exact boundary and refuses one more before decoding', async () => {
  const ok = await runMediaCli(
    { content: [{ ...named(IMAGE, 'exact'), data: 'AAEC' }] },
    ['media', '--output-dir', root],
    { maxDownloadBytes: 3 },
  );
  expect(ok.code).toBe(0);
  expect(new Uint8Array(await readFile(join(root, 'exact')))).toEqual(
    new Uint8Array([0, 1, 2]),
  );
  const decode = spyOn(Buffer, 'from');
  try {
    for (const [data, cap] of [
      ['AAECAw==', 3],
      ['AAECAwQ=', 4],
    ] satisfies [string, number][]) {
      expect(() => inlineFileBytes({ ...IMAGE, data }, cap)).toThrow('byte cap');
    }
    expect(decode).not.toHaveBeenCalled();
  } finally {
    decode.mockRestore();
  }
  const failed = await runMediaCli(
    { content: [{ ...IMAGE, data: 'AAECAw==' }] },
    ['media', '--output-dir', root],
    { maxDownloadBytes: 3 },
  );
  expect(failed.code).toBe(1);
  expect(failed.err).toContain('file exceeds the 3-byte cap');
  expect(failed.err).not.toContain('saved ');
  expect(await readdir(root)).toEqual(['exact']);
});

test('dry-run, help and schema do not execute an operation with output-dir', async () => {
  let calls = 0;
  for (const flag of ['--dry-run', '--help', '--schema']) {
    const result = await runMediaCli(
      { content: [IMAGE] },
      ['media', '--output-dir', root, flag],
      {
        hooks: {
          afterToolCall: () => {
            calls++;
          },
        },
      },
    );
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
  }
  expect(calls).toBe(0);
  expect(await readdir(root)).toEqual([]);
});

test('an operation failure retains its code and never saves media', async () => {
  const result = await runMediaCli(null, ['media', '--output-dir', root, '--json'], {
    runtimeTools: [
      defineRuntimeTool({
        name: 'media',
        description: 'Refuse a missing synthetic file',
        identity: { serviceName: 'media', action: 'view', method: 'GET' },
        transports: ['CLI'],
        input: z.object({}),
        output: z.unknown(),
        handler: () => {
          throw new AppError('NOT_FOUND', { message: 'Synthetic file missing' });
        },
      }),
    ],
  });
  expect(result.code).toBe(4);
  expect(result.out).toBe('');
  expect(JSON.parse(result.err).error).toBe('NOT_FOUND');
  expect(await readdir(root)).toEqual([]);
});

test('wait saves media from the final poll rather than the initial pending response', async () => {
  let calls = 0;
  const data = { content: [named(IMAGE, 'ready.png')] };
  const result = await runMediaCli(
    null,
    ['media', '--wait', '--output-dir', root, '--quiet'],
    {
      runtimeTools: [
        defineRuntimeTool({
          name: 'media',
          description: 'Poll synthetic media',
          identity: { serviceName: 'media', action: 'get', method: 'GET' },
          transports: ['CLI'],
          input: z.object({}),
          output: z.unknown(),
          handler: () => (++calls === 1 ? { status: 'pending' } : data),
        }),
      ],
      wait: {
        media: {
          tool: 'media',
          poll: () => ({}),
          done: (value) => isRecord(value) && Array.isArray(value.content),
          backoff: [0],
        },
      },
    },
  );
  expect(result.code).toBe(0);
  expect(result.err).toBe('');
  expect(JSON.parse(result.out)).toEqual({
    content: [savedLink(root, 'ready.png', 'image/png', IMAGE_BYTES.length)],
  });
  expect(calls).toBe(2);
  expect(new Uint8Array(await readFile(join(root, 'ready.png')))).toEqual(IMAGE_BYTES);
});
