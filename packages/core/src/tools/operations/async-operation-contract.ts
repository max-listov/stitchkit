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

/**
 * The two snapshot unions, written out rather than inferred.
 *
 * A conditional spread — `...(config.progress ? { progress: … } : {})` — infers
 * an object shape that is a *union* of "has the key" and "has the key as
 * `undefined`", and zod constrains a shape to `Record<string, $ZodType>`. The
 * second half of that union does not satisfy it, so the emitted declaration
 * carried five `TS2344` errors, one per phase. Nothing in this repository saw
 * them: the compiler keeps the shape internal while checking source, and every
 * caller here and in the guide passes `progress`, so the broken half was only
 * ever written down, never used. A consumer with `skipLibCheck: false` reading
 * the packed `.d.ts` is the first party to meet it — and this entry exists
 * precisely for consumers.
 *
 * Overloads, not a normalised key: substituting `z.never().optional()` for the
 * absent one would make the shape uniform, but a snapshot that used to strip an
 * unexpected `progress` would start rejecting it. Types are the defect; runtime
 * is not, and does not move.
 */
export type AsyncOperationSnapshotSchemaWithProgress<
  TProgress extends ZodType,
  TFailure extends ZodType,
> = z.ZodDiscriminatedUnion<
  [
    z.ZodObject<
      { phase: z.ZodLiteral<'pending'>; progress: z.ZodOptional<TProgress> },
      z.core.$strip
    >,
    z.ZodObject<
      { phase: z.ZodLiteral<'running'>; progress: z.ZodOptional<TProgress> },
      z.core.$strip
    >,
    z.ZodObject<
      { phase: z.ZodLiteral<'succeeded'>; progress: z.ZodOptional<TProgress> },
      z.core.$strip
    >,
    z.ZodObject<
      {
        phase: z.ZodLiteral<'failed'>;
        failure: TFailure;
        progress: z.ZodOptional<TProgress>;
      },
      z.core.$strip
    >,
    z.ZodObject<
      { phase: z.ZodLiteral<'cancelled'>; progress: z.ZodOptional<TProgress> },
      z.core.$strip
    >,
  ]
>;

export type AsyncOperationSnapshotSchema<TFailure extends ZodType> = z.ZodDiscriminatedUnion<
  [
    z.ZodObject<{ phase: z.ZodLiteral<'pending'> }, z.core.$strip>,
    z.ZodObject<{ phase: z.ZodLiteral<'running'> }, z.core.$strip>,
    z.ZodObject<{ phase: z.ZodLiteral<'succeeded'> }, z.core.$strip>,
    z.ZodObject<{ phase: z.ZodLiteral<'failed'>; failure: TFailure }, z.core.$strip>,
    z.ZodObject<{ phase: z.ZodLiteral<'cancelled'> }, z.core.$strip>,
  ]
>;

export function createAsyncOperationSnapshotSchema<TFailure extends ZodType>(config: {
  progress?: undefined;
  failure: TFailure;
}): AsyncOperationSnapshotSchema<TFailure>;
export function createAsyncOperationSnapshotSchema<
  TProgress extends ZodType,
  TFailure extends ZodType,
>(config: {
  progress: TProgress;
  failure: TFailure;
}): AsyncOperationSnapshotSchemaWithProgress<TProgress, TFailure>;
export function createAsyncOperationSnapshotSchema(config: {
  progress?: ZodType;
  failure: ZodType;
}):
  | AsyncOperationSnapshotSchemaWithProgress<ZodType, ZodType>
  | AsyncOperationSnapshotSchema<ZodType> {
  const progress = config.progress ? { progress: config.progress.optional() } : {};
  // The one place the conditional shape still exists. It is a value here, where
  // it is correct, and never reaches a declaration.
  return z.discriminatedUnion('phase', [
    z.object({ phase: z.literal('pending'), ...progress }),
    z.object({ phase: z.literal('running'), ...progress }),
    z.object({ phase: z.literal('succeeded'), ...progress }),
    z.object({ phase: z.literal('failed'), failure: config.failure, ...progress }),
    z.object({ phase: z.literal('cancelled'), ...progress }),
  ]) as
    | AsyncOperationSnapshotSchemaWithProgress<ZodType, ZodType>
    | AsyncOperationSnapshotSchema<ZodType>;
}
