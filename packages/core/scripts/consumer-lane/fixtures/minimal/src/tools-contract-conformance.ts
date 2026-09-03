/**
 * `stitchkit/tools/contract`, imported by name, by a consumer with no optional
 * peer installed.
 *
 * Until 0.79.1 nothing in this lane named this entrypoint. Its declarations did
 * reach the strict check — but only sideways, dragged in by `stitchkit/tools`
 * in the `full` fixture, which installs every peer. So the entry that exists
 * *for* a peer-free client was covered by a coincidence: had `full` stopped
 * importing `stitchkit/tools`, the coverage would have disappeared with no gate
 * saying anything, and `dist/tools-contract.d.ts` itself was never in any
 * program at all.
 *
 * Both halves of what it promises are asserted here: the schemas type and parse
 * without `@modelcontextprotocol/*` or `ai` present, and both overloads of the
 * snapshot factory produce the shape they say they do.
 */
import {
  type AsyncOperationCancelResult,
  AsyncOperationCancelResultSchema,
  type AsyncOperationCapability,
  type AsyncOperationSnapshotSchema,
  type AsyncOperationSnapshotSchemaWithProgress,
  createAsyncOperationSnapshotSchema,
  ViewFileInputSchema,
} from 'stitchkit/tools/contract';
import { z } from 'zod';

const Progress = z.object({ done: z.number(), total: z.number() });
const Failure = z.object({ code: z.string() });

// Named on purpose: an unexported return type compiles inside the package and
// fails right here.
const withProgress: AsyncOperationSnapshotSchemaWithProgress<typeof Progress, typeof Failure> =
  createAsyncOperationSnapshotSchema({ progress: Progress, failure: Failure });
const withoutProgress: AsyncOperationSnapshotSchema<typeof Failure> =
  createAsyncOperationSnapshotSchema({ failure: Failure });

const running = withProgress.parse({ phase: 'running', progress: { done: 1, total: 4 } });
if (running.phase !== 'running' || running.progress?.done !== 1) {
  throw new Error('progress snapshot did not round-trip');
}

const pending = withoutProgress.parse({ phase: 'pending' });
if (pending.phase !== 'pending') throw new Error('no-progress snapshot did not round-trip');

// The behaviour the overloads exist to preserve: an unconfigured `progress` is
// stripped, not refused.
if ('progress' in withoutProgress.parse({ phase: 'running', progress: { done: 1 } })) {
  throw new Error('an unconfigured progress key survived parsing');
}

const cancel: AsyncOperationCancelResult = AsyncOperationCancelResultSchema.parse({
  outcome: 'rejected',
  reason: 'not cancellable',
});
if (cancel.outcome !== 'rejected') throw new Error('cancel result did not round-trip');

const capability: AsyncOperationCapability = 'status';
const viewFile = ViewFileInputSchema.parse({ paths: 'README.md' });

console.log(
  `tools contract conformance: ok (${capability}, ${String(viewFile.paths)}, ${cancel.outcome})`,
);
