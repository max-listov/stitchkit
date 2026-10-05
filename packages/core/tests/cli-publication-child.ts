import { writeFile } from 'node:fs/promises';
import { publishCli } from '../src/entrypoints/cli/publish';

// Starts a publication whose build never finishes, so the process can be killed mid-build.
const [storageRoot, ready] = process.argv.slice(2);
if (!storageRoot || !ready) throw new Error('Expected storage root and ready paths');
await publishCli({
  name: 'app',
  version: '1.0.0',
  commit: 'a'.repeat(40),
  storageRoot,
  baseUrl: 'https://distribution.invalid/cli/',
  targets: [{ platform: 'linux', arch: 'x64' }],
  admit: () => undefined,
  async build() {
    await writeFile(ready, 'building');
    await new Promise<never>(() => undefined);
    return new Uint8Array();
  },
});
