import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CliPublicationOptions, publishCli } from '../src/entrypoints/cli/publish';

export async function publicationFixture() {
  const root = await mkdtemp(join(tmpdir(), 'stitchkit-publication-'));
  const storageRoot = join(root, 'published');
  const builds: string[] = [];
  const admissions: string[] = [];
  const options: CliPublicationOptions = {
    name: 'app',
    version: '1.0.0',
    commit: 'a'.repeat(40),
    storageRoot,
    baseUrl: 'https://distribution.invalid/cli/',
    targets: [
      { platform: 'linux', arch: 'x64' },
      { platform: 'darwin', arch: 'arm64' },
    ],
    admit({ phase }) {
      admissions.push(phase);
    },
    build({ target, stamp }) {
      builds.push(`${target.platform}-${target.arch}`);
      return new TextEncoder().encode(JSON.stringify({ target, stamp }));
    },
  };
  return {
    root,
    storageRoot,
    builds,
    admissions,
    options,
    publish: (overrides: Partial<CliPublicationOptions> = {}) =>
      publishCli({ ...options, ...overrides }),
    manifest: () => readFile(join(storageRoot, 'manifest.json'), 'utf8'),
  };
}
