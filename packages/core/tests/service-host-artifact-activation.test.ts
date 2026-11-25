import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ARTIFACT_MANIFEST_FILENAME,
  ArtifactVerificationError,
  activateVersionedArtifact,
  rollbackVersionedArtifact,
} from '../src/entrypoints/service-host';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stitchkit-artifact-act-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function sha256(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function buildRelease(
  dir: string,
  version: string,
  files: readonly { path: string; content: string; executable?: boolean }[],
): void {
  mkdirSync(dir, { recursive: true });
  const entries = files.map((file) => {
    const abs = join(dir, file.path);
    mkdirSync(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
    writeFileSync(abs, file.content);
    chmodSync(abs, file.executable ? 0o755 : 0o644);
    const bytes = new TextEncoder().encode(file.content);
    return {
      path: file.path,
      sha256: sha256(bytes),
      size: bytes.byteLength,
      ...(file.executable !== undefined ? { executable: file.executable } : {}),
    };
  });
  writeFileSync(
    join(dir, ARTIFACT_MANIFEST_FILENAME),
    JSON.stringify({ version, files: entries }, null, 2),
  );
}

async function expectArtifactError(
  run: () => Promise<unknown>,
  code: ArtifactVerificationError['code'],
): Promise<ArtifactVerificationError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(ArtifactVerificationError);
    if (error instanceof ArtifactVerificationError) {
      expect(error.code).toBe(code);
      return error;
    }
  }
  throw new Error(`Expected ArtifactVerificationError(${code})`);
}

describe('service-host versioned activation and rollback', () => {
  test('activates into releases/<key>, switches current atomically without mutating prior release, and rolls back with default verification', async () => {
    const installRoot = join(root, 'install');
    const srcV1 = join(root, 'staging-v1');
    const srcV2 = join(root, 'staging-v2');
    buildRelease(srcV1, '1.0.0', [
      { path: 'bin/daemon', content: 'v1-bin', executable: true },
    ]);
    buildRelease(srcV2, '2.0.0', [
      { path: 'bin/daemon', content: 'v2-bin', executable: true },
    ]);

    const act1 = await activateVersionedArtifact({
      rootDir: installRoot,
      sourceDir: srcV1,
      releaseKey: 'v1.0.0',
    });
    expect(act1.previousTarget).toBeNull();
    expect(act1.previousReleaseDir).toBeNull();
    expect(readlinkSync(act1.currentLinkPath)).toBe('releases/v1.0.0');
    expect(lstatSync(act1.currentLinkPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(act1.currentLinkPath, 'bin/daemon'), 'utf8')).toBe('v1-bin');
    expect(lstatSync(join(act1.releaseDir, 'bin/daemon')).mode & 0o111).not.toBe(0);

    const act2 = await activateVersionedArtifact({
      rootDir: installRoot,
      sourceDir: srcV2,
      releaseKey: 'v2.0.0',
    });
    expect(act2.previousTarget).toBe('releases/v1.0.0');
    expect(act2.previousReleaseDir).toBe(act1.releaseDir);
    expect(readlinkSync(act2.currentLinkPath)).toBe('releases/v2.0.0');
    expect(readFileSync(join(act1.releaseDir, 'bin/daemon'), 'utf8')).toBe('v1-bin');
    expect(readFileSync(join(act2.currentLinkPath, 'bin/daemon'), 'utf8')).toBe('v2-bin');

    const srcV2Tampered = join(root, 'staging-v2-tampered');
    buildRelease(srcV2Tampered, '2.0.0', [
      { path: 'bin/daemon', content: 'v2-other', executable: true },
    ]);
    await expectArtifactError(
      () =>
        activateVersionedArtifact({
          rootDir: installRoot,
          sourceDir: srcV2Tampered,
          releaseKey: 'v2.0.0',
        }),
      'ACTIVATION_FAILED',
    );

    // Rollback verifies target even when verifyOptions is omitted
    const rolled = await rollbackVersionedArtifact({
      rootDir: installRoot,
      previousTarget: act2.previousTarget ?? '',
    });
    expect(rolled.restoredTarget).toBe('releases/v1.0.0');
    expect(readlinkSync(act2.currentLinkPath)).toBe('releases/v1.0.0');
    expect(rolled.artifact.version).toBe('1.0.0');

    // Tampering with v2 makes rollback to v2 fail by default even without verifyOptions
    writeFileSync(join(act2.releaseDir, 'bin/daemon'), 'corrupted');
    await expectArtifactError(
      () =>
        rollbackVersionedArtifact({
          rootDir: installRoot,
          previousTarget: 'releases/v2.0.0',
        }),
      'SIZE_MISMATCH',
    );
  });

  test('an activated release is writable by its owner only, whatever modes the payload carried', async () => {
    const installRoot = join(root, 'install');
    const source = join(root, 'staging-open');
    buildRelease(source, '1.0.0', [
      { path: 'bin/daemon', content: 'bin', executable: true },
      { path: 'share/config.json', content: '{}' },
    ]);
    // What a careless build or an archive extracted under a loose umask leaves behind.
    chmodSync(join(source, 'bin/daemon'), 0o777);
    chmodSync(join(source, 'share/config.json'), 0o666);
    chmodSync(join(source, 'share'), 0o777);

    const activated = await activateVersionedArtifact({
      rootDir: installRoot,
      sourceDir: source,
      releaseKey: 'v1.0.0',
    });
    for (const path of ['bin/daemon', 'share/config.json', 'share', 'bin', '.']) {
      const mode = lstatSync(join(activated.releaseDir, path)).mode;
      expect(mode & 0o022, path).toBe(0);
    }
    expect(lstatSync(join(activated.releaseDir, 'bin/daemon')).mode & 0o111).toBe(0o111);
    // Branch 1 (fresh install): returned artifact reflects actual masked modes & releaseDir
    expect(activated.artifact.directory).toBe(activated.releaseDir);
    expect(activated.artifact.files.find((f) => f.path === 'bin/daemon')?.mode).toBe(0o755);
    expect(activated.artifact.files.find((f) => f.path === 'share/config.json')?.mode).toBe(
      0o644,
    );

    // Branch 2 (existing release re-activation): returned artifact also reflects masked modes & releaseDir
    const reactivated = await activateVersionedArtifact({
      rootDir: installRoot,
      sourceDir: source,
      releaseKey: 'v1.0.0',
    });
    expect(reactivated.artifact.directory).toBe(reactivated.releaseDir);
    expect(reactivated.artifact.files.find((f) => f.path === 'bin/daemon')?.mode).toBe(0o755);
    expect(reactivated.artifact.files.find((f) => f.path === 'share/config.json')?.mode).toBe(
      0o644,
    );

    // Branch 3 (concurrent race): both winners/losers report masked modes & releaseDir
    const concurrentRoot = join(root, 'install-concurrent-modes');
    const [c1, c2] = await Promise.all([
      activateVersionedArtifact({
        rootDir: concurrentRoot,
        sourceDir: source,
        releaseKey: 'v1.0.0',
      }),
      activateVersionedArtifact({
        rootDir: concurrentRoot,
        sourceDir: source,
        releaseKey: 'v1.0.0',
      }),
    ]);
    for (const entry of [c1, c2]) {
      expect(entry.artifact.directory).toBe(entry.releaseDir);
      expect(entry.artifact.files.find((f) => f.path === 'bin/daemon')?.mode).toBe(0o755);
      expect(entry.artifact.files.find((f) => f.path === 'share/config.json')?.mode).toBe(
        0o644,
      );
    }
  });

  test('pre-validates releasesDirName/currentLinkName, refuses symlinked releasesDir or non-symlink current before mutating', async () => {
    const src = join(root, 'src-good');
    buildRelease(src, '1.0.0', [{ path: 'app.js', content: 'ok' }]);

    await expectArtifactError(
      () =>
        activateVersionedArtifact({
          rootDir: join(root, 'same-name'),
          sourceDir: src,
          releasesDirName: 'slot',
          currentLinkName: 'slot',
        }),
      'ACTIVATION_FAILED',
    );

    // Non-symlink current path is rejected BEFORE creating releases/
    const badCurrentRoot = join(root, 'bad-current');
    mkdirSync(badCurrentRoot, { recursive: true });
    writeFileSync(join(badCurrentRoot, 'current'), 'not-a-symlink');
    await expectArtifactError(
      () => activateVersionedArtifact({ rootDir: badCurrentRoot, sourceDir: src }),
      'ACTIVATION_FAILED',
    );
    expect(() => lstatSync(join(badCurrentRoot, 'releases'))).toThrow();

    // Symlinked releasesDir is rejected before writing
    const symlinkReleasesRoot = join(root, 'symlink-releases');
    const outside = join(root, 'outside-dir');
    mkdirSync(symlinkReleasesRoot, { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(symlinkReleasesRoot, 'releases'));
    await expectArtifactError(
      () => activateVersionedArtifact({ rootDir: symlinkReleasesRoot, sourceDir: src }),
      'ACTIVATION_FAILED',
    );

    // Unverified candidate never touches installRoot
    const untouchedRoot = join(root, 'untouched-install');
    const broken = join(root, 'broken');
    buildRelease(broken, '1.0.0', [{ path: 'app.js', content: 'good' }]);
    writeFileSync(join(broken, 'app.js'), 'bad!');
    await expectArtifactError(
      () => activateVersionedArtifact({ rootDir: untouchedRoot, sourceDir: broken }),
      'DIGEST_MISMATCH',
    );
    expect(() => lstatSync(untouchedRoot)).toThrow();
  });

  test('supports concurrent activation of the same releaseKey and sanitizes dotfile/long default releaseKeys', async () => {
    const installRoot = join(root, 'concurrent-root');
    const src = join(root, 'src-concurrent');
    buildRelease(src, `..${'a'.repeat(120)}`, [{ path: 'app.js', content: 'v1' }]);

    const [first, second] = await Promise.all([
      activateVersionedArtifact({
        rootDir: installRoot,
        sourceDir: src,
        releasesDirName: 'versions',
        currentLinkName: 'active',
        verifyOptions: { maxFiles: 5 },
      }),
      activateVersionedArtifact({
        rootDir: installRoot,
        sourceDir: src,
        releasesDirName: 'versions',
        currentLinkName: 'active',
        verifyOptions: { maxFiles: 5 },
      }),
    ]);

    expect(first.releaseKey).toBe(second.releaseKey);
    expect(first.releaseKey.startsWith('.')).toBe(false);
    expect(first.releaseKey.length).toBeLessThanOrEqual(77);
    expect(readlinkSync(join(installRoot, 'active'))).toBe(`versions/${first.releaseKey}`);
  });

  test('rollbackVersionedArtifact strictly rejects ., releases, symlink escapes, non-symlink current, and name collisions', async () => {
    const installRoot = join(root, 'rollback-guard');
    const src = join(root, 'src-rb');
    buildRelease(src, '1.0.0', [{ path: 'app.js', content: 'v1' }]);
    const act = await activateVersionedArtifact({
      rootDir: installRoot,
      sourceDir: src,
      releaseKey: 'v1.0.0',
    });

    const outside = join(root, 'outside-release');
    buildRelease(outside, '9.9.9', [{ path: 'app.js', content: 'evil' }]);
    symlinkSync(outside, join(installRoot, 'evil-link'));
    symlinkSync(outside, join(installRoot, 'releases', 'symlink-release'));

    for (const badTarget of [
      '.',
      'releases',
      'releases/.',
      'releases/..',
      '../outside-release',
      '/etc',
      'evil-link/sub',
      'releases/v1.0.0/nested',
      'releases/symlink-release',
    ]) {
      await expectArtifactError(
        () => rollbackVersionedArtifact({ rootDir: installRoot, previousTarget: badTarget }),
        'ROLLBACK_FAILED',
      );
    }

    await expectArtifactError(
      () =>
        rollbackVersionedArtifact({
          rootDir: installRoot,
          previousTarget: 'same/v1.0.0',
          releasesDirName: 'same',
          currentLinkName: 'same',
        }),
      'ROLLBACK_FAILED',
    );

    // Replacing current symlink with a regular file causes rollback to refuse
    rmSync(act.currentLinkPath);
    writeFileSync(act.currentLinkPath, 'regular-file');
    await expectArtifactError(
      () =>
        rollbackVersionedArtifact({
          rootDir: installRoot,
          previousTarget: 'releases/v1.0.0',
        }),
      'ROLLBACK_FAILED',
    );
  });
});
