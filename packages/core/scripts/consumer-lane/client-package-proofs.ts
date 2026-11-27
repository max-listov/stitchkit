import type { InstalledConsumerProof } from './installed-proof-contract';

/**
 * What a consumer installs to publish a typed client of its contract: the framework builds the
 * package and stays outside it, as the client's peer.
 */
export const clientPackageProofs: InstalledConsumerProof[] = [
  {
    id: 'client-package',
    fixture: 'minimal',
    entry: 'client-package.mjs',
    files: [
      'client-package/contract.ts',
      'client-package/index.ts',
      'client-package/monitoring.ts',
    ],
    peers: ['zod'],
    platforms: ['linux', 'darwin'],
    runtimes: ['bun', 'node'],
    kind: 'runtime',
    marker: 'packed client package: ok',
  },
];
