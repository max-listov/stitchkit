/**
 * The shapes a view-file tool speaks, and nothing that reads a file.
 *
 * Split out of `view-file.ts` because that module resolves paths, opens files
 * and fetches URLs — `node:path`, `node:fs`, `node:dns` — while these are Zod
 * and nothing else. A client that must *call* the tool needs its input and
 * output shapes, and reaching them through the implementation meant reaching
 * them through a module a browser bundle cannot initialise.
 *
 * The same defect `stitchkit/application/schemas` was created for, one
 * entrypoint over.
 */
import { z } from 'zod';

/** The most paths one call may name. Shared, because the input schema encodes it. */
export const MAX_VIEW_FILES = 20;

/**
 * Annotation telling the client who a content block is for. `audience` lists
 * `'user'` (render for the human) and/or `'assistant'` (keep in model context);
 * `priority` (0–1) hints how prominently. Same shape as the MCP resource/prompt
 * annotation.
 */
export const McpAnnotationsSchema = z.object({
  audience: z.array(z.enum(['user', 'assistant'])).optional(),
  priority: z.number().optional(),
});

export type McpAnnotations = z.infer<typeof McpAnnotationsSchema>;

/**
 * The `_meta` key under which an image or audio block carries the file name of its
 * source. A consumer that saves the bytes saves them under it, as a CLI's
 * `--output-dir` does.
 *
 * MCP's `ImageContent` and `AudioContent` have no field for a file name, and the
 * official SDK drops a field the protocol does not declare from `content` before it
 * is sent. `_meta` is the protocol's place for what a block carries beyond it, and
 * the key is namespaced because that place is shared.
 */
export const MCP_FILE_NAME_META_KEY = 'stitchkit/fileName';

/**
 * What an image and an audio block share, field for field what MCP declares: the
 * bytes as standard base64, their media type, annotations and `_meta`. Nothing else
 * belongs here — a field of our own would reach `structuredContent` and never
 * `content`.
 */
const inlineMediaShape = {
  data: z.string(),
  mimeType: z.string(),
  annotations: McpAnnotationsSchema.optional(),
  _meta: z.record(z.string(), z.unknown()).optional(),
};

export const McpImageContentSchema = z.object({
  type: z.literal('image'),
  ...inlineMediaShape,
});
export const McpAudioContentSchema = z.object({
  type: z.literal('audio'),
  ...inlineMediaShape,
});

/** An MCP content block — text / image / audio (video cannot be inlined). */
export const McpMediaContentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  McpImageContentSchema,
  McpAudioContentSchema,
]);

export type McpMediaContent = z.infer<typeof McpMediaContentSchema>;

export const ViewFileErrorSchema = z.object({
  path: z.string(),
  message: z.string(),
});

export const ViewFileOutputSchema = z.object({
  content: z.array(McpMediaContentSchema),
  errors: z.array(ViewFileErrorSchema),
});

export type ViewFileOutput = z.infer<typeof ViewFileOutputSchema>;

export const ViewFileInputSchema = z.object({
  paths: z
    .union([z.string(), z.array(z.string()).max(MAX_VIEW_FILES)])
    .describe(
      'One media URL or file path, or an array of them. Pass the array itself, not JSON written as text.',
    ),
});
