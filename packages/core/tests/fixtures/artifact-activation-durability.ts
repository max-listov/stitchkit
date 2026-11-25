// Records, in order, every `fsync` and every rename an activation makes, by path relative to
// the installation root, and prints them as one JSON array.
import { mock } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { join, relative } from 'node:path';

const [root] = process.argv.slice(2);
if (!root) throw new Error('Expected a scratch directory');
const install = join(root, 'install');
const events: string[] = [];
const named = (path: string) => relative(install, String(path)) || '.';

const realOpen = fsp.open;
const realRename = fsp.rename;
mock.module('node:fs/promises', () => ({
  ...fsp,
  open: async (...args: Parameters<typeof fsp.open>) => {
    const handle = await realOpen(...args);
    const sync = handle.sync.bind(handle);
    handle.sync = async () => {
      events.push(`sync ${named(String(args[0]))}`);
      await sync();
    };
    return handle;
  },
  rename: async (from: fs.PathLike, to: fs.PathLike) => {
    await realRename(from, to);
    events.push(`rename ${named(String(to))}`);
  },
}));

const { ARTIFACT_MANIFEST_FILENAME, activateVersionedArtifact } = await import(
  '../../src/entrypoints/service-host'
);

const source = join(root, 'source');
const files = [
  { path: 'bin/app', content: '#!/bin/sh\n' },
  { path: 'lib/deep/data.json', content: '{}' },
];
for (const file of files) {
  fs.mkdirSync(join(source, file.path, '..'), { recursive: true });
  fs.writeFileSync(join(source, file.path), file.content);
}
fs.writeFileSync(
  join(source, ARTIFACT_MANIFEST_FILENAME),
  JSON.stringify({
    version: '1.0.0',
    files: files.map((file) => ({
      path: file.path,
      sha256: createHash('sha256').update(file.content).digest('hex'),
      size: Buffer.byteLength(file.content),
    })),
  }),
);
fs.mkdirSync(install);
await activateVersionedArtifact({ rootDir: install, sourceDir: source, releaseKey: 'v1' });
// The staging name is random: name it by its role.
console.log(
  JSON.stringify(
    events.map((event) =>
      event.replace(/releases\/[^/\s]*stitchkit[^/\s]*/, 'releases/<staged>'),
    ),
  ),
);
