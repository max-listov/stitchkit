import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  assertIsolated,
  fileDigest,
  run,
  UniversalManifestSchema,
} from './universal-native-contract';

assert.equal(process.platform, 'darwin');
assert.ok(process.arch === 'arm64' || process.arch === 'x64');
const archive = resolve(Bun.argv[2] ?? '');
if (!Bun.argv[2]) throw new Error('Shared universal archive is required');
const scratch = mkdtempSync(join(tmpdir(), 'stitchkit-universal-offline-'));
try {
  assertIsolated(scratch);
  const extracted = join(scratch, 'deployed');
  mkdirSync(extracted);
  run('tar', ['-xf', archive, '-C', extracted], scratch);
  const manifest = UniversalManifestSchema.parse(
    JSON.parse(readFileSync(join(extracted, 'manifest.json'), 'utf8')),
  );
  for (const artifact of manifest.artifacts) {
    const directory = join(extracted, artifact.mode);
    for (const file of artifact.files)
      assert.equal(
        fileDigest(join(directory, file.path)),
        file.sha256,
        'Archive preserves original bytes',
      );
    const opposite = !artifact.architectures.includes(process.arch);
    const selected = artifact.files.find((file) => file.architecture === process.arch);
    const other = artifact.files.find(
      (file) => file.architecture && file.architecture !== process.arch,
    );
    const modes = opposite
      ? ['unsupported']
      : artifact.architectures.length === 2
        ? ['positive', 'missing', 'corrupt']
        : ['positive'];
    for (const mode of modes) {
      const selectedPath = selected ? join(directory, selected.path) : undefined;
      if (mode !== 'positive' && mode !== 'unsupported') {
        assert.ok(selectedPath && selected && other);
        if (mode === 'missing') {
          rmSync(selectedPath);
          assert.equal(existsSync(selectedPath), false);
        } else {
          // Remove before copying: retain the original archive and other addon bytes.
          rmSync(selectedPath);
          copyFileSync(join(directory, other.path), selectedPath);
          assert.notEqual(
            fileDigest(selectedPath),
            selected.sha256,
            'Integrity rejects wrong architecture',
          );
        }
        assert.equal(
          fileDigest(join(directory, other.path)),
          other.sha256,
          'Valid opposite addon remains present',
        );
      }
      for (const runtime of ['bun', 'node']) {
        const args = [
          ...(runtime === 'bun' ? ['--no-install'] : []),
          join(directory, artifact.entryPath),
          ...(mode === 'positive' ? [] : ['--expect-unavailable', mode]),
        ];
        const output = run(runtime, args, scratch);
        const verdict =
          mode === 'positive'
            ? 'Darwin artifact native controls: ok'
            : `Darwin artifact backend ${mode}: refused`;
        assert.ok(
          output.split(/\r?\n/).includes(verdict),
          `${artifact.mode}/${runtime}/${mode} lacks exact verdict`,
        );
        console.log(
          JSON.stringify({
            architecture: process.arch,
            artifact: artifact.mode,
            runtime,
            control: mode,
            jsSha256: fileDigest(join(directory, artifact.entryPath)),
            verdict,
          }),
        );
      }
      if (mode === 'missing' || mode === 'corrupt') {
        // Restore from the delivered archive before the next independent control.
        run('tar', ['-xf', archive, '-C', extracted], scratch);
        assert.ok(selectedPath && selected);
        assert.equal(fileDigest(selectedPath), selected.sha256);
      }
    }
  }
  console.log(
    JSON.stringify({
      version: manifest.version,
      architecture: process.arch,
      archiveSha256: fileDigest(archive),
      verdict: 'universal native qualification: ok',
    }),
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
