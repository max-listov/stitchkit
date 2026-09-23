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

/** An MCP content block — text / image / audio (video cannot be inlined). */
export const McpMediaContentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('image'),
    data: z.string(),
    mimeType: z.string(),
    annotations: McpAnnotationsSchema.optional(),
  }),
  z.object({
    type: z.literal('audio'),
    data: z.string(),
    mimeType: z.string(),
    annotations: McpAnnotationsSchema.optional(),
  }),
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
    .describe('Media URL(s) or file path(s) to view'),
});
