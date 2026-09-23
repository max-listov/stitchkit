/**
 * Getting the binary onto a machine that has nothing, and keeping it current.
 *
 * Three traps a consumer met building this by hand, each one asserted here:
 * the installer cannot parse the manifest (no `jq` on a fresh machine), the
 * replace must be a rename rather than a write, and the digest must cover the
 * decompressed bytes — the file that is actually executed.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { renderCliInstaller } from '../src/tools/cli/installer';
import {
  assertCliPublishable,
  type CliBuildManifest,
  CliBuildManifestSchema,
  currentCliBuildTarget,
  formatCliBuildStamp,
  selectCliBuildAsset,
} from '../src/tools/cli/manifest';
import { applyCliUpdate, checkCliUpdate, compareCliVersions } from '../src/tools/cli/update';

const BINARY = Buffer.from('#!/bin/sh\necho hello\n');
const DIGEST = createHash('sha256').update(BINARY).digest('hex');
const GZIPPED = gzipSync(BINARY);

const servers: Array<{ stop: () => Promise<void> | void }> = [];
const directories: string[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) void server.stop();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'stitchkit-dist-'));
  directories.push(directory);
  return directory;
}

/** Serve a manifest and one gzipped asset, so the whole path is real bytes. */
function startDistribution(overrides: Partial<CliBuildManifest> = {}) {
  const target = currentCliBuildTarget();
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const { pathname } = new URL(request.url);
      if (pathname === '/asset.gz') {
        return new Response(GZIPPED, { headers: { 'content-type': 'application/gzip' } });
      }
      const manifest: CliBuildManifest = {
        name: 'app',
        version: '1.2.0',
        commit: 'a'.repeat(40),
        builtAt: '2026-09-16T00:00:00.000Z',
        assets: [
          {
            ...target,
            url: `http://127.0.0.1:${server.port}/asset.gz`,
            compression: 'gzip',
            size: BINARY.length,
            sha256: DIGEST,
          },
        ],
        ...overrides,
      };
      return Response.json(manifest);
    },
  });
  servers.push(server);
  return {
    manifestUrl: `http://127.0.0.1:${server.port}/manifest.json`,
    assetUrl: `http://127.0.0.1:${server.port}/asset.gz`,
    target,
  };
}

describe('build manifest', () => {
  test('an asset digest describes the decompressed bytes, and the schema says so', () => {
    const parsed = CliBuildManifestSchema.safeParse({
      name: 'app',
      version: '1.0.0',
      commit: 'abc',
      builtAt: '2026-09-16T00:00:00.000Z',
      assets: [
        { platform: 'linux', arch: 'x64', url: 'https://x/a', size: 5, sha256: 'nothex' },
      ],
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain('sha256');
  });

  test('republishing a version from a different commit is refused', () => {
    const published: CliBuildManifest = {
      name: 'app',
      version: '1.2.0',
      commit: 'a'.repeat(40),
      builtAt: '2026-09-16T00:00:00.000Z',
      assets: [],
    };
    expect(() =>
      assertCliPublishable(published, { ...published, commit: 'b'.repeat(40) }),
    ).toThrow(/refusing to republish/);
    // Same commit twice is an idempotent republish, and a new version is fine.
    expect(() => assertCliPublishable(published, published)).not.toThrow();
    expect(() =>
      assertCliPublishable(published, { ...published, version: '1.2.1' }),
    ).not.toThrow();
  });

  test('the build stamp says what the binary is rather than leaving it to be inferred', () => {
    expect(
      formatCliBuildStamp(
        { version: '1.2.0', commit: 'abcdef1234567890', builtAt: '2026-09-16T00:00:00.000Z' },
        'app',
      ),
    ).toBe('app 1.2.0 (abcdef123456, built 2026-09-16T00:00:00.000Z)');
  });

  test('an unpublished target selects nothing rather than the wrong binary', () => {
    const manifest: CliBuildManifest = {
      name: 'app',
      version: '1.0.0',
      commit: 'a',
      builtAt: '2026-09-16T00:00:00.000Z',
      assets: [
        {
          platform: 'linux',
          arch: 'x64',
          url: 'https://x/a',
          compression: 'none',
          size: 1,
          sha256: '0'.repeat(64),
        },
      ],
    };
    expect(
      selectCliBuildAsset(manifest, { platform: 'darwin', arch: 'arm64' }),
    ).toBeUndefined();
    expect(selectCliBuildAsset(manifest, { platform: 'linux', arch: 'x64' })?.url).toBe(
      'https://x/a',
    );
  });
});

describe('generated installer', () => {
  const served = () => {
    const manifest: CliBuildManifest = {
      name: 'app',
      version: '1.2.0',
      commit: 'a'.repeat(40),
      builtAt: '2026-09-16T00:00:00.000Z',
      assets: [
        {
          platform: 'linux',
          arch: 'x64',
          url: 'https://example.com/app.gz',
          compression: 'gzip',
          size: BINARY.length,
          sha256: DIGEST,
        },
      ],
    };
    const asset = manifest.assets[0];
    if (!asset) throw new Error('no asset');
    return renderCliInstaller({ manifest, asset, binaryName: 'app' });
  };

  test('it parses no JSON — the URL and digest are already substituted', () => {
    const script = served();
    expect(script).toContain('https://example.com/app.gz');
    expect(script).toContain(DIGEST);
    // Comments may mention jq; the executable lines must not invoke it, nor
    // fetch a manifest to read.
    const commands = script
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(commands).not.toContain('jq');
    expect(commands).not.toContain('manifest');
  });

  test('the last step is a rename, never a write over the live binary', () => {
    const script = served();
    expect(script).toContain('mv "$tmp/binary" "$dir/$binary"');
    expect(script).not.toMatch(/>\s*"\$dir\/\$binary"/);
  });

  test('the digest is checked after decompression, not on the transferred archive', () => {
    const script = served();
    const decompress = script.indexOf('gzip -dc');
    const check = script.indexOf('digest "$tmp/binary"');
    expect(decompress).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(decompress);
  });

  test('omitting the asset renders one script that selects the target itself', () => {
    const manifest: CliBuildManifest = {
      name: 'app',
      version: '1.2.0',
      commit: 'a'.repeat(40),
      builtAt: '2026-09-16T00:00:00.000Z',
      assets: [
        {
          platform: 'linux',
          arch: 'x64',
          url: 'https://example.com/app-linux-x64.gz',
          compression: 'gzip',
          size: BINARY.length,
          sha256: DIGEST,
        },
        {
          platform: 'darwin',
          arch: 'arm64',
          url: 'https://example.com/app-darwin-arm64.gz',
          compression: 'gzip',
          size: BINARY.length,
          sha256: DIGEST,
        },
      ],
    };
    const script = renderCliInstaller({ manifest, binaryName: 'app' });
    // The mapping the publisher would otherwise write from memory, every time.
    expect(script).toContain('x86_64|amd64) arch=x64');
    expect(script).toContain('aarch64|arm64) arch=arm64');
    expect(script).toContain('linux/x64)');
    expect(script).toContain('darwin/arm64)');
    // An unpublished combination is named, with what is published beside it.
    expect(script).toContain('no published build for $platform/$arch');
    expect(script).toContain('linux/x64, darwin/arm64');
    // Still no JSON on the wire.
    const commands = script
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(commands).not.toContain('jq');
  });

  test('the dispatching script installs the target it is run on', async () => {
    const directory = scratch();
    const assets = Bun.serve({ port: 0, fetch: () => new Response(GZIPPED) });
    servers.push(assets);
    const here = currentCliBuildTarget();
    const manifest: CliBuildManifest = {
      name: 'app',
      version: '1.2.0',
      commit: 'a'.repeat(40),
      builtAt: '2026-09-16T00:00:00.000Z',
      assets: [
        {
          platform: 'plan9',
          arch: 'sparc',
          url: 'http://127.0.0.1:1/never.gz',
          compression: 'gzip',
          size: 1,
          sha256: '0'.repeat(64),
        },
        {
          ...here,
          url: `http://127.0.0.1:${assets.port}/app.gz`,
          compression: 'gzip',
          size: BINARY.length,
          sha256: DIGEST,
        },
      ],
    };
    const script = join(directory, 'install.sh');
    writeFileSync(script, renderCliInstaller({ manifest, binaryName: 'app' }));
    const install = join(directory, 'bin');
    const run = Bun.spawn({
      cmd: ['sh', script],
      env: { ...process.env, INSTALL_DIR: install },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await run.exited).toBe(0);
    expect(readFileSync(join(install, 'app'))).toEqual(BINARY);
  });

  test('a manifest with no assets is refused rather than rendered', () => {
    expect(() =>
      renderCliInstaller({
        manifest: {
          name: 'app',
          version: '1.0.0',
          commit: 'a',
          builtAt: '2026-09-16T00:00:00.000Z',
          assets: [],
        },
      }),
    ).toThrow(/installs nothing/);
  });

  test('it actually installs, run by a real shell', async () => {
    const directory = scratch();
    const assets = Bun.serve({
      port: 0,
      fetch: () => new Response(GZIPPED),
    });
    servers.push(assets);
    const manifest: CliBuildManifest = {
      name: 'app',
      version: '1.2.0',
      commit: 'a'.repeat(40),
      builtAt: '2026-09-16T00:00:00.000Z',
      assets: [
        {
          platform: 'linux',
          arch: 'x64',
          url: `http://127.0.0.1:${assets.port}/app.gz`,
          compression: 'gzip',
          size: BINARY.length,
          sha256: DIGEST,
        },
      ],
    };
    const asset = manifest.assets[0];
    if (!asset) throw new Error('no asset');
    const script = join(directory, 'install.sh');
    writeFileSync(script, renderCliInstaller({ manifest, asset, binaryName: 'app' }));
    const install = join(directory, 'bin');
    const run = Bun.spawn({
      cmd: ['sh', script],
      env: { ...process.env, INSTALL_DIR: install },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const code = await run.exited;
    expect(code).toBe(0);
    const installed = join(install, 'app');
    expect(readFileSync(installed)).toEqual(BINARY);
    expect(statSync(installed).mode & 0o111).toBeGreaterThan(0);
  });

  test('a tampered asset is refused and nothing is installed', async () => {
    const directory = scratch();
    const assets = Bun.serve({
      port: 0,
      fetch: () => new Response(gzipSync(Buffer.from('evil'))),
    });
    servers.push(assets);
    const manifest: CliBuildManifest = {
      name: 'app',
      version: '1.2.0',
      commit: 'a'.repeat(40),
      builtAt: '2026-09-16T00:00:00.000Z',
      assets: [
        {
          platform: 'linux',
          arch: 'x64',
          url: `http://127.0.0.1:${assets.port}/app.gz`,
          compression: 'gzip',
          size: BINARY.length,
          sha256: DIGEST,
        },
      ],
    };
    const asset = manifest.assets[0];
    if (!asset) throw new Error('no asset');
    const script = join(directory, 'install.sh');
    writeFileSync(script, renderCliInstaller({ manifest, asset, binaryName: 'app' }));
    const install = join(directory, 'bin');
    const previous = join(install, 'app');
    Bun.spawnSync({ cmd: ['mkdir', '-p', install] });
    writeFileSync(previous, 'the version that already worked\n');
    const run = Bun.spawn({
      cmd: ['sh', script],
      env: { ...process.env, INSTALL_DIR: install },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await run.exited).not.toBe(0);
    expect(await new Response(run.stderr).text()).toContain('checksum mismatch');
    expect(readFileSync(previous, 'utf8')).toBe('the version that already worked\n');
  });
});

describe('update check and apply', () => {
  test('a newer published version is reported with the asset for this machine', async () => {
    const { manifestUrl, target } = startDistribution();
    const check = await checkCliUpdate({
      manifestUrl,
      currentVersion: '1.1.0',
      allowPrivateHosts: true,
      target,
    });
    expect(check.status).toBe('outdated');
    if (check.status !== 'outdated') throw new Error('expected outdated');
    expect(check.version).toBe('1.2.0');
    expect(check.asset?.sha256).toBe(DIGEST);
  });

  test('the same version is current, and a newer local build is not "outdated"', async () => {
    const { manifestUrl } = startDistribution();
    expect(
      (await checkCliUpdate({ manifestUrl, currentVersion: '1.2.0', allowPrivateHosts: true }))
        .status,
    ).toBe('current');
    expect(
      (await checkCliUpdate({ manifestUrl, currentVersion: '1.3.0', allowPrivateHosts: true }))
        .status,
    ).toBe('current');
  });

  test('an unreachable manifest is unknown, never current — and never throws', async () => {
    const check = await checkCliUpdate({
      manifestUrl: 'http://127.0.0.1:1/manifest.json',
      currentVersion: '1.0.0',
      timeoutMs: 250,
      allowPrivateHosts: true,
    });
    expect(check.status).toBe('unknown');
  });

  test('inside the interval the check is skipped without a request', async () => {
    const now = Date.UTC(2026, 8, 16, 12);
    const check = await checkCliUpdate({
      // A URL that would fail if it were ever fetched.
      manifestUrl: 'http://127.0.0.1:1/manifest.json',
      currentVersion: '1.0.0',
      now,
      lastCheckedAt: now - 60_000,
      intervalMs: 3_600_000,
    });
    expect(check.status).toBe('skipped');
  });

  test('versions that cannot be compared are unknown rather than guessed', () => {
    expect(compareCliVersions('1.2.0', '1.10.0')).toBe(-1);
    expect(compareCliVersions('1.2.0-rc.1', '1.2.0')).toBe(-1);
    expect(compareCliVersions('1.2.0', '1.2.0')).toBe(0);
    expect(compareCliVersions('nightly', '1.2.0')).toBeUndefined();
  });

  test('apply verifies the decompressed digest and replaces by rename', async () => {
    const { assetUrl, target } = startDistribution();
    const directory = scratch();
    const installed = join(directory, 'app');
    writeFileSync(installed, 'old\n', { mode: 0o755 });
    const applied = await applyCliUpdate({
      asset: {
        ...target,
        url: assetUrl,
        compression: 'gzip',
        size: BINARY.length,
        sha256: DIGEST,
      },
      targetPath: installed,
      allowPrivateHosts: true,
    });
    expect(applied.sha256).toBe(DIGEST);
    expect(readFileSync(installed)).toEqual(BINARY);
    expect(statSync(installed).mode & 0o111).toBeGreaterThan(0);
  });

  test('a digest that does not match leaves the installed binary untouched', async () => {
    const { assetUrl, target } = startDistribution();
    const directory = scratch();
    const installed = join(directory, 'app');
    writeFileSync(installed, 'the version that already worked\n', { mode: 0o755 });
    chmodSync(installed, 0o755);
    await expect(
      applyCliUpdate({
        asset: {
          ...target,
          url: assetUrl,
          compression: 'gzip',
          size: BINARY.length,
          sha256: 'f'.repeat(64),
        },
        targetPath: installed,
        allowPrivateHosts: true,
      }),
    ).rejects.toThrow(/digest/);
    expect(readFileSync(installed, 'utf8')).toBe('the version that already worked\n');
  });

  test('a truncated asset is refused by size before the digest is even considered', async () => {
    const { assetUrl, target } = startDistribution();
    const directory = scratch();
    const installed = join(directory, 'app');
    writeFileSync(installed, 'old\n', { mode: 0o755 });
    await expect(
      applyCliUpdate({
        asset: {
          ...target,
          url: assetUrl,
          compression: 'gzip',
          size: BINARY.length + 10,
          sha256: DIGEST,
        },
        targetPath: installed,
        allowPrivateHosts: true,
      }),
    ).rejects.toThrow(/manifest says/);
    expect(readFileSync(installed, 'utf8')).toBe('old\n');
  });
});
