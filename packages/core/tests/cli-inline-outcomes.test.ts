import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { type CliConfig, defineCliResult } from '../src/entrypoints/cli';
import { defineRuntimeTool } from '../src/tools/runtime-tool';
import { AUDIO, IMAGE, IMAGE_BYTES, named, runMediaCli, savedLink } from './support/cli-media';

const NOTHING_SAVED = '--output-dir: the result carries no files to save\n';
const Output = z.unknown();

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sk-cli-inline-outcomes-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** One command whose output schema a result policy can be typed against. */
function tool(data: unknown, onCall?: () => void) {
  return defineRuntimeTool({
    name: 'media',
    description: 'Return synthetic data',
    identity: { serviceName: 'media', action: 'create', method: 'POST' },
    transports: ['CLI'],
    input: z.object({}),
    output: Output,
    handler: () => {
      onCall?.();
      return data;
    },
  });
}

test('a result without media answers as it does without the flag and says nothing was saved', async () => {
  const list = { items: [{ kind: 'a' }, { kind: 'a' }, { kind: 'b' }] };
  const never = join(root, 'never-created');
  const cases: Array<{ argv: string[]; config: Partial<CliConfig> }> = [
    { argv: ['--json'], config: {} },
    { argv: ['--json'], config: { download: () => [] } },
    { argv: ['--count-by', 'kind'], config: {} },
    {
      argv: [],
      config: {
        results: {
          media: defineCliResult(Output, { present: () => 'PRESENTED\n', exitCode: () => 7 }),
        },
      },
    },
  ];
  for (const { argv, config } of cases) {
    const run = (extra: string[]) =>
      runMediaCli(null, ['media', ...argv, ...extra], {
        runtimeTools: [tool(list)],
        ...config,
      });
    const plain = await run([]);
    expect(plain.err).toBe('');
    expect(await run(['--output-dir', never])).toEqual({ ...plain, err: NOTHING_SAVED });
    expect(await run(['--output-dir', never, '--quiet'])).toEqual(plain);
  }
  // The four cases really differ: an aggregate, a presenter and its exit code were applied.
  const aggregate = await runMediaCli(
    null,
    ['media', '--count-by', 'kind', '--output-dir', never],
    { runtimeTools: [tool(list)] },
  );
  expect(JSON.parse(aggregate.out)).toEqual({ a: 2, b: 1 });
  const presented = await runMediaCli(null, ['media', '--output-dir', never], {
    runtimeTools: [tool(list)],
    results: {
      media: defineCliResult(Output, { present: () => 'PRESENTED\n', exitCode: () => 7 }),
    },
  });
  expect(presented).toEqual({ out: 'PRESENTED\n', err: NOTHING_SAVED, code: 7 });
  expect(existsSync(never)).toBe(false);
});

test('a part that only calls itself image stays the data of its result', async () => {
  const document = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'hi' }] },
      { type: 'image', attrs: { src: 'https://example.invalid/a.png' } },
      { type: 'audio', data: 7, mimeType: 'audio/ogg' },
      { type: 'image', data: IMAGE.data },
    ],
  };
  for (const config of [{}, { download: () => [] }] satisfies Partial<CliConfig>[]) {
    const result = await runMediaCli(
      document,
      ['media', '--output-dir', root, '--json'],
      config,
    );
    expect(result).toEqual({
      out: `${JSON.stringify(document)}\n`,
      err: NOTHING_SAVED,
      code: 0,
    });
  }
  expect(await readdir(root)).toEqual([]);
  // The same node beside real media: the media is saved, the node is untouched.
  const mixed = { content: [document.content[1], named(IMAGE, 'real.png')] };
  const result = await runMediaCli(mixed, [
    'media',
    '--output-dir',
    root,
    '--json',
    '--quiet',
  ]);
  expect(result).toEqual({
    out: `${JSON.stringify({
      content: [
        mixed.content[0],
        savedLink(root, 'real.png', 'image/png', IMAGE_BYTES.length),
      ],
    })}\n`,
    err: '',
    code: 0,
  });
});

test('a result policy judges the operation result while stdout links the saved file', async () => {
  const data = { content: [named(IMAGE, 'shot.png')] };
  const link = { content: [savedLink(root, 'shot.png', 'image/png', IMAGE_BYTES.length)] };
  const judged: unknown[] = [];
  const exitOnly = await runMediaCli(
    null,
    ['media', '--output-dir', root, '--json', '--quiet'],
    {
      runtimeTools: [tool(data)],
      results: {
        media: defineCliResult(Output, {
          exitCode: (result) => {
            judged.push(result);
            return 3;
          },
        }),
      },
    },
  );
  expect(exitOnly).toEqual({ out: `${JSON.stringify(link)}\n`, err: '', code: 3 });
  const presented = await runMediaCli(null, ['media', '--output-dir', root, '--quiet'], {
    runtimeTools: [tool(data)],
    results: {
      media: defineCliResult(Output, {
        present: ({ result }) => {
          judged.push(result);
          return 'PRESENTED\n';
        },
      }),
    },
  });
  expect(presented).toEqual({ out: 'PRESENTED\n', err: '', code: 0 });
  // Both halves of the policy saw what the operation returned, bytes included.
  expect(judged).toEqual([data, data]);
  expect(new Uint8Array(await readFile(join(root, 'shot.png')))).toEqual(IMAGE_BYTES);
});

test('a name is written once per batch: the same file again is saved, another file is refused', async () => {
  const first = named(IMAGE, 'x.png');
  const other = named(AUDIO, 'x.png');
  const refused = await runMediaCli({ content: [first, other] }, [
    'media',
    '--output-dir',
    root,
    '--json',
  ]);
  expect(refused).toEqual({
    out: `${JSON.stringify({
      content: [savedLink(root, 'x.png', 'image/png', IMAGE_BYTES.length), other],
    })}\n`,
    err:
      `saved ${join(root, 'x.png')} (0KB)\n` +
      'failed to save content[1]: another file of this batch is already saved as "x.png"\n',
    code: 1,
  });
  expect(new Uint8Array(await readFile(join(root, 'x.png')))).toEqual(IMAGE_BYTES);

  const link = savedLink(root, 'x.png', 'image/png', IMAGE_BYTES.length);
  const repeated = await runMediaCli({ content: [first, first] }, [
    'media',
    '--output-dir',
    root,
    '--json',
  ]);
  expect(repeated).toEqual({
    out: `${JSON.stringify({ content: [link, link] })}\n`,
    err: `saved ${join(root, 'x.png')} (0KB)\n`,
    code: 0,
  });
  expect(await readdir(root)).toEqual(['x.png']);
});

test('a byte limit that is not a positive safe integer refuses when the CLI is created', async () => {
  let calls = 0;
  const run = (maxDownloadBytes: number, argv: string[]) =>
    runMediaCli(null, ['media', ...argv], {
      runtimeTools: [
        tool({ content: [IMAGE] }, () => {
          calls++;
        }),
      ],
      maxDownloadBytes,
    });
  for (const cap of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 1.5]) {
    for (const argv of [[], ['--output-dir', join(root, 'never-created')], ['--help']]) {
      await expect(run(cap, argv)).rejects.toThrow(
        `createCli maxDownloadBytes must be a positive safe integer, received ${cap}`,
      );
    }
  }
  expect(calls).toBe(0);
  expect(await readdir(root)).toEqual([]);
  expect((await run(IMAGE_BYTES.length, ['--output-dir', root, '--quiet'])).code).toBe(0);
  expect(calls).toBe(1);
});
