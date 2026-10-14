import { z } from 'zod';

export const DeclarationVariantSchema = z.object({
  id: z.string().min(1),
  target: z.string().min(1),
  module: z.enum(['Preserve', 'NodeNext']),
  resolution: z.enum(['bundler', 'NodeNext']),
  lib: z.array(z.string().min(1)).min(1),
  types: z.array(z.string().min(1)).min(1),
});

export const InstalledConsumerProofSchema = z.object({
  id: z.string().min(1),
  fixture: z.enum(['minimal', 'node', 'mcp-only', 'declarations', 'native-client']),
  entry: z.string().min(1),
  files: z.array(z.string().min(1)),
  peers: z.array(z.string()),
  platforms: z.array(z.enum(['linux', 'darwin', 'win32'])),
  runtimes: z.array(z.enum(['bun', 'node'])),
  kind: z.enum(['runtime', 'declarations']),
  resolution: z.enum(['bundler', 'NodeNext']).optional(),
  declarationVariants: z.array(DeclarationVariantSchema).min(1).optional(),
  marker: z.string().min(1),
  capability: z.literal('linux-root').optional(),
  /**
   * About how long the slower runtime of this proof takes on a hosted runner (measured 2026-10-13 on
   * macos-15-intel). The pool starts the longest first, so the lane lasts about as long as its
   * slowest proof; an unmeasured proof counts as short. Only order depends on it, never a verdict.
   */
  expectedMs: z.number().int().positive().optional(),
  /** Independent executions must all pass; repeated native lifetime proofs qualify scheduling races. */
  repetitions: z.number().int().min(1).max(10).optional(),
  /**
   * Runs with nothing beside it but `idle` proofs: it changes the fixture's shared install (hides
   * `node_modules`). Native lifetime proofs have independent state and share the pool.
   */
  exclusive: z.literal(true).optional(),
  /** Only waits on a real clock and loads nothing, so it runs from the start beside everything. */
  idle: z.literal(true).optional(),
});
export type InstalledConsumerProof = z.infer<typeof InstalledConsumerProofSchema>;
