/*
 * Who built the binary, and the way back if it is wrong.
 *
 * The asset digest proves the bytes that arrived are the bytes the manifest
 * named. It cannot prove who named them: the manifest and the assets come from
 * one origin, so whoever replaces one replaces the other. Authorship needs a key
 * the build carries.
 *
 * And the schema stripped what it did not know, so a signature published in the
 * same document never reached the caller at all — a signed install had to fetch
 * the manifest a second time and parse it twice to see its own proof.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash, generateKeyPairSync } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  assertCliPublishable,
  type CliBuildManifest,
  CliBuildManifestSchema,
  currentCliBuildTarget,
} from '../src/tools/cli-manifest';
import {
  type CliTrustRoot,
  signCliManifest,
  verifyCliManifest,
} from '../src/tools/cli-signature';
import { applyCliUpdate, checkCliUpdate, rollbackCliUpdate } from '../src/tools/cli-update';

const BINARY = Buffer.from('#!/bin/sh\necho new\n');
const DIGEST = createHash('sha256').update(BINARY).digest('hex');
const GZIPPED = gzipSync(BINARY);
const OLD_BINARY = Buffer.from('#!/bin/sh\necho old\n');
const OLD_DIGEST = createHash('sha256').update(OLD_BINARY).digest('hex');

const servers: Array<{ stop: () => void }> = [];
const directories: string[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'stitchkit-signed-'));
  directories.push(directory);
  return directory;
}

const keys = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');

function publicKeyBase64(key: typeof keys.publicKey): string {
  return key.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');
}

const trust: CliTrustRoot = { keys: { 'release-2026': publicKeyBase64(keys.publicKey) } };
const wrongTrust: CliTrustRoot = {
  keys: { 'release-2026': publicKeyBase64(other.publicKey) },
};

function manifestFor(
  assetUrl: string,
  overrides: Partial<CliBuildManifest> = {},
): CliBuildManifest {
  return {
    name: 'app',
    version: '1.2.0',
    commit: 'a'.repeat(40),
    builtAt: '2026-09-16T00:00:00.000Z',
    assets: [
      {
        ...currentCliBuildTarget(),
        url: assetUrl,
        compression: 'gzip',
        size: BINARY.length,
        sha256: DIGEST,
      },
    ],
    ...overrides,
  };
}

/** Serves the manifest and the asset, and counts what was actually fetched. */
function startDistribution(shape: (assetUrl: string) => CliBuildManifest) {
  const fetched: string[] = [];
  // The port is read back after `serve` returns, so the handler closes over a
  // number rather than over the server it belongs to — a self-reference the
  // checker cannot type.
  let port = 0;
  const server = Bun.serve({
    port: 0,
    fetch: (request): Response => {
      const { pathname } = new URL(request.url);
      fetched.push(pathname);
      if (pathname === '/asset.gz') return new Response(GZIPPED);
      return Response.json(shape(`http://127.0.0.1:${port}/asset.gz`));
    },
  });
  port = server.port ?? 0;
  servers.push(server);
  return {
    manifestUrl: `http://127.0.0.1:${port}/manifest.json`,
    assetUrl: `http://127.0.0.1:${port}/asset.gz`,
    fetched,
  };
}

describe('a signature survives the schema and decides before the download', () => {
  test('the signature reaches the caller instead of being stripped', async () => {
    const { manifestUrl } = startDistribution((url) => {
      const manifest = manifestFor(url);
      return {
        ...manifest,
        signature: signCliManifest(manifest, {
          keyId: 'release-2026',
          privateKey: keys.privateKey,
        }),
      };
    });
    const check = await checkCliUpdate({
      manifestUrl,
      currentVersion: '1.0.0',
      trust,
      allowPrivateHosts: true,
    });
    // Before this, `checkCliUpdate` handed back a parsed manifest with no
    // `signature` at all, so a signed install could not use it and fetched the
    // document a second time to parse it loosely.
    expect(check.status).toBe('outdated');
    if (check.status !== 'outdated') throw new Error('unreachable');
    expect(check.manifest.signature?.keyId).toBe('release-2026');
    expect(check.signature).toBe('valid');
  });

  test('a build with no pinned key keeps updating, and says nothing was checked', async () => {
    const { manifestUrl } = startDistribution((url) => manifestFor(url));
    const check = await checkCliUpdate({
      manifestUrl,
      currentVersion: '1.0.0',
      allowPrivateHosts: true,
    });
    expect(check.status).toBe('outdated');
    // `unenforced`, not silence. A check that never ran must not read as a
    // check that passed.
    expect(check.status === 'outdated' && check.signature).toBe('unenforced');
  });

  test('an unsigned manifest under a pinned key does not become an update', async () => {
    const { manifestUrl } = startDistribution((url) => manifestFor(url));
    const check = await checkCliUpdate({
      manifestUrl,
      currentVersion: '1.0.0',
      trust,
      allowPrivateHosts: true,
    });
    expect(check.status).toBe('unknown');
    expect(check.status === 'unknown' && check.reason).toContain('missing');
  });

  test('a signature from another key is refused by name', async () => {
    const { manifestUrl } = startDistribution((url) => {
      const manifest = manifestFor(url);
      return {
        ...manifest,
        signature: signCliManifest(manifest, {
          keyId: 'release-2026',
          privateKey: other.privateKey,
        }),
      };
    });
    const check = await checkCliUpdate({
      manifestUrl,
      currentVersion: '1.0.0',
      trust,
      allowPrivateHosts: true,
    });
    expect(check.status === 'unknown' && check.reason).toContain('invalid');
  });

  test('a signature whose key id nobody pinned is distinguished from a bad one', async () => {
    const { manifestUrl } = startDistribution((url) => {
      const manifest = manifestFor(url);
      return {
        ...manifest,
        signature: signCliManifest(manifest, {
          keyId: 'unknown-2020',
          privateKey: keys.privateKey,
        }),
      };
    });
    const check = await checkCliUpdate({
      manifestUrl,
      currentVersion: '1.0.0',
      trust,
      allowPrivateHosts: true,
    });
    expect(check.status === 'unknown' && check.reason).toContain('unknown-key');
  });

  test('changing an asset digest invalidates the signature — the chain closes on the file', async () => {
    const manifest = manifestFor('https://example.invalid/a');
    const signature = signCliManifest(manifest, {
      keyId: 'release-2026',
      privateKey: keys.privateKey,
    });
    const tampered: CliBuildManifest = {
      ...manifest,
      assets: [
        {
          ...manifest.assets[0],
          sha256: 'f'.repeat(64),
        } as CliBuildManifest['assets'][number],
      ],
    };
    expect(verifyCliManifest(manifest, signature, trust)).toBe('valid');
    expect(verifyCliManifest(tampered, signature, trust)).toBe('invalid');
  });

  test('moving an asset to a new URL does not invalidate it', async () => {
    // Where a file is served from is the publisher's business; what it contains
    // is what was proven.
    const manifest = manifestFor('https://example.invalid/a');
    const signature = signCliManifest(manifest, {
      keyId: 'release-2026',
      privateKey: keys.privateKey,
    });
    const moved: CliBuildManifest = {
      ...manifest,
      assets: [
        {
          ...manifest.assets[0],
          url: 'https://cdn.invalid/b',
        } as CliBuildManifest['assets'][number],
      ],
    };
    expect(verifyCliManifest(moved, signature, trust)).toBe('valid');
  });

  test('a wrong key refuses BEFORE anything is downloaded', async () => {
    const { manifestUrl, assetUrl, fetched } = startDistribution((url) => {
      const manifest = manifestFor(url);
      return {
        ...manifest,
        signature: signCliManifest(manifest, {
          keyId: 'release-2026',
          privateKey: keys.privateKey,
        }),
      };
    });
    const check = await checkCliUpdate({
      manifestUrl,
      currentVersion: '1.0.0',
      allowPrivateHosts: true,
    });
    if (check.status !== 'outdated' || !check.asset) throw new Error('expected an asset');
    fetched.length = 0;
    await expect(
      applyCliUpdate({
        asset: check.asset,
        manifest: check.manifest,
        trust: wrongTrust,
        targetPath: join(scratch(), 'app'),
        allowPrivateHosts: true,
      }),
    ).rejects.toThrow('manifest signature invalid');
    // The point of "before": nothing reached the machine to be cleaned up.
    expect(fetched).toEqual([]);
    expect(assetUrl).toContain('/asset.gz');
  });

  test('an asset the signed manifest does not name is refused', async () => {
    const { manifestUrl, fetched } = startDistribution((url) => {
      const manifest = manifestFor(url);
      return {
        ...manifest,
        signature: signCliManifest(manifest, {
          keyId: 'release-2026',
          privateKey: keys.privateKey,
        }),
      };
    });
    const check = await checkCliUpdate({
      manifestUrl,
      currentVersion: '1.0.0',
      trust,
      allowPrivateHosts: true,
    });
    if (check.status !== 'outdated' || !check.asset) throw new Error('expected an asset');
    fetched.length = 0;
    await expect(
      applyCliUpdate({
        asset: { ...check.asset, sha256: 'b'.repeat(64) },
        manifest: check.manifest,
        trust,
        targetPath: join(scratch(), 'app'),
        allowPrivateHosts: true,
      }),
    ).rejects.toThrow('not one the signed manifest names');
    expect(fetched).toEqual([]);
  });

  test('a trust root with no manifest is a configuration error, not a silent pass', async () => {
    await expect(
      applyCliUpdate({
        asset: {
          ...currentCliBuildTarget(),
          url: 'https://example.invalid/a',
          compression: 'none',
          size: 1,
          sha256: 'a'.repeat(64),
        },
        trust,
        targetPath: join(scratch(), 'app'),
      }),
    ).rejects.toThrow('needs the manifest');
  });
});

describe('the build being replaced is kept, and can be put back', () => {
  async function install(directory: string, backupPath?: string) {
    const { manifestUrl } = startDistribution((url) => manifestFor(url));
    const check = await checkCliUpdate({
      manifestUrl,
      currentVersion: '1.0.0',
      allowPrivateHosts: true,
    });
    if (check.status !== 'outdated' || !check.asset) throw new Error('expected an asset');
    return applyCliUpdate({
      asset: check.asset,
      targetPath: join(directory, 'app'),
      allowPrivateHosts: true,
      ...(backupPath !== undefined && { backupPath }),
    });
  }

  test('the previous bytes are kept, runnable, and their digest is reported', async () => {
    const directory = scratch();
    const target = join(directory, 'app');
    writeFileSync(target, OLD_BINARY, { mode: 0o755 });
    chmodSync(target, 0o755);

    const applied = await install(directory, join(directory, 'app.previous'));
    expect(readFileSync(target)).toEqual(BINARY);
    expect(applied.backupSha256).toBe(OLD_DIGEST);
    expect(readFileSync(join(directory, 'app.previous'))).toEqual(OLD_BINARY);
    // A backup that cannot be executed is not a way back.
    expect(statSync(join(directory, 'app.previous')).mode & 0o111).not.toBe(0);
  });

  test('a first install has nothing to keep, and that is not a failure', async () => {
    const directory = scratch();
    const applied = await install(directory, join(directory, 'app.previous'));
    expect(applied.backupPath).toBeUndefined();
    expect(existsSync(join(directory, 'app.previous'))).toBe(false);
  });

  test('rollback restores the kept build', async () => {
    const directory = scratch();
    const target = join(directory, 'app');
    writeFileSync(target, OLD_BINARY, { mode: 0o755 });
    const applied = await install(directory, join(directory, 'app.previous'));
    expect(readFileSync(target)).toEqual(BINARY);

    rollbackCliUpdate({
      targetPath: target,
      backupPath: join(directory, 'app.previous'),
      expectedSha256: applied.backupSha256 ?? '',
    });
    expect(readFileSync(target)).toEqual(OLD_BINARY);
    expect(statSync(target).mode & 0o111).not.toBe(0);
  });

  test('a backup whose digest moved is refused rather than installed', async () => {
    const directory = scratch();
    const target = join(directory, 'app');
    writeFileSync(target, OLD_BINARY, { mode: 0o755 });
    const applied = await install(directory, join(directory, 'app.previous'));
    writeFileSync(join(directory, 'app.previous'), Buffer.from('tampered'), { mode: 0o755 });

    expect(() =>
      rollbackCliUpdate({
        targetPath: target,
        backupPath: join(directory, 'app.previous'),
        expectedSha256: applied.backupSha256 ?? '',
      }),
    ).toThrow('does not match the expected');
    // The tool on the PATH is untouched by a refused rollback.
    expect(readFileSync(target)).toEqual(BINARY);
  });

  test('rolling back to a backup that is not there says so', () => {
    const directory = scratch();
    expect(() =>
      rollbackCliUpdate({
        targetPath: join(directory, 'app'),
        backupPath: join(directory, 'missing'),
        expectedSha256: 'a'.repeat(64),
      }),
    ).toThrow('no backup at');
  });
});

describe('a version is a promise across every channel it was published to', () => {
  const at = (version: string, commit: string): CliBuildManifest => ({
    name: 'app',
    version,
    commit,
    builtAt: '2026-09-16T00:00:00.000Z',
    assets: [],
  });

  test('one manifest still works exactly as before', () => {
    expect(() => assertCliPublishable(at('1.2.3', 'a'), at('1.2.3', 'b'))).toThrow(
      'already published from commit a',
    );
    expect(() => assertCliPublishable(at('1.2.3', 'a'), at('1.2.4', 'b'))).not.toThrow();
  });

  test('a republish is caught when the earlier one went to another channel', () => {
    // The trap the single argument set: a publisher with two tracks calls this
    // with the manifest of the track being published, and the beta that already
    // carries 1.2.3 from a different commit is invisible. Everyone who installed
    // that beta is told they are current, forever.
    const beta = at('1.2.3', 'a'.repeat(40));
    const stable = at('1.1.0', 'c'.repeat(40));
    expect(() => assertCliPublishable([stable, beta], at('1.2.3', 'b'.repeat(40)))).toThrow(
      'already published from commit',
    );
  });

  test('the same commit republished to a second channel is allowed', () => {
    const beta = at('1.2.3', 'a'.repeat(40));
    expect(() => assertCliPublishable([beta], at('1.2.3', 'a'.repeat(40)))).not.toThrow();
  });

  test('an empty history publishes anything', () => {
    expect(() => assertCliPublishable([], at('1.0.0', 'a'))).not.toThrow();
    expect(() => assertCliPublishable(undefined, at('1.0.0', 'a'))).not.toThrow();
  });
});

describe('the schema keeps what it is given', () => {
  test('a manifest without a signature still parses', () => {
    const parsed = CliBuildManifestSchema.safeParse(manifestFor('https://x/a'));
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.signature).toBeUndefined();
  });

  test('a malformed signature is a malformed manifest, not a stripped field', () => {
    const parsed = CliBuildManifestSchema.safeParse({
      ...manifestFor('https://x/a'),
      signature: { algorithm: 'rsa', keyId: 'k', signature: 'x' },
    });
    expect(parsed.success).toBe(false);
  });
});
