import { z } from 'zod';

const ProofSchema = z.object({
  id: z.string().min(1),
  fixture: z.enum(['minimal', 'node']),
  entry: z.string().min(1),
  files: z.array(z.string().min(1)),
  peers: z.array(z.string()),
  platforms: z.array(z.enum(['linux', 'darwin', 'win32'])),
  runtimes: z.array(z.enum(['bun', 'node'])),
  kind: z.enum(['runtime', 'declarations']),
  marker: z.string().min(1),
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
    files: ['native-owner-uid.mjs'],
    marker: 'packed native owners: ok',
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
  run: (proof: InstalledConsumerProof, runtime: 'bun' | 'node' | 'types') => Promise<string>;
  verdict: (
    proof: InstalledConsumerProof,
    runtime: 'bun' | 'node' | 'types' | 'platform',
    state: 'succeeded' | 'not-applicable' | 'failed',
  ) => void;
}): Promise<void> {
  for (const proof of installedConsumerProofs) {
    if (input.fixture && proof.fixture !== input.fixture) continue;
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

export function declarationProofArguments(entry: string): string[] {
  return [
    '--ignoreConfig',
    '--noEmit',
    '--strict',
    '--skipLibCheck',
    'false',
    '--target',
    'ES2022',
    '--module',
    'Preserve',
    '--moduleResolution',
    'bundler',
    '--lib',
    'ES2023,DOM',
    '--types',
    'node',
    entry,
  ];
}
