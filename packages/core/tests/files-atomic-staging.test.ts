import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createManagedFileBoundary,
  isAtomicStagingName,
  sweepAtomicStaging,
} from '../src/entrypoints/files';

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'stitchkit-staging-')));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const fixture = join(import.meta.dir, 'fixtures', 'atomic-staging-crash.ts');
const HOUR = 60 * 60 * 1000;
const FORMS: ('async' | 'sync')[] = ['async', 'sync'];

/** Run a real atomic write that is killed before publication and return what it left behind. */
async function abandonedStaging(form: 'async' | 'sync'): Promise<string> {
  const child = Bun.spawn([process.execPath, fixture, join(root, 'state.json'), form], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  await child.exited;
  if (child.signalCode !== 'SIGKILL') throw new Error(await new Response(child.stderr).text());
  const left = await readdir(root);
  expect(left).toHaveLength(1);
  const [name] = left;
  if (name === undefined) throw new Error('the killed writer left nothing');
  return name;
}

async function age(name: string, ms: number): Promise<void> {
  const then = new Date(Date.now() - ms);
  await utimes(join(root, name), then, then);
}

describe('isAtomicStagingName', () => {
  test.each(FORMS)(
    'recognises the staging file a killed writeFileAtomic (%s) left',
    async (form) => {
      const name = await abandonedStaging(form);
      expect(isAtomicStagingName(name)).toBe(true);
    },
  );

  test('the name form is the published contract, not whatever the writer happens to do', async () => {
    // Consumers match this form; a change here is a breaking change of `stitchkit/files`.
    expect(await abandonedStaging('async')).toMatch(/^\.stitchkit-[0-9a-f]{24}\.tmp$/);
  });

  test('recognises the staging file of the managed writer while it is being filled', async () => {
    const boundary = await createManagedFileBoundary({ root });
    let seen: string[] = [];
    // No eager pull: the directory is listed only once the writer reads, with its staging open.
    const source = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          seen = await readdir(root);
          controller.enqueue(new TextEncoder().encode('bytes'));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    await boundary.write('report.txt', source);
    expect(seen).toHaveLength(1);
    expect(seen.every(isAtomicStagingName)).toBe(true);
    expect(await readdir(root)).toEqual(['report.txt']);
    expect(isAtomicStagingName('report.txt')).toBe(false);
  });

  test.each([
    'state.json',
    '.stitchkit-0123456789abcdef01234567.tmp.json',
    '.stitchkit-0123456789abcdef0123456.tmp',
    '.stitchkit-0123456789abcdef012345678.tmp',
    '.stitchkit-0123456789ABCDEF01234567.tmp',
    '.stitchkit-0123456789abcdef0123456g.tmp',
    'stitchkit-0123456789abcdef01234567.tmp',
    '.stitchkit-batch.json',
    '.lock-00000000-0000-4000-8000-000000000001.tmp',
    'sub/.stitchkit-0123456789abcdef01234567.tmp',
  ])('rejects the lookalike %s', (name) => {
    expect(isAtomicStagingName(name)).toBe(false);
  });
});

describe('sweepAtomicStaging', () => {
  test('removes an abandoned staging file older than the bound and returns its name', async () => {
    const name = await abandonedStaging('async');
    await age(name, 2 * HOUR);
    expect(await sweepAtomicStaging({ directory: root, olderThanMs: HOUR })).toEqual([name]);
    expect(await readdir(root)).toEqual([]);
  });

  test('leaves a staging file younger than the bound: it may be a write in flight', async () => {
    const name = await abandonedStaging('sync');
    await age(name, HOUR / 2);
    expect(await sweepAtomicStaging({ directory: root, olderThanMs: HOUR })).toEqual([]);
    expect(await readdir(root)).toEqual([name]);
  });

  test('leaves symlinks, directories, nested staging and other files alone', async () => {
    const outside = join(root, 'outside');
    await writeFile(outside, 'kept');
    await age('outside', 2 * HOUR);
    const link = '.stitchkit-aaaaaaaaaaaaaaaaaaaaaaaa.tmp';
    await symlink(outside, join(root, link));
    const directory = '.stitchkit-bbbbbbbbbbbbbbbbbbbbbbbb.tmp';
    await mkdir(join(root, directory));
    const nested = join(directory, '.stitchkit-cccccccccccccccccccccccc.tmp');
    await writeFile(join(root, nested), 'nested');
    await age(nested, 2 * HOUR);
    await age(directory, 2 * HOUR);
    const lookalike = '.stitchkit-batch.json';
    await writeFile(join(root, lookalike), '{}');
    await age(lookalike, 2 * HOUR);

    expect(await sweepAtomicStaging({ directory: root, olderThanMs: HOUR })).toEqual([]);
    expect((await readdir(root)).sort()).toEqual(
      [directory, link, lookalike, 'outside'].sort(),
    );
    expect(await readdir(join(root, directory))).toEqual([
      '.stitchkit-cccccccccccccccccccccccc.tmp',
    ]);
  });

  test.each([0, -1, 1.5, Number.NaN])('refuses olderThanMs %p', async (olderThanMs) => {
    await expect(sweepAtomicStaging({ directory: root, olderThanMs })).rejects.toThrow(
      RangeError,
    );
  });

  test('an aborted signal stops the sweep before it removes anything', async () => {
    const name = await abandonedStaging('async');
    await age(name, 2 * HOUR);
    const controller = new AbortController();
    controller.abort(new Error('stopped'));
    await expect(
      sweepAtomicStaging({ directory: root, olderThanMs: HOUR, signal: controller.signal }),
    ).rejects.toThrow('stopped');
    expect(await readdir(root)).toEqual([name]);
  });

  test('a directory that does not exist yet has nothing to sweep', async () => {
    expect(
      await sweepAtomicStaging({ directory: join(root, 'not-created'), olderThanMs: HOUR }),
    ).toEqual([]);
  });

  test('a file standing where the directory should be is refused, not read as empty', async () => {
    await writeFile(join(root, 'registry'), 'not a directory');
    await expect(
      sweepAtomicStaging({ directory: join(root, 'registry'), olderThanMs: HOUR }),
    ).rejects.toMatchObject({ code: 'ENOTDIR' });
  });
});
