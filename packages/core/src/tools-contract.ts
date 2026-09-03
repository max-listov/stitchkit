/**
 * The shapes a tool surface speaks, without the runtime that serves them.
 *
 * `stitchkit/tools` mounts MCP, spawns processes, reads files and opens
 * sockets — five of its first-hop imports reach `node:`, so a browser bundler
 * cannot initialise it at all. Everything here is Zod and type-level code, and a
 * client that has to *call* an async operation needs exactly these: the contract
 * it was declared with, the snapshot schema it polls, the cancel result it may
 * receive, and the input and output of a view-file tool.
 *
 * Reaching them only through the implementation was contract-first failing on
 * its own promise, one entrypoint over from where
 * `stitchkit/application/schemas` fixed the same thing. The names live here and
 * `stitchkit/tools` re-exports them, so there is one list rather than two.
 *
 * Every module behind this entry is a leaf: zod and nothing else.
 * `async-operation.ts` and `view-file.ts` are 1,400 and 500 lines that reach the
 * tool runtime, the MCP server types and the `ai` package, and a module is
 * imported whole — so re-exporting from them dragged all of that into the graph
 * and, worse, into the `.d.ts`, where a consumer without the optional MCP peer
 * could not typecheck against a snapshot schema. The consumer lane caught that;
 * neither browser gate could, because both are about `node:`.
 *
 * → ADR 0156.
 */
export {
  type AsyncOperationCancelResult,
  AsyncOperationCancelResultSchema,
  type AsyncOperationCapability,
  createAsyncOperationSnapshotSchema,
} from './tools/async-operation-contract';
export { coerceJsonArgs } from './tools/coerce';
export {
  type McpAnnotations,
  McpAnnotationsSchema,
  type McpMediaContent,
  McpMediaContentSchema,
  ViewFileErrorSchema,
  ViewFileInputSchema,
  type ViewFileOutput,
  ViewFileOutputSchema,
} from './tools/view-file-contract';
