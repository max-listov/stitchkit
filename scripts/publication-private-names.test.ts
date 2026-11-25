/**
 * The names of private projects are refused in what git carries, from a list the repository
 * never holds. Every name below is synthetic: a real one written here would be the disclosure.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  inspectNames,
  inspectTrackedNames,
  PRIVATE_NAME_RULE,
  privateNameShapes,
  readPrivateNames,
} from './publication-private-names';

const made: string[] = [];
afterEach(() => {
  for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): void {
  const result = Bun.spawnSync(['git', '-C', root, ...args], { stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
}

/** A repository of its own under the run's TMPDIR, with its own index. */
function repository(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'sk-private-names-'));
  made.push(root);
  git(root, 'init', '--quiet');
  for (const [file, contents] of Object.entries(files))
    writeFileSync(join(root, file), contents);
  git(root, 'add', '--', ...Object.keys(files));
  return root;
}

describe('a private project name', () => {
  const shapes = privateNameShapes(['acme-chat']);
  const named = (line: string) => inspectNames('a.ts', line, shapes).length > 0;

  test('is found in every spelling a reader recognises', () => {
    for (const line of [
      'served.url = `http://127.0.0.1:8080/acmechat.gz`;',
      'the AcmeChat gates',
      'acme_chat',
      'acme chat bot',
      'owner/acme-chat-bot:task.md',
    ])
      expect(named(line), line).toBe(true);
  });

  test('is not found inside a longer word or apart from its other half (negative control)', () => {
    for (const line of ['acmechatter', 'xacmechat', 'acme', 'chat', 'acme-x-chat'])
      expect(named(line), line).toBe(false);
  });

  test('a list that names nothing is refused, not a scan that finds nothing', () => {
    expect(() => privateNameShapes([])).toThrow();
    expect(() => privateNameShapes(['--'])).toThrow();
  });
});

describe('the list a clone names', () => {
  test('a clone that names none says so', async () => {
    expect(await readPrivateNames(repository({ 'a.ts': 'x\n' }))).toEqual({
      kind: 'unconfigured',
    });
  });

  test('a named list is read, and its names are found in what git carries', async () => {
    const root = repository({
      'a.ts': 'ok\nconst file = "acmechat.gz";\n',
      'b.md': 'clean\n',
    });
    writeFileSync(join(root, 'names.json'), JSON.stringify(['acme-chat']));
    git(root, 'config', 'stitchkit.privateNames', 'names.json');
    const names = await readPrivateNames(root);
    expect(names).toMatchObject({ kind: 'listed', names: ['acme-chat'] });
    expect(await inspectTrackedNames(root, ['acme-chat'])).toEqual([
      { file: 'a.ts', line: 2, rule: PRIVATE_NAME_RULE, scope: 'tracked' },
    ]);
  });

  test('a path that names one is found too, a binary file included, as line 0', async () => {
    const root = repository({
      'acme-chat.json': '{}\n',
      'AcmeChat.png': 'binary',
      'ok.md': 'x\n',
    });
    expect(await inspectTrackedNames(root, ['acme-chat'])).toEqual([
      { file: 'AcmeChat.png', line: 0, rule: PRIVATE_NAME_RULE, scope: 'tracked' },
      { file: 'acme-chat.json', line: 0, rule: PRIVATE_NAME_RULE, scope: 'tracked' },
    ]);
  });

  test('a named list that cannot be read, or is not a list, fails instead of passing', async () => {
    const root = repository({ 'a.ts': 'x\n' });
    git(root, 'config', 'stitchkit.privateNames', 'missing.json');
    await expect(readPrivateNames(root)).rejects.toThrow('cannot be read');
    writeFileSync(join(root, 'names.json'), JSON.stringify({ names: 'acme' }));
    git(root, 'config', 'stitchkit.privateNames', 'names.json');
    await expect(readPrivateNames(root)).rejects.toThrow('not a list of names');
  });
});
