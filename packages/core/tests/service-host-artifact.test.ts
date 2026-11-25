import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ARTIFACT_MANIFEST_FILENAME,
  ArtifactManifestSchema,
  ArtifactVerificationError,
  computeArtifactManifestDigest,
  verifyArtifactDirectory,
} from '../src/entrypoints/service-host';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stitchkit-artifact-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function sha256(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

interface FixtureFile {
  path: string;
  content: string;
  executable?: boolean;
  declareExecutable?: boolean;
  declareSize?: boolean;
}

function buildArtifactDir(
  dir: string,
  version: string,
  files: readonly FixtureFile[],
  options?: { manifestFileName?: string; metadata?: Record<string, unknown> },
): void {
  mkdirSync(dir, { recursive: true });
  const manifestEntries = files.map((file) => {
    const abs = join(dir, file.path);
    const parent = abs.slice(0, abs.lastIndexOf('/'));
    mkdirSync(parent, { recursive: true });
    writeFileSync(abs, file.content);
    chmodSync(abs, file.executable ? 0o755 : 0o644);
    const bytes = new TextEncoder().encode(file.content);
    return {
      path: file.path,
      sha256: sha256(bytes),
      ...(file.declareSize !== false ? { size: bytes.byteLength } : {}),
      ...(file.declareExecutable !== undefined ? { executable: file.declareExecutable } : {}),
    };
  });
  const manifest = {
    version,
    files: manifestEntries,
    ...(options?.metadata !== undefined ? { metadata: options.metadata } : {}),
  };
  writeFileSync(
    join(dir, options?.manifestFileName ?? ARTIFACT_MANIFEST_FILENAME),
    JSON.stringify(manifest, null, 2),
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

describe('service-host artifact verification', () => {
  test('verifies a valid artifact directory, executable flags, digest and domain requirements', async () => {
    const artifactDir = join(root, 'valid-v1');
    buildArtifactDir(
      artifactDir,
      '1.2.3',
      [
        {
          path: 'bin/daemon',
          content: '#!/bin/sh\necho ok\n',
          executable: true,
          declareExecutable: true,
        },
        {
          path: 'config/default.json',
          content: '{"mode":"production"}',
          executable: false,
          declareExecutable: false,
        },
      ],
      { metadata: { target: 'linux-x64' } },
    );

    let requirementChecked = false;
    const verified = await verifyArtifactDirectory(artifactDir, {
      checkRequirements: (artifact) => {
        requirementChecked = true;
        const entrypoint = artifact.files.find((entry) => entry.path === 'bin/daemon');
        if (!entrypoint?.executable) throw new Error('missing executable entrypoint');
      },
    });

    expect(requirementChecked).toBe(true);
    expect(verified.version).toBe('1.2.3');
    expect(verified.files).toHaveLength(2);
    expect(verified.manifestDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(verified.manifestDigest).toBe(computeArtifactManifestDigest(verified.manifest));

    const reordered = ArtifactManifestSchema.parse({
      version: verified.manifest.version,
      files: [...verified.manifest.files].reverse(),
      metadata: verified.manifest.metadata,
    });
    expect(computeArtifactManifestDigest(reordered)).toBe(verified.manifestDigest);
  });

  test('refuses root directory that is a symlink or non-directory', async () => {
    const realDir = join(root, 'real');
    buildArtifactDir(realDir, '1.0.0', [{ path: 'app.js', content: 'console.log(1);' }]);

    const linkRoot = join(root, 'link-root');
    symlinkSync(realDir, linkRoot);
    await expectArtifactError(() => verifyArtifactDirectory(linkRoot), 'INVALID_ROOT');

    const regularFile = join(root, 'not-a-dir');
    writeFileSync(regularFile, 'hello');
    await expectArtifactError(() => verifyArtifactDirectory(regularFile), 'INVALID_ROOT');
  });

  test('refuses symlink, FIFO, and Unix socket inside artifact directory', async () => {
    const dirWithLink = join(root, 'with-symlink');
    buildArtifactDir(dirWithLink, '1.0.0', [{ path: 'app.js', content: 'ok' }]);
    const external = join(root, 'secret.txt');
    writeFileSync(external, 'secret');
    symlinkSync(external, join(dirWithLink, 'escape.txt'));
    await expectArtifactError(() => verifyArtifactDirectory(dirWithLink), 'UNSUPPORTED_ENTRY');

    const dirWithFileLink = join(root, 'with-file-symlink');
    buildArtifactDir(dirWithFileLink, '1.0.0', [{ path: 'app.js', content: 'secret' }]);
    rmSync(join(dirWithFileLink, 'app.js'));
    symlinkSync(external, join(dirWithFileLink, 'app.js'));
    await expectArtifactError(
      () => verifyArtifactDirectory(dirWithFileLink),
      'UNSUPPORTED_ENTRY',
    );

    const dirWithFifo = join(root, 'with-fifo');
    buildArtifactDir(dirWithFifo, '1.0.0', [{ path: 'app.js', content: 'ok' }]);
    const made = spawnSync('mkfifo', [join(dirWithFifo, 'pipe.fifo')]);
    expect(made.status).toBe(0);
    await expectArtifactError(() => verifyArtifactDirectory(dirWithFifo), 'UNSUPPORTED_ENTRY');

    const dirWithSocket = join(root, 'with-sock');
    buildArtifactDir(dirWithSocket, '1.0.0', [{ path: 'app.js', content: 'ok' }]);
    const server = createServer();
    await new Promise<void>((resolve) =>
      server.listen(join(dirWithSocket, 's.sock'), resolve),
    );
    try {
      await expectArtifactError(
        () => verifyArtifactDirectory(dirWithSocket),
        'UNSUPPORTED_ENTRY',
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('refuses path traversal, absolute paths, NUL, self-reference, and duplicate entries', async () => {
    const validSha = sha256('x');
    for (const badPath of [
      '../escape.js',
      'a/../../escape.js',
      '/etc/passwd',
      'sub\\win.js',
      'bad\0name.js',
      'manifest.json',
      './app.js',
    ]) {
      const dir = join(root, `bad-${sha256(badPath).slice(0, 8)}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, ARTIFACT_MANIFEST_FILENAME),
        JSON.stringify({ version: '1.0.0', files: [{ path: badPath, sha256: validSha }] }),
      );
      await expectArtifactError(() => verifyArtifactDirectory(dir), 'INVALID_MANIFEST');
    }

    const dup = ArtifactManifestSchema.safeParse({
      version: '1.0.0',
      files: [
        { path: 'a.js', sha256: validSha },
        { path: 'a.js', sha256: validSha },
      ],
    });
    expect(dup.success).toBe(false);

    const extraKey = ArtifactManifestSchema.safeParse({
      version: '1.0.0',
      files: [{ path: 'a.js', sha256: validSha }],
      unexpected: true,
    });
    expect(extraKey.success).toBe(false);
  });

  test('allows payload named manifest.json when custom manifestFileName is used, while refusing self-inclusion', async () => {
    const dir = join(root, 'custom-manifest-with-payload');
    buildArtifactDir(
      dir,
      '1.0.0',
      [
        { path: 'manifest.json', content: '{"app":"payload"}' },
        { path: 'bin/run', content: 'ok' },
      ],
      { manifestFileName: 'custom.json' },
    );

    const verified = await verifyArtifactDirectory(dir, { manifestFileName: 'custom.json' });
    expect(verified.files.map((file) => file.path)).toContain('manifest.json');

    // Declaring custom.json inside custom.json is still refused
    const selfRefDir = join(root, 'custom-self-ref');
    mkdirSync(selfRefDir, { recursive: true });
    writeFileSync(
      join(selfRefDir, 'custom.json'),
      JSON.stringify({
        version: '1.0.0',
        files: [{ path: 'custom.json', sha256: sha256('x') }],
      }),
    );
    await expectArtifactError(
      () => verifyArtifactDirectory(selfRefDir, { manifestFileName: 'custom.json' }),
      'INVALID_MANIFEST',
    );
  });

  test('refuses extra files, empty subdirectories, missing files, corrupted SHA-256, size mismatch and executable mismatch', async () => {
    const extraDir = join(root, 'extra');
    buildArtifactDir(extraDir, '1.0.0', [{ path: 'app.js', content: 'ok' }]);
    writeFileSync(join(extraDir, 'stray.txt'), 'unexpected');
    await expectArtifactError(() => verifyArtifactDirectory(extraDir), 'EXTRA_FILE');

    const emptySubDir = join(root, 'empty-subdir');
    buildArtifactDir(emptySubDir, '1.0.0', [{ path: 'app.js', content: 'ok' }]);
    mkdirSync(join(emptySubDir, 'unused-dir'));
    await expectArtifactError(() => verifyArtifactDirectory(emptySubDir), 'EXTRA_FILE');

    const missingDir = join(root, 'missing');
    buildArtifactDir(missingDir, '1.0.0', [
      { path: 'app.js', content: 'ok' },
      { path: 'lib/util.js', content: 'util' },
    ]);
    rmSync(join(missingDir, 'lib/util.js'));
    await expectArtifactError(() => verifyArtifactDirectory(missingDir), 'MISSING_FILE');

    const badHashDir = join(root, 'bad-hash');
    buildArtifactDir(badHashDir, '1.0.0', [{ path: 'app.js', content: 'hello' }]);
    writeFileSync(join(badHashDir, 'app.js'), 'hell0');
    await expectArtifactError(() => verifyArtifactDirectory(badHashDir), 'DIGEST_MISMATCH');

    const badSizeDir = join(root, 'bad-size');
    buildArtifactDir(badSizeDir, '1.0.0', [{ path: 'app.js', content: 'hello' }]);
    writeFileSync(join(badSizeDir, 'app.js'), 'hello-longer');
    await expectArtifactError(() => verifyArtifactDirectory(badSizeDir), 'SIZE_MISMATCH');

    const badExecDir = join(root, 'bad-exec');
    buildArtifactDir(badExecDir, '1.0.0', [
      { path: 'bin/run', content: '#!/bin/sh\n', executable: false, declareExecutable: true },
    ]);
    await expectArtifactError(
      () => verifyArtifactDirectory(badExecDir),
      'EXECUTABLE_MISMATCH',
    );
  });

  test('enforces maxFileBytes, maxManifestBytes, maxFiles (both manifest and disk), and checkRequirements failure', async () => {
    const dir = join(root, 'bounds');
    buildArtifactDir(
      dir,
      '1.0.0',
      [
        { path: 'a.txt', content: '0123456789' },
        { path: 'b.txt', content: '0123456789' },
      ],
      { manifestFileName: 'custom-manifest.json' },
    );

    const ok = await verifyArtifactDirectory(dir, {
      manifestFileName: 'custom-manifest.json',
      maxFileBytes: 10,
      maxFiles: 2,
    });
    expect(ok.files).toHaveLength(2);

    await expectArtifactError(
      () =>
        verifyArtifactDirectory(dir, {
          manifestFileName: 'custom-manifest.json',
          maxFileBytes: 9,
        }),
      'LIMIT_EXCEEDED',
    );

    await expectArtifactError(
      () =>
        verifyArtifactDirectory(dir, {
          manifestFileName: 'custom-manifest.json',
          maxFiles: 1,
        }),
      'LIMIT_EXCEEDED',
    );

    await expectArtifactError(
      () =>
        verifyArtifactDirectory(dir, {
          manifestFileName: 'custom-manifest.json',
          maxManifestBytes: 16,
        }),
      'INVALID_MANIFEST',
    );

    await expectArtifactError(
      () =>
        verifyArtifactDirectory(dir, {
          manifestFileName: 'custom-manifest.json',
          checkRequirements: () => {
            throw new Error('required entrypoint absent');
          },
        }),
      'REQUIREMENT_FAILED',
    );
  });
});
