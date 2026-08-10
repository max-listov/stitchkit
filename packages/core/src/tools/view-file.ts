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

import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { fetchGuarded, readCapped } from '../internal/secure-fetch';
import { isWithinDir } from '../internal/within-dir';

/** MCP inline cap — bytes above this are returned as a link, not embedded. */
const MAX_INLINE_BYTES = 20 * 1024 * 1024;

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
export interface McpAnnotations {
  audience?: ('user' | 'assistant')[];
  priority?: number;
}

/** An MCP content block — text / image / audio (video cannot be inlined). */
export type McpMediaContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string; annotations?: McpAnnotations }
  | { type: 'audio'; data: string; mimeType: string; annotations?: McpAnnotations };

export interface ViewFileOptions {
  /**
   * Directory that local file paths must resolve within. Omitted → local file
   * access is disabled and only `http(s)` URLs are accepted.
   */
  baseDir?: string;
  /**
   * Allow fetching URLs that resolve to private / loopback / link-local
   * addresses. Default `false` — the SSRF guard. Enable only in a trusted
   * network where the model is allowed to reach internal hosts.
   */
  allowPrivateHosts?: boolean;
}

type FetchedSource =
  | { buffer: Buffer; mimeType: string }
  | { tooLarge: true; mimeType: string };

async function fetchSource(
  pathOrUrl: string,
  options: ViewFileOptions,
): Promise<FetchedSource> {
  const extMime = EXT_MIME[extname(pathOrUrl).toLowerCase()];

  if (pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')) {
    const url = new URL(pathOrUrl);
    const res = await fetchGuarded(url, options.allowPrivateHosts ?? false);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const headerMime = (res.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
    const mimeType = headerMime || extMime || 'application/octet-stream';

    // Reject by declared size before downloading anything.
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > MAX_INLINE_BYTES) {
      await res.body?.cancel();
      return { tooLarge: true, mimeType };
    }
    // No / understated Content-Length is still capped while streaming.
    const buffer = await readCapped(res, MAX_INLINE_BYTES);
    return buffer ? { buffer, mimeType } : { tooLarge: true, mimeType };
  }

  // Local file access is opt-in and sandboxed to `baseDir`.
  if (!options.baseDir) {
    throw new Error('local file paths are disabled — set baseDir to allow them');
  }
  // Only ever read a media file — never a `config.json` / `.env` / `id_rsa`
  // that happens to sit inside the sandbox. A path with no known media
  // extension is refused before it is touched.
  if (!extMime) {
    throw new Error('refusing to read a non-media file');
  }
  const root = resolve(options.baseDir);
  const target = resolve(root, pathOrUrl);
  if (!isWithinDir(root, target)) {
    throw new Error('path escapes the allowed directory');
  }
  // Re-check the real, symlink-resolved paths so a symlink inside the sandbox
  // cannot point out of it (and so a sandbox reached through a symlink still
  // matches). `realpath` of a missing file rejects → treated as not found.
  const realTarget = await realpath(target).catch(() => null);
  if (realTarget === null) throw new Error('file not found');
  const realRoot = await realpath(root).catch(() => root);
  if (!isWithinDir(realRoot, realTarget)) {
    throw new Error('path escapes the allowed directory');
  }
  const info = await stat(realTarget).catch(() => null);
  if (!info?.isFile()) throw new Error('file not found');
  if (info.size > MAX_INLINE_BYTES) return { tooLarge: true, mimeType: extMime };
  return { buffer: await readFile(realTarget), mimeType: extMime };
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
  // Never download video — detect by extension and return a link immediately.
  const extMime = EXT_MIME[extname(pathOrUrl).toLowerCase()];
  if (extMime?.startsWith('video/')) {
    return [{ type: 'text', text: `[video] ${extMime} — ${pathOrUrl}` }];
  }

  const result = await fetchSource(pathOrUrl, options);
  if ('tooLarge' in result) {
    return [{ type: 'text', text: `[${result.mimeType}] too large to inline — ${pathOrUrl}` }];
  }

  const { buffer, mimeType } = result;
  const sizeKb = (buffer.length / 1024).toFixed(0);

  if (mimeType.startsWith('video/')) {
    return [{ type: 'text', text: `[video] ${mimeType}, ${sizeKb}KB — ${pathOrUrl}` }];
  }
  if (mimeType.startsWith('image/')) {
    return [
      {
        type: 'image',
        data: buffer.toString('base64'),
        mimeType,
        // Both audiences — the user sees it inline in the chat AND the model
        // keeps it in context to verify the result. `['user']` alone would hide
        // it from the model; the default (none) hides it from the user.
        annotations: { audience: ['user', 'assistant'], priority: 0.9 },
      },
      { type: 'text', text: `[image] ${mimeType}, ${sizeKb}KB` },
    ];
  }
  if (mimeType.startsWith('audio/')) {
    return [
      {
        type: 'audio',
        data: buffer.toString('base64'),
        mimeType,
        annotations: { audience: ['user', 'assistant'], priority: 0.9 },
      },
      { type: 'text', text: `[audio] ${mimeType}, ${sizeKb}KB` },
    ];
  }
  return [{ type: 'text', text: `[${mimeType}] ${sizeKb}KB — ${pathOrUrl}` }];
}

/**
 * Register the raw native MCP `view_file` tool on an SDK server. From
 * `createMcpHandler`, pass `rawTools: (server) =>
 * mountViewFile(server, options)`. Raw registration intentionally bypasses
 * stitchkit lifecycle/hooks; use a `defineRuntimeTool` + `resolveMedia` when
 * those guarantees are required. `options` controls the media security boundary.
 */
export function mountViewFile(server: McpServer, options: ViewFileOptions = {}): void {
  server.registerTool(
    'view_file',
    {
      description:
        'View media (image, audio, video) by URL or local path — returns it as content you can SEE / HEAR. Pass several paths to view multiple files at once. Use it on a generation `output` url to inspect the result.',
      inputSchema: {
        paths: z
          .union([z.string(), z.array(z.string())])
          .describe('Media URL(s) or file path(s) to view'),
      },
      // Read-only: fetches and returns media, mutates nothing. A title + hints so
      // hosts group it with the other read-only tools and show a friendly label.
      annotations: { title: 'View Media', readOnlyHint: true, idempotentHint: true },
    },
    async (args: { paths: string | string[] }) => {
      const list = Array.isArray(args.paths) ? args.paths : [args.paths];
      const content: McpMediaContent[] = [];
      for (const pathOrUrl of list) {
        try {
          content.push(...(await resolveMedia(pathOrUrl, options)));
        } catch (err) {
          content.push({
            type: 'text',
            text: `[${pathOrUrl}] Error: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
      return { content };
    },
  );
}
