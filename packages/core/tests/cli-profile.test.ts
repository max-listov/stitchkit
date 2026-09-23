/**
 * Named credential profiles.
 *
 * The rule under test is one sentence and it is the whole primitive: a profile
 * named explicitly and not found is a refusal. The convenient alternative — "the
 * name is unknown but exactly one profile exists, use it" — is correct only
 * while a single profile exists, and is a wrong-environment command the day a
 * second appears, with nothing in the output to say so.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { CliProfileError, createCliProfileStore } from '../src/tools/cli/profile';

const SCHEMA = z.object({ url: z.url(), token: z.string().min(1) });
const directories: string[] = [];

function storeIn(announce?: (line: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'stitchkit-profiles-'));
  directories.push(directory);
  return createCliProfileStore({
    directory,
    schema: SCHEMA,
    createHint: (name, path) => `write ${path} with {"url","token"} for "${name}"`,
    ...(announce && { announce }),
  });
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const DEV = { url: 'https://dev.example.com', token: 'dev-key' };
const PROD = { url: 'https://prod.example.com', token: 'prod-key' };

describe('a named profile is never substituted', () => {
  test('naming a profile that does not exist fails, and the message names the path', () => {
    const store = storeIn();
    store.write('dev', DEV);
    let thrown: unknown;
    try {
      store.resolve('prod');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CliProfileError);
    expect(String(thrown)).toContain(store.pathFor('prod'));
    // The dangerous answer, spelled out: the only configured profile is never
    // the answer to a name that was asked for and missed.
    expect(String(thrown)).not.toContain('dev-key');
  });

  test('not naming one, with a single profile present, succeeds and says which was taken', () => {
    const announced: string[] = [];
    const store = storeIn((line) => announced.push(line));
    store.write('dev', DEV);
    const resolved = store.resolve(undefined);
    expect(resolved.name).toBe('dev');
    expect(resolved.substituted).toBe(true);
    expect(resolved.value).toEqual(DEV);
    expect(announced).toHaveLength(1);
    expect(announced[0]).toContain('dev');
  });

  test('with two profiles present, an unknown name never resolves to either', () => {
    const store = storeIn();
    store.write('dev', DEV);
    store.write('prod', PROD);
    expect(() => store.resolve('staging')).toThrow(CliProfileError);
    expect(() => store.resolve(undefined)).toThrow(/several profiles/);
    expect(store.resolve('prod').value).toEqual(PROD);
    expect(store.resolve('prod').substituted).toBe(false);
  });

  test('no profile at all names the directory and how to create one', () => {
    const store = storeIn();
    expect(() => store.resolve(undefined)).toThrow(/no profile is configured/);
    expect(() => store.resolve(undefined)).toThrow(/write /);
  });

  test('a profile file is written 0600 and an overwrite keeps it there', () => {
    const store = storeIn();
    const path = store.write('dev', DEV);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    store.write('dev', PROD);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(store.read('dev')).toEqual(PROD);
  });

  test('a world-readable profile is refused, with the command that fixes it', () => {
    const store = storeIn();
    const path = store.pathFor('dev');
    writeFileSync(path, JSON.stringify(DEV), { mode: 0o644 });
    expect(() => store.read('dev')).toThrow(/chmod 600/);
  });

  test('a profile that does not match the schema is refused by name and field', () => {
    const store = storeIn();
    writeFileSync(store.pathFor('dev'), JSON.stringify({ url: 'not-a-url' }), { mode: 0o600 });
    expect(() => store.read('dev')).toThrow(/profile "dev"/);
  });

  test('list names the configured profiles, in order', () => {
    const store = storeIn();
    store.write('prod', PROD);
    store.write('dev', DEV);
    expect(store.list()).toEqual(['dev', 'prod']);
  });

  test('a profile name that is a path is refused rather than resolved', () => {
    const store = storeIn();
    expect(() => store.resolve('../../etc/passwd')).toThrow(/not a usable profile name/);
  });
});
