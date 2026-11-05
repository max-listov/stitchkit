/**
 * Guard: `stitchkit/tools` loads no optional peer.
 *
 * An application that exposes its operations over HTTP and CLI imports
 * `stitchkit/tools` for `listToolNames`, the registry or the invoker and
 * installs neither the MCP server SDK nor the AI SDK. Those adapters live
 * behind `stitchkit/tools/mcp`, `stitchkit/tools/agent` and
 * `stitchkit/tools/toolkit`. → ADR 0284.
 *
 * Only the built chunk graph can hold this promise: `--splitting` decides which
 * chunk an import lands in, and one static `import … from "<peer>"` anywhere in
 * the graph makes ESM resolution of the whole entry fail on a consumer without
 * that peer. Type imports erase, so no source-level test sees the difference.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const root = join(dirname(new URL(import.meta.url).pathname), '..');
const dist = join(root, 'dist');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const optionalPeers = Object.entries(manifest.peerDependenciesMeta ?? {})
  .filter(([, meta]) => meta?.optional === true)
  .map(([name]) => name);

function packageOf(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
}

/** Every bare package a chunk reachable from `entry` imports, with the chunk. */
function barePackagesOf(entry) {
  const seen = new Set();
  const found = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(join(dist, file), 'utf8');
    for (const match of source.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*"([^"]+)"/g)) {
      const specifier = match[1];
      if (specifier.startsWith('.')) queue.push(join(dirname(file), specifier));
      else if (!specifier.startsWith('node:') && !specifier.startsWith('#')) {
        found.push({ file, name: packageOf(specifier) });
      }
    }
  }
  return { chunks: seen.size, found };
}

const { chunks, found } = barePackagesOf('entrypoints/tools.js');
const offenders = [
  ...new Set(
    found
      .filter(({ name }) => optionalPeers.includes(name))
      .map(({ file, name }) => `${file} imports ${name}`),
  ),
];

if (offenders.length > 0) {
  console.error('[check-tools-neutral] stitchkit/tools loads an optional peer:');
  for (const offender of offenders) console.error(`  ${offender}`);
  console.error(
    '\n  The tools barrel must import without optional peers. Export MCP code from\n' +
      '  stitchkit/tools/mcp and AI SDK code from stitchkit/tools/agent.',
  );
  process.exit(1);
}

console.log(
  `[check-tools-neutral] tools graph (${chunks} chunks) imports no optional peer (${optionalPeers.length} checked)`,
);
