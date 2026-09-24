import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createTelegramLocalFiles,
  TelegramLocalFileError,
  type TelegramLocalFileRefusal,
} from '../src/telegram/local-files';

/*
 * `file_path` arrives over the network. Whatever it says, the bot reads and
 * deletes inside its own directory of the Bot API server's root — and a
 * refusal names a reason without naming the path or the token.
 */

const token = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function serverRoot() {
  const base = await mkdtemp(join(tmpdir(), 'stitchkit-bot-api-'));
  roots.push(base);
  const root = join(base, 'files');
  const bot = join(root, token);
  await mkdir(join(bot, 'videos'), { recursive: true });
  await writeFile(join(bot, 'videos', 'file_1.mp4'), 'video');
  await writeFile(join(base, 'secret.txt'), 'outside');
  return { base, root, bot, files: createTelegramLocalFiles({ root, token }) };
}

async function refusal(run: Promise<unknown>): Promise<TelegramLocalFileRefusal> {
  const error = await run.then(
    () => undefined,
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(TelegramLocalFileError);
  if (!(error instanceof TelegramLocalFileError)) throw new Error('not refused');
  expect(error.message).not.toContain(token);
  expect(error.message).not.toContain('/');
  return error.reason;
}

describe('createTelegramLocalFiles', () => {
  test('a relative file_path resolves inside the bot directory; so does a --local absolute one', async () => {
    const { bot, files } = await serverRoot();
    const expected = join(bot, 'videos', 'file_1.mp4');
    expect(await files.resolve('videos/file_1.mp4')).toBe(expected);
    expect(await files.resolve(expected)).toBe(expected);
  });

  test('../, an absolute path elsewhere and a link out of the directory are refused', async () => {
    const { base, bot, files } = await serverRoot();
    await symlink(join(base, 'secret.txt'), join(bot, 'videos', 'link.mp4'));
    expect(await refusal(files.resolve('../../secret.txt'))).toBe('outside-bot-directory');
    expect(await refusal(files.resolve(join(base, 'secret.txt')))).toBe(
      'outside-bot-directory',
    );
    expect(await refusal(files.resolve('/etc/passwd'))).toBe('outside-bot-directory');
    expect(await refusal(files.resolve('videos/link.mp4'))).toBe('outside-bot-directory');
    expect(await refusal(files.remove('videos/link.mp4'))).toBe('outside-bot-directory');
    expect(await refusal(files.remove('../../secret.txt'))).toBe('outside-bot-directory');
    expect(await Bun.file(join(base, 'secret.txt')).text()).toBe('outside');
  });

  test('missing, a directory, and a relative root are named', async () => {
    const { root, files } = await serverRoot();
    expect(await refusal(files.resolve('videos/none.mp4'))).toBe('missing');
    expect(await refusal(files.resolve('videos'))).toBe('not-a-file');
    const relative = createTelegramLocalFiles({ root: 'files', token });
    expect(await refusal(relative.resolve('videos/file_1.mp4'))).toBe('root-not-absolute');
    const otherBot = createTelegramLocalFiles({ root, token: '42:another' });
    expect(await refusal(otherBot.resolve('videos/file_1.mp4'))).toBe(
      'bot-directory-unavailable',
    );
  });

  test('remove deletes a handled file once and tolerates it being gone', async () => {
    const { bot, files } = await serverRoot();
    await files.remove('videos/file_1.mp4');
    expect(await readdir(join(bot, 'videos'))).toEqual([]);
    await files.remove('videos/file_1.mp4');
  });

  test('check reports whether the bot directory is there for readiness', async () => {
    const { root, files } = await serverRoot();
    expect(await files.check()).toEqual({ ready: true });
    expect(await createTelegramLocalFiles({ root, token: '42:another' }).check()).toEqual({
      ready: false,
      reason: 'bot-directory-unavailable',
    });
    expect(await createTelegramLocalFiles({ root: 'relative', token }).check()).toEqual({
      ready: false,
      reason: 'root-not-absolute',
    });
  });
});
