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

import { lookup } from 'node:dns/promises';
import { readFile, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { extname, resolve, sep } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

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

/** An MCP content block — text / image / audio (video cannot be inlined). */
export type McpMediaContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'audio'; data: string; mimeType: string };

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

/** True for a loopback / private / link-local / ULA / CGNAT IP literal. */
function isPrivateIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === undefined || b === undefined) return true;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (family === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (
      lower.startsWith('fe8') ||
      lower.startsWith('fe9') ||
      lower.startsWith('fea') ||
      lower.startsWith('feb') ||
      lower.startsWith('fc') ||
      lower.startsWith('fd')
    ) {
      return true;
    }
    const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped?.[1] ? isPrivateIp(mapped[1]) : false;
  }
  return false;
}

/** Refuse a URL whose host is — or resolves to — a private/internal address. */
async function assertPublicUrl(url: URL): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new Error('refusing to fetch a private address');
    return;
  }
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('refusing to fetch an internal host');
  }
  // Resolve DNS and check every address — defends against DNS rebinding.
  const records = await lookup(host, { all: true });
  for (const record of records) {
    if (isPrivateIp(record.address)) {
      throw new Error('refusing to fetch a host that resolves to a private address');
    }
  }
}

/** Read a response body into a buffer, aborting if it exceeds `max` bytes. */
async function readCapped(res: Response, max: number): Promise<Buffer | null> {
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > max) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
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
    if (!options.allowPrivateHosts) await assertPublicUrl(url);

    const res = await fetch(url);
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
  const root = resolve(options.baseDir);
  const target = resolve(root, pathOrUrl);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error('path escapes the allowed directory');
  }
  const info = await stat(target).catch(() => null);
  if (!info?.isFile()) throw new Error('file not found');
  const mimeType = extMime ?? 'application/octet-stream';
  if (info.size > MAX_INLINE_BYTES) return { tooLarge: true, mimeType };
  return { buffer: await readFile(target), mimeType };
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
      { type: 'image', data: buffer.toString('base64'), mimeType },
      { type: 'text', text: `[image] ${mimeType}, ${sizeKb}KB` },
    ];
  }
  if (mimeType.startsWith('audio/')) {
    return [
      { type: 'audio', data: buffer.toString('base64'), mimeType },
      { type: 'text', text: `[audio] ${mimeType}, ${sizeKb}KB` },
    ];
  }
  return [{ type: 'text', text: `[${mimeType}] ${sizeKb}KB — ${pathOrUrl}` }];
}

/**
 * Register the native MCP `view_file` tool on a server. Pass to
 * `createMcpHandler` via `nativeTools`. `options` controls the security
 * boundary — see `ViewFileOptions`.
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
