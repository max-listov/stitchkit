import type { InstalledConsumerProof } from './installed-proof-contract';

/** Runtime capability and declarations are mandatory witnesses of this optional store extension. */
export const agentConversationProofs: InstalledConsumerProof[] = [
  {
    id: 'agent-conversation-branch',
    fixture: 'node',
    entry: 'agent-conversation-branch.mjs',
    files: [],
    peers: ['zod', 'ai', '@modelcontextprotocol/server'],
    platforms: ['linux', 'darwin'],
    runtimes: ['bun', 'node'],
    kind: 'runtime',
    marker: 'packed independent conversation branch: ok',
  },
  {
    id: 'agent-conversation-branch-types',
    fixture: 'node',
    entry: 'agent-conversation-branch-types.ts',
    files: [],
    peers: ['zod', 'ai', '@modelcontextprotocol/server'],
    platforms: ['linux', 'darwin', 'win32'],
    runtimes: [],
    kind: 'declarations',
    resolution: 'NodeNext',
    marker: 'strict conversation branch declarations: ok',
  },
];
