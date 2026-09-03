/**
 * The shapes an async operation is described by, with nothing that runs one.
 *
 * A leaf: zod and nothing else. `async-operation.ts` is 1,400 lines that reach
 * the tool runtime, the MCP server types and the `ai` package, and a module is
 * imported whole — so re-exporting two schemas from it dragged all of that into
 * the browser entry's graph and, worse, into its `.d.ts`. A consumer without the
 * optional MCP peer could not typecheck against a snapshot schema.
 *
 * Extracted the same way `view-file-contract.ts` was, and for the same reason: a
 * client that has to *call* an operation needs to parse what it returns, and
 * that need has no business requiring the machinery that serves it.
 */
import { type ZodType, z } from 'zod';

export const AsyncOperationCancelResultSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('accepted') }),
  z.object({ outcome: z.literal('already_terminal') }),
  z.object({ outcome: z.literal('rejected'), reason: z.string().min(1) }),
]);

export type AsyncOperationCancelResult = z.infer<typeof AsyncOperationCancelResultSchema>;

export type AsyncOperationCapability =
  | 'start'
  | 'status'
  | 'wait'
  | 'cancel'
  | 'result'
  | 'artifacts';

export function createAsyncOperationSnapshotSchema<
  TProgress extends ZodType | undefined = undefined,
  TFailure extends ZodType = ZodType,
>(config: { progress?: TProgress; failure: TFailure }) {
  const progress = config.progress ? { progress: config.progress.optional() } : {};
  return z.discriminatedUnion('phase', [
    z.object({ phase: z.literal('pending'), ...progress }),
    z.object({ phase: z.literal('running'), ...progress }),
    z.object({ phase: z.literal('succeeded'), ...progress }),
    z.object({ phase: z.literal('failed'), failure: config.failure, ...progress }),
    z.object({ phase: z.literal('cancelled'), ...progress }),
  ]);
}
