import { z } from 'zod';

const ProofSchema = z.object({
  id: z.string().min(1),
  fixture: z.enum(['minimal', 'node', 'mcp-only']),
  entry: z.string().min(1),
  files: z.array(z.string().min(1)),
  peers: z.array(z.string()),
  platforms: z.array(z.enum(['linux', 'darwin', 'win32'])),
  runtimes: z.array(z.enum(['bun', 'node'])),
  kind: z.enum(['runtime', 'declarations']),
  resolution: z.enum(['bundler', 'NodeNext']).optional(),
  marker: z.string().min(1),
  capability: z.literal('linux-root').optional(),
});
export type InstalledConsumerProof = z.infer<typeof ProofSchema>;

const native = {
  peers: ['zod'],
  platforms: ['linux', 'darwin'],
  runtimes: ['bun', 'node'],
  kind: 'runtime',
};
export const installedConsumerProofs = z.array(ProofSchema).parse([
  {
    id: 'native-packaging',
    fixture: 'minimal',
    entry: 'native-packaging.mjs',
    files: [],
    peers: ['zod'],
    platforms: ['linux', 'darwin', 'win32'],
    runtimes: ['bun', 'node'],
    kind: 'runtime',
    marker: 'packed build-only native packaging: ok',
  },
  {
    id: 'native-packaging-types',
    fixture: 'minimal',
    entry: 'native-packaging-types.ts',
    files: [],
    peers: ['zod'],
    platforms: ['linux', 'darwin', 'win32'],
    runtimes: [],
    kind: 'declarations',
    resolution: 'NodeNext',
    marker: 'strict build-only native packaging types: ok',
  },
  {
    id: 'mcp-only-leaf',
    fixture: 'mcp-only',
    entry: 'mcp-leaf.mjs',
    files: [],
    peers: ['zod', '@modelcontextprotocol/server'],
    platforms: ['linux', 'darwin', 'win32'],
    runtimes: ['bun', 'node'],
    kind: 'runtime',
    marker: 'packed MCP-only leaf: ok',
  },
  {
    id: 'mcp-only-types',
    fixture: 'mcp-only',
    entry: 'mcp-leaf-types.ts',
    files: [],
    peers: ['zod', '@modelcontextprotocol/server'],
    platforms: ['linux', 'darwin', 'win32'],
    runtimes: [],
    kind: 'declarations',
    resolution: 'NodeNext',
    marker: 'strict MCP-only declarations: ok',
  },
  {
    id: 'programmatic-intake',
    fixture: 'minimal',
    entry: 'application-programmatic-intake.mjs',
    files: [],
    peers: ['zod'],
    platforms: ['linux', 'darwin'],
    runtimes: ['bun', 'node'],
    kind: 'runtime',
    marker: 'packed programmatic intake: ok',
  },
  {
    id: 'managed-client-composition',
    fixture: 'minimal',
    entry: 'managed-client-composition.mjs',
    files: [],
    peers: ['zod'],
    platforms: ['linux', 'darwin'],
    runtimes: ['bun', 'node'],
    kind: 'runtime',
    marker: 'packed managed client composition: ok',
  },
  {
    id: 'broadcast-classification',
    fixture: 'minimal',
    entry: 'telegram-broadcast-classifier.mjs',
    files: [],
    peers: ['zod'],
    platforms: ['linux', 'darwin'],
    runtimes: ['bun', 'node'],
    kind: 'runtime',
    marker: 'packed injected broadcast classification: ok',
  },
  {
    id: 'cli-publication',
    fixture: 'minimal',
    entry: 'cli-publication.mjs',
    files: ['cli-publication-support.mjs', 'cli-publication-binary.ts'],
    peers: ['zod'],
    platforms: ['linux', 'darwin'],
    runtimes: ['bun', 'node'],
    kind: 'runtime',
    marker: 'packed CLI publication: ok',
  },
  {
    id: 'mcp-phase-limits',
    fixture: 'node',
    entry: 'mcp-phase-limits.mjs',
    files: ['mcp-phase-cli.mjs'],
    peers: ['zod', 'ai', '@modelcontextprotocol/server'],
    platforms: ['linux', 'darwin'],
    runtimes: ['bun', 'node'],
    kind: 'runtime',
    marker: 'packed MCP phase limits and failures: ok',
  },
  {
    id: 'mcp-phase-limits-types',
    fixture: 'node',
    entry: 'mcp-phase-limits-types.ts',
    files: [],
    peers: ['zod', 'ai', '@modelcontextprotocol/server'],
    platforms: ['linux', 'darwin', 'win32'],
    runtimes: [],
    kind: 'declarations',
    resolution: 'NodeNext',
    marker: 'strict MCP phase limit declarations: ok',
  },
  {
    id: 'remote-http',
    fixture: 'node',
    entry: 'remote-http.mjs',
    files: ['remote-http-contract.mjs', 'remote-http-cli.mjs'],
    peers: ['zod', 'srvx', 'ai', '@modelcontextprotocol/server'],
    platforms: ['linux', 'darwin'],
    runtimes: ['bun', 'node'],
    kind: 'runtime',
    marker: 'packed HTTP remote metadata and cancellation: ok',
  },
  {
    id: 'native-http-idle',
    fixture: 'minimal',
    entry: 'native-http-idle.mjs',
    files: ['native-http-idle-cli.mjs'],
    peers: ['zod'],
    platforms: ['linux', 'darwin'],
    runtimes: ['bun', 'node'],
    kind: 'runtime',
    marker: 'packed native HTTP idle deadlines: ok',
  },
  {
    id: 'cli-public-types',
    fixture: 'minimal',
    entry: 'cli-types.ts',
    files: ['cli-peer-absence.ts', 'cli-publish-leaf.ts'],
    peers: ['zod'],
    platforms: ['linux', 'darwin', 'win32'],
    runtimes: [],
    kind: 'declarations',
    resolution: 'NodeNext',
    marker: 'strict peer-free CLI declarations: ok',
  },
  {
    id: 'cli-native',
    fixture: 'minimal',
    entry: 'cli-native.mjs',
    files: [],
    peers: ['zod'],
    platforms: ['linux', 'darwin', 'win32'],
    runtimes: ['bun', 'node'],
    kind: 'runtime',
    marker: 'packed peer-free CLI execution: ok',
  },
  {
    id: 'darwin-artifacts',
    fixture: 'node',
    entry: 'darwin-artifacts.mjs',
    files: ['darwin-artifact-controls.mjs', 'contained-files.mjs'],
    peers: ['zod', 'ai', '@modelcontextprotocol/server', '@modelcontextprotocol/ext-apps'],
    platforms: ['darwin'],
    runtimes: ['bun'],
    kind: 'runtime',
    marker: 'packed Darwin JS and standalone artifacts: ok',
  },
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
    ...native,
    id: 'native-primitives',
    fixture: 'minimal',
    entry: 'native-primitives.mjs',
    files: ['command-lifecycle.mjs'],
    marker: 'packed native primitives: ok',
  },
  {
    ...native,
    id: 'native-owners',
    fixture: 'node',
    entry: 'native-owners.mjs',
    files: [],
    marker: 'packed native owners: ok',
  },
  {
    ...native,
    id: 'native-owner-uid',
    fixture: 'node',
    entry: 'native-owner-uid.mjs',
    files: [],
    platforms: ['linux'],
    capability: 'linux-root',
    marker: 'packed Linux mixed UID: ok',
  },
  {
    ...native,
    id: 'native-cross-entry-owner',
    fixture: 'node',
    entry: 'native-cross-entry-owner.mjs',
    files: [],
    peers: ['zod', 'ai', '@modelcontextprotocol/server'],
    platforms: ['linux'],
    marker: 'packed cross-entry native ownership: ok',
  },
  {
    ...native,
    id: 'native-command-reasons',
    fixture: 'node',
    entry: 'native-command-reasons.mjs',
    files: ['native-start-failure.mjs'],
    marker: 'packed native command reasons: ok',
  },
  {
    ...native,
    id: 'native-owner-loss',
    fixture: 'node',
    entry: 'native-owner-loss.mjs',
    files: ['native-owner-loss-owner.mjs', 'native-owner-loss-target.mjs'],
    marker: 'packed native owner loss: ok',
  },
  {
    ...native,
    id: 'effect-lease',
    fixture: 'node',
    entry: 'effect-lease.mjs',
    files: [],
    marker: 'packed effect external lease two-process: ok',
  },
  {
    ...native,
    id: 'exclusive-lock',
    fixture: 'node',
    entry: 'exclusive-lock.mjs',
    files: ['exclusive-lock-boundaries.mjs'],
    marker: 'packed exclusive lock process identity: ok',
  },
  {
    id: 'native-command-reasons-types',
    fixture: 'node',
    entry: 'native-command-reasons.ts',
    files: [],
    peers: ['zod'],
    platforms: ['linux', 'darwin', 'win32'],
    runtimes: [],
    kind: 'declarations',
    marker: 'strict native command reason declarations: ok',
  },
]);

/** Both installation lanes execute this list; failures never count as a skipped proof. */
export async function runInstalledConsumerProofs(input: {
  fixture?: InstalledConsumerProof['fixture'];
  platform: NodeJS.Platform;
  uid?: number;
  ids?: readonly string[];
  requireCapabilities?: boolean;
  run: (proof: InstalledConsumerProof, runtime: 'bun' | 'node' | 'types') => Promise<string>;
  verdict: (
    proof: InstalledConsumerProof,
    runtime: 'bun' | 'node' | 'types' | 'platform',
    state: 'succeeded' | 'not-applicable' | 'failed',
  ) => void;
}): Promise<void> {
  for (const proof of installedConsumerProofs) {
    if (input.ids && !input.ids.includes(proof.id)) continue;
    if (input.fixture && proof.fixture !== input.fixture) continue;
    if (proof.capability === 'linux-root' && (input.platform !== 'linux' || input.uid !== 0)) {
      if (input.requireCapabilities) {
        input.verdict(proof, 'platform', 'failed');
        throw new Error(`Installed proof ${proof.id} requires Linux UID0`);
      }
      input.verdict(proof, 'platform', 'not-applicable');
      continue;
    }
    if (!proof.platforms.some((platform) => platform === input.platform)) {
      input.verdict(proof, 'platform', 'not-applicable');
      continue;
    }
    const runtimes: ('bun' | 'node' | 'types')[] =
      proof.kind === 'declarations' ? ['types'] : proof.runtimes;
    for (const runtime of runtimes) {
      try {
        const output = await input.run(proof, runtime);
        if (
          proof.kind === 'runtime' &&
          !output.split(/\r?\n/).some((line) => line === proof.marker)
        )
          throw new Error(
            `Installed proof ${proof.id}/${runtime} has no exact success marker`,
          );
        input.verdict(proof, runtime, 'succeeded');
      } catch (error) {
        input.verdict(proof, runtime, 'failed');
        throw error;
      }
    }
  }
}

export function declarationProofArguments(
  entry: string,
  resolution: InstalledConsumerProof['resolution'] = 'bundler',
): string[] {
  return [
    '--ignoreConfig',
    '--noEmit',
    '--strict',
    '--skipLibCheck',
    'false',
    '--target',
    'ES2022',
    '--module',
    resolution === 'NodeNext' ? 'NodeNext' : 'Preserve',
    '--moduleResolution',
    resolution,
    '--lib',
    'ES2023,DOM',
    '--types',
    'node',
    entry,
  ];
}
