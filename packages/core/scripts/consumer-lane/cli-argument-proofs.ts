import type { InstalledConsumerProof } from './installed-proof-contract';

/** Installed argv admission and schema-derived help through the public CLI. */
export const cliArgumentProofs: InstalledConsumerProof[] = [
  {
    id: 'cli-option-occurrences',
    fixture: 'minimal',
    entry: 'cli-option-occurrences.mjs',
    files: [],
    peers: ['zod'],
    platforms: ['linux', 'darwin', 'win32'],
    runtimes: ['bun', 'node'],
    kind: 'runtime',
    marker: 'packed CLI option occurrences: ok',
  },
  {
    id: 'cli-help-limits',
    fixture: 'node',
    entry: 'cli-help-limits.mjs',
    files: [],
    peers: ['zod', 'ai', '@modelcontextprotocol/server', '@modelcontextprotocol/ext-apps'],
    platforms: ['linux', 'darwin', 'win32'],
    runtimes: ['bun', 'node'],
    kind: 'runtime',
    marker: 'packed CLI help limits: ok',
  },
  {
    id: 'cli-array-admission',
    fixture: 'node',
    entry: 'cli-array-admission.mjs',
    files: [],
    peers: ['zod', 'ai', '@modelcontextprotocol/server', '@modelcontextprotocol/ext-apps'],
    platforms: ['linux', 'darwin', 'win32'],
    runtimes: ['bun', 'node'],
    kind: 'runtime',
    marker: 'packed CLI array admission: ok',
  },
  {
    id: 'cli-json-object-roundtrip',
    fixture: 'node',
    entry: 'cli-json-object-roundtrip.mjs',
    files: [],
    peers: ['zod'],
    platforms: ['linux', 'darwin', 'win32'],
    runtimes: ['bun', 'node'],
    kind: 'runtime',
    marker: 'packed CLI JSON object round-trip: ok',
  },
];
