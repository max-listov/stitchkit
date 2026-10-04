import { expect, test } from 'bun:test';
import { UniversalManifestSchema } from './universal-native-contract';

test('shared archive qualification refuses missing targets, duplicate modes and duplicate paths', () => {
  const artifacts = ['universal', 'renamed', 'single-arm64', 'single-x64'].map((mode) => {
    const architectures =
      mode === 'single-arm64' ? ['arm64'] : mode === 'single-x64' ? ['x64'] : ['arm64', 'x64'];
    return {
      mode,
      architectures,
      entryPath: 'app/proof.js',
      files: [
        { path: 'app/proof.js', sha256: '0'.repeat(64) },
        ...architectures.map((architecture) => ({
          path: `addons/${architecture}.node`,
          sha256: '1'.repeat(64),
          architecture,
        })),
      ],
    };
  });
  const manifest = { version: '0.0.0-test', artifacts };
  expect(UniversalManifestSchema.safeParse(manifest).success).toBe(true);
  const first = artifacts[0];
  if (!first) throw new Error('Positive qualification fixture is absent');
  for (const invalid of [
    { ...first, mode: 'renamed' },
    { ...first, architectures: ['arm64'] },
    { ...first, files: first.files.slice(0, 2) },
    { ...first, files: first.files.map((file) => ({ ...file, path: 'app/proof.js' })) },
    { ...first, entryPath: '../proof.js' },
  ])
    expect(
      UniversalManifestSchema.safeParse({
        ...manifest,
        artifacts: [invalid, ...artifacts.slice(1)],
      }).success,
    ).toBe(false);
});
