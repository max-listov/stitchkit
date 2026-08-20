/**
 * Native MCP `view_file` tool — materialises a media URL/path into MCP content
 * blocks so the model can SEE images and HEAR audio.
 *
 * Native (not contract-based): contract tools return JSON text via
 * `formatMcpResult`; this returns multimodal content (`image` / `audio` blocks).
 *
 * `resolveMedia` is the extractable core — when other tools need inline media
 * it becomes the shared resolver.
 *
 * Inputs are model-controlled, so this tool is guarded: URLs that resolve to a
 * private/internal address are refused (SSRF), local file access is opt-in and
 * sandboxed to a `baseDir`, and downloads are capped before they reach memory.
 */

import { extname } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { type ManagedFileBoundary, ManagedFileError } from '../files/boundary';
import { fetchGuarded, readCapped } from '../internal/secure-fetch';

/** MCP inline cap — bytes above this are returned as a link, not embedded. */
const MAX_INLINE_BYTES = 20 * 1024 * 1024;
const MAX_VIEW_FILES = 20;

/** File extension → MIME. Fallback when a URL carries no `content-type`. */
const EXT_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
};

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

export interface ViewFileOptions {
  /**
   * Managed boundary that owns local files. Omitted → local access is disabled
   * and only `http(s)` URLs are accepted.
   */
  files?: ManagedFileBoundary;
  /**
   * Allow fetching URLs that resolve to private / loopback / link-local
   * addresses. Default `false` — the SSRF guard. Enable only in a trusted
   * network where the model is allowed to reach internal hosts.
   */
  allowPrivateHosts?: boolean;
  /**
   * Deadline for producing response headers on a URL fetch (DNS, connects and
   * redirects share it). Default 15 seconds.
   */
  timeoutMs?: number;
}

interface ViewFileOperationOptions extends ViewFileOptions {
  signal?: AbortSignal;
}

type FetchedSource =
  | { buffer: Buffer; mimeType: string; bytesRead: number }
  | { tooLarge: true; mimeType: string; bytesRead: number }
  | { video: true; mimeType: string; bytesRead: number };

async function fetchSource(
  pathOrUrl: string,
  options: ViewFileOperationOptions,
  maxBytes: number,
): Promise<FetchedSource> {
  const extMime = EXT_MIME[extname(pathOrUrl).toLowerCase()];

  if (pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')) {
    const url = new URL(pathOrUrl);
    const res = await fetchGuarded(url, options.allowPrivateHosts ?? false, {
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const headerMime = (res.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
    const mimeType = headerMime || extMime || 'application/octet-stream';

    // A video body is never inlined (MCP has no video block) — do not download
    // it at all: the header already told us everything the caller can use.
    if (mimeType.startsWith('video/')) {
      await res.body?.cancel();
      return { video: true, mimeType, bytesRead: 0 };
    }
    // Reject by declared size before downloading anything.
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > maxBytes) {
      await res.body?.cancel();
      return { tooLarge: true, mimeType, bytesRead: 0 };
    }
    // No / understated Content-Length is still capped while streaming. An
    // overflow consumed up to the cap before aborting — charge the budget.
    const buffer = await readCapped(res, maxBytes);
    return buffer
      ? { buffer, mimeType, bytesRead: buffer.length }
      : { tooLarge: true, mimeType, bytesRead: maxBytes };
  }

  // Local file access is opt-in and owned by one managed boundary.
  if (!options.files) {
    throw new Error('local file paths are disabled — set files to allow them');
  }
  options.signal?.throwIfAborted();
  // Only ever read a media file — never a `config.json` / `.env` / `id_rsa`
  // that happens to sit inside the sandbox. A path with no known media
  // extension is refused before it is touched.
  if (!extMime) {
    throw new Error('refusing to read a non-media file');
  }
  try {
    const source = await options.files.read(pathOrUrl, {
      maxBytes,
      signal: options.signal,
    });
    const buffer = Buffer.from(source.bytes);
    return {
      buffer,
      mimeType: source.ref.mediaType ?? extMime,
      bytesRead: buffer.length,
    };
  } catch (error) {
    if (error instanceof ManagedFileError && error.code === 'FILE_TOO_LARGE') {
      return { tooLarge: true, mimeType: extMime, bytesRead: maxBytes };
    }
    throw error;
  }
}

type ResolvedMedia = {
  content: McpMediaContent[];
  bytes: number;
};

async function resolveMediaWithinBudget(
  pathOrUrl: string,
  options: ViewFileOperationOptions,
  maxBytes: number,
): Promise<ResolvedMedia> {
  if (maxBytes <= 0) {
    return {
      content: [
        { type: 'text', text: `[media] total inline budget exhausted — ${pathOrUrl}` },
      ],
      bytes: 0,
    };
  }

  const extMime = EXT_MIME[extname(pathOrUrl).toLowerCase()];
  if (extMime?.startsWith('video/')) {
    return {
      content: [{ type: 'text', text: `[video] ${extMime} — ${pathOrUrl}` }],
      bytes: 0,
    };
  }

  const result = await fetchSource(pathOrUrl, options, maxBytes);
  // `bytes` always reports what was actually READ, whatever branch produced it
  // — the caller's budget must shrink by real traffic, not by what was inlined.
  if ('video' in result) {
    return {
      content: [{ type: 'text', text: `[video] ${result.mimeType} — ${pathOrUrl}` }],
      bytes: result.bytesRead,
    };
  }
  if ('tooLarge' in result) {
    return {
      content: [
        { type: 'text', text: `[${result.mimeType}] too large to inline — ${pathOrUrl}` },
      ],
      bytes: result.bytesRead,
    };
  }

  const { buffer, mimeType } = result;
  const sizeKb = (buffer.length / 1024).toFixed(0);

  if (mimeType.startsWith('image/')) {
    return {
      content: [
        {
          type: 'image',
          data: buffer.toString('base64'),
          mimeType,
          annotations: { audience: ['user', 'assistant'], priority: 0.9 },
        },
        { type: 'text', text: `[image] ${mimeType}, ${sizeKb}KB` },
      ],
      bytes: buffer.length,
    };
  }
  if (mimeType.startsWith('audio/')) {
    return {
      content: [
        {
          type: 'audio',
          data: buffer.toString('base64'),
          mimeType,
          annotations: { audience: ['user', 'assistant'], priority: 0.9 },
        },
        { type: 'text', text: `[audio] ${mimeType}, ${sizeKb}KB` },
      ],
      bytes: buffer.length,
    };
  }
  return {
    content: [{ type: 'text', text: `[${mimeType}] ${sizeKb}KB — ${pathOrUrl}` }],
    bytes: buffer.length,
  };
}

/**
 * Resolve a single media path/URL into MCP content. The extractable core —
 * reusable wherever inline media is needed.
 *
 *  - `image/*` / `audio/*` → an inline base64 block — the model sees / hears it;
 *  - `video/*` → a text link (MCP has no video block);
 *  - anything else, or too large → a text link.
 */
export async function resolveMedia(
  pathOrUrl: string,
  options: ViewFileOptions = {},
): Promise<McpMediaContent[]> {
  return (await resolveMediaWithinBudget(pathOrUrl, options, MAX_INLINE_BYTES)).content;
}

export const ViewFileInputSchema = z.object({
  paths: z
    .union([z.string(), z.array(z.string()).max(MAX_VIEW_FILES)])
    .describe('Media URL(s) or file path(s) to view'),
});

/**
 * Resolve one bounded batch into neutral media content. Per-item failures stay
 * visible beside successful items; every item shares one total inline/read
 * budget so a batch cannot multiply the single-call cap.
 */
export async function runViewFileOperation(
  paths: z.output<typeof ViewFileInputSchema>['paths'],
  options: ViewFileOptions = {},
  signal?: AbortSignal,
): Promise<ViewFileOutput> {
  const list = Array.isArray(paths) ? paths : [paths];
  const content: McpMediaContent[] = [];
  const errors: ViewFileOutput['errors'] = [];
  let remainingBytes = MAX_INLINE_BYTES;
  for (const pathOrUrl of list) {
    signal?.throwIfAborted();
    try {
      const resolved = await resolveMediaWithinBudget(
        pathOrUrl,
        { ...options, signal },
        remainingBytes,
      );
      remainingBytes -= resolved.bytes;
      content.push(...resolved.content);
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ path: pathOrUrl, message });
      content.push({ type: 'text', text: `[${pathOrUrl}] Error: ${message}` });
    }
  }
  return ViewFileOutputSchema.parse({ content, errors });
}

/**
 * Register the raw native MCP `view_file` tool on an SDK server. From
 * `createMcpHandler`, pass `rawTools: (server) =>
 * mountViewFile(server, options)`. Raw registration intentionally bypasses
 * stitchkit lifecycle/hooks; use `defineViewFileTool` when those guarantees are
 * required. `options` controls the media security boundary.
 */
export function mountViewFile(server: McpServer, options: ViewFileOptions = {}): void {
  server.registerTool(
    'view_file',
    {
      description:
        'View media (image, audio, video) by URL or local path — returns it as content you can SEE / HEAR. Pass several paths to view multiple files at once. Use it on a generation `output` url to inspect the result.',
      inputSchema: ViewFileInputSchema.shape,
      // Read-only: fetches and returns media, mutates nothing. A title + hints so
      // hosts group it with the other read-only tools and show a friendly label.
      annotations: { title: 'View Media', readOnlyHint: true, idempotentHint: true },
    },
    async (args: { paths: string | string[] }) => {
      const result = await runViewFileOperation(args.paths, options);
      return { content: result.content };
    },
  );
}
