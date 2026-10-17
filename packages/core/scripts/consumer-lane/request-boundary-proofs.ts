import type { InstalledConsumerProof } from './installed-proof-contract';

/** What a consumer installs to read a request body within a limit and to receive ingress facts. */
export const requestBoundaryProofs: InstalledConsumerProof[] = [
  {
    id: 'bounded-body',
    fixture: 'minimal',
    entry: 'bounded-body.mjs',
    files: [],
    peers: ['zod'],
    platforms: ['linux', 'darwin'],
    runtimes: ['bun', 'node'],
    kind: 'runtime',
    marker: 'packed bounded body: ok',
  },
  {
    id: 'request-ingress',
    fixture: 'node',
    entry: 'request-ingress.mjs',
    files: [],
    peers: ['zod', 'srvx', 'ai', '@modelcontextprotocol/server'],
    platforms: ['linux', 'darwin'],
    runtimes: ['bun', 'node'],
    kind: 'runtime',
    marker: 'packed request ingress: ok',
  },
];
