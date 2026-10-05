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

test('qualification paths use the package path rules, drive letters included', () => {
  const artifact = (entryPath: string) => ({
    mode: 'universal',
    architectures: ['arm64', 'x64'],
    entryPath,
    files: [
      { path: entryPath, sha256: '0'.repeat(64) },
      { path: 'addons/arm64.node', sha256: '1'.repeat(64), architecture: 'arm64' },
      { path: 'addons/x64.node', sha256: '1'.repeat(64), architecture: 'x64' },
    ],
  });
  const manifest = (entryPath: string) => ({
    version: '0.0.0-test',
    artifacts: [
      artifact(entryPath),
      ...['renamed', 'single-arm64', 'single-x64'].map((mode) => ({
        ...artifact('app/proof.js'),
        mode,
        architectures:
          mode === 'single-arm64'
            ? ['arm64']
            : mode === 'single-x64'
              ? ['x64']
              : ['arm64', 'x64'],
        files: artifact('app/proof.js').files.filter(
          (file) =>
            file.architecture === undefined ||
            mode === 'renamed' ||
            file.architecture === mode.slice('single-'.length),
        ),
      })),
    ],
  });
  expect(UniversalManifestSchema.safeParse(manifest('app/proof.js')).success).toBe(true);
  expect(UniversalManifestSchema.safeParse(manifest('C:proof.js')).success).toBe(false);
});
