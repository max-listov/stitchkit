import { agentConversationProofs } from './agent-conversation-proofs';
import { cliArgumentProofs } from './cli-argument-proofs';
import type { InstalledConsumerProof } from './installed-proof-contract';
import { requestBoundaryProofs } from './request-boundary-proofs';

/** The proofs registered by subject, ahead of the shared list in `installed-proofs.ts`. */
export const proofGroups: InstalledConsumerProof[] = [
  {
    id: 'tracking-click-url',
    fixture: 'minimal',
    entry: 'tracking-click-url.mjs',
    files: [],
    peers: ['zod'],
    platforms: ['linux', 'darwin', 'win32'],
    runtimes: ['bun', 'node'],
    kind: 'runtime',
    marker: 'packed tracking click URL policy: ok',
  },
  ...agentConversationProofs,
  ...requestBoundaryProofs,
  ...cliArgumentProofs,
];
