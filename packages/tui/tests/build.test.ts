import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { terminalNativePlugin, terminalNativeTarget } from '../src/build';

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/**
 * A project whose `@opentui/core` imports two platform packages, neither of
 * them installed — the state of a Mac building for Linux — plus a registry
 * that serves the Linux package as a real tarball.
 */
function project() {
  const root = mkdtempSync(join(tmpdir(), 'tui-build-'));
  roots.push(root);
  const core = join(root, 'node_modules/@opentui/core');
  mkdirSync(core, { recursive: true });
  writeFileSync(
    join(core, 'package.json'),
    JSON.stringify({
      name: '@opentui/core',
      version: '9.9.9',
      type: 'module',
      main: 'index.js',
      optionalDependencies: {
        '@opentui/core-linux-arm64': '9.9.9',
        '@opentui/core-darwin-arm64': '9.9.9',
      },
    }),
  );
  writeFileSync(
    join(core, 'index.js'),
    `export const linux = () => import('@opentui/core-linux-arm64');\nexport const darwin = () => import('@opentui/core-darwin-arm64');\n`,
  );
  writeFileSync(join(root, 'entry.js'), `export { linux, darwin } from '@opentui/core';\n`);
  const staging = join(root, 'staging/package');
  mkdirSync(staging, { recursive: true });
  writeFileSync(
    join(staging, 'index.bun.js'),
    `export default 'linux-arm64-native-marker';\n`,
  );
  writeFileSync(join(staging, 'package.json'), '{"name":"@opentui/core-linux-arm64"}');
  Bun.spawnSync(['tar', '-czf', 'package.tgz', 'package'], {
    cwd: join(root, 'staging'),
  });
  const tarball = readFileSync(join(root, 'staging/package.tgz'));
  const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
  const lock = (value: string) =>
    `{\n  "lockfileVersion": 1,\n  "packages": {\n    "@opentui/core-linux-arm64": ["@opentui/core-linux-arm64@9.9.9", "", { "os": "linux", "cpu": "arm64" }, "${value}"],\n  },\n}\n`;
  writeFileSync(join(root, 'bun.lock'), lock(integrity));
  const requests: string[] = [];
  const registry = (body: Uint8Array) =>
    (async (url: string | URL | Request) => {
      requests.push(String(url));
      return new Response(Buffer.from(body));
    }) as typeof fetch;
  return { root, tarball, requests, registry, lock };
}

async function bundle(root: string, plugin: Bun.BunPlugin): Promise<string> {
  const result = await Bun.build({
    entrypoints: [join(root, 'entry.js')],
    target: 'bun',
    plugins: [plugin],
    throw: false,
  });
  if (!result.success) throw new Error(result.logs.map((log) => log.message).join('\n'));
  return (await Promise.all(result.outputs.map((output) => output.text()))).join('\n');
}

describe('the OpenTUI native package for another platform', () => {
  test('comes from the registry, verified against bun.lock; other platforms throw', async () => {
    const p = project();
    const code = await bundle(
      p.root,
      terminalNativePlugin({
        target: 'bun-linux-arm64',
        lockfile: join(p.root, 'bun.lock'),
        cacheDirectory: join(p.root, 'cache'),
        fetch: p.registry(p.tarball),
      }),
    );
    expect(p.requests).toEqual([
      'https://registry.npmjs.org/@opentui/core-linux-arm64/-/core-linux-arm64-9.9.9.tgz',
    ]);
    expect(code).toContain('linux-arm64-native-marker');
    expect(code).toContain(
      '@opentui/core-darwin-arm64 is not in this executable: it was built for @opentui/core-linux-arm64',
    );
  });

  test('refuses a tarball that does not match the lockfile', async () => {
    const p = project();
    const tampered = new Uint8Array(p.tarball);
    tampered[100] = (tampered[100] ?? 0) ^ 0xff;
    await expect(
      bundle(
        p.root,
        terminalNativePlugin({
          target: 'bun-linux-arm64',
          lockfile: join(p.root, 'bun.lock'),
          cacheDirectory: join(p.root, 'cache'),
          fetch: p.registry(tampered),
        }),
      ),
    ).rejects.toThrow(/does not match bun\.lock/);
  });

  test('refuses a lockfile without the package instead of guessing', async () => {
    const p = project();
    writeFileSync(join(p.root, 'bun.lock'), '{ "lockfileVersion": 1, "packages": {} }');
    await expect(
      bundle(
        p.root,
        terminalNativePlugin({
          target: 'bun-linux-arm64',
          lockfile: join(p.root, 'bun.lock'),
          cacheDirectory: join(p.root, 'cache'),
          fetch: p.registry(p.tarball),
        }),
      ),
    ).rejects.toThrow(/records no integrity for @opentui\/core-linux-arm64@9\.9\.9/);
    expect(p.requests).toEqual([]);
  });

  test('reads compile targets, and refuses musl, which OpenTUI picks at run time', () => {
    expect(terminalNativeTarget('bun-linux-x64').packageName).toBe('@opentui/core-linux-x64');
    expect(terminalNativeTarget('bun-darwin-arm64-modern').packageName).toBe(
      '@opentui/core-darwin-arm64',
    );
    expect(terminalNativeTarget('bun-windows-x64').packageName).toBe(
      '@opentui/core-win32-x64',
    );
    expect(() => terminalNativeTarget('bun-linux-x64-musl')).toThrow(/OPENTUI_LIBC/);
  });
});
