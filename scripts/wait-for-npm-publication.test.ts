import { expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitForNpmPublication } from './wait-for-npm-publication';

const quiet = () => spyOn(console, 'warn').mockImplementation(() => undefined);

test('the exact package and version is found, and the registry path is encoded', async () => {
  const urls: string[] = [];
  const result = await waitForNpmPublication('@scope/package', '1.2.3', {
    timeoutMs: 1_000,
    fetchPackage: async (url) => {
      urls.push(url);
      return Response.json({ name: '@scope/package', version: '1.2.3' });
    },
  });
  expect(result).toEqual({ attempts: 1 });
  expect(urls).toEqual(['https://registry.npmjs.org/%40scope%2Fpackage/1.2.3?attempt=1']);
});

test('a version that never appears fails at the deadline with the last registry answer', async () => {
  const warn = quiet();
  try {
    const wait = waitForNpmPublication('@scope/package', '1.2.3', {
      timeoutMs: 60,
      fetchPackage: async () => new Response('', { status: 404 }),
    });
    await expect(wait).rejects.toThrow(
      '@scope/package@1.2.3 did not become available from the public npm registry within 60ms: the registry returned HTTP 404',
    );
  } finally {
    warn.mockRestore();
  }
});

test('a registry that answers with another version is not accepted', async () => {
  const warn = quiet();
  try {
    const wait = waitForNpmPublication('@scope/package', '1.2.3', {
      timeoutMs: 60,
      fetchPackage: async () => Response.json({ name: '@scope/package', version: '1.2.2' }),
    });
    await expect(wait).rejects.toThrow('the registry returned @scope/package@1.2.2');
  } finally {
    warn.mockRestore();
  }
});

test('a stalled registry request is aborted by the remaining deadline', async () => {
  const warn = quiet();
  try {
    const wait = waitForNpmPublication('@scope/package', '1.2.3', {
      timeoutMs: 60,
      fetchPackage: (_url, { signal }) =>
        new Promise<Response>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    });
    await expect(wait).rejects.toThrow('did not become available');
  } finally {
    warn.mockRestore();
  }
});

test('the CLI confirms a visible version and prints usage without arguments', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'stitchkit-publication-cli-'));
  const preload = join(scratch, 'registry.ts');
  writeFileSync(
    preload,
    `Object.defineProperty(globalThis, 'fetch', { value: async () => Response.json({ name: '@scope/package', version: '1.2.3' }) });\n`,
  );
  try {
    const script = `${import.meta.dir}/wait-for-npm-publication.ts`;
    const ok = spawnSync(
      process.execPath,
      ['--preload', preload, script, '@scope/package', '1.2.3'],
      {
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    expect(ok.status).toBe(0);
    expect(ok.stdout.trim()).toBe(
      '@scope/package@1.2.3 is available from the public npm registry',
    );
    const usage = spawnSync(process.execPath, ['--preload', preload, script], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(usage.status).not.toBe(0);
    expect(usage.stderr).toContain(
      'Usage: bun scripts/wait-for-npm-publication.ts <package> <version>',
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
