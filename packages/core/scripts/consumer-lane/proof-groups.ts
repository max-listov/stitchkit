import { agentConversationProofs } from './agent-conversation-proofs';
import { cliArgumentProofs } from './cli-argument-proofs';
import type { InstalledConsumerProof } from './installed-proof-contract';
import { requestBoundaryProofs } from './request-boundary-proofs';

/** The proofs registered by subject, ahead of the shared list in `installed-proofs.ts`. */
export const proofGroups: InstalledConsumerProof[] = [
  {
    id: 'contained-entry-boundaries',
    fixture: 'node',
    entry: 'contained-files.mjs',
    files: ['contained-entry-controls.mjs'],
    peers: ['zod', 'ai', '@modelcontextprotocol/server', '@modelcontextprotocol/ext-apps'],
    platforms: ['linux', 'darwin'],
    runtimes: ['bun', 'node'],
    kind: 'runtime',
    marker: 'packed contained entry boundaries: ok',
  },
  {
    id: 'keyboard-layer-commit',
    fixture: 'full',
    entry: 'keyboard-layer-commit.mjs',
    files: [],
    peers: ['zod', 'react'],
    platforms: ['linux', 'darwin', 'win32'],
    runtimes: ['bun', 'node'],
    kind: 'runtime',
    marker: 'packed keyboard layer commit: ok',
  },
  {
    id: 'keyboard-native-semantics',
    fixture: 'full',
    entry: 'keyboard-native-semantics.mjs',
    files: [],
    peers: ['zod', 'react'],
    platforms: ['linux', 'darwin', 'win32'],
    runtimes: ['bun', 'node'],
    kind: 'runtime',
    marker: 'packed keyboard native semantics: ok',
  },
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
