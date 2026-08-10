/**
 * `mountDownload` — a generic native MCP tool that saves a result URL to the
 * local filesystem. The app injects how to resolve the URL from the call's
 * args; the fetch / extension / write mechanics live here. → ADR 0019.
 */
import { basename, extname, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { fetchGuarded, readCapped } from '../internal/secure-fetch';
import { isRecord } from '../internal/typed';
import { writeDownload } from '../internal/write-download';
import { assertToolName } from './names';
import { textResult } from './native-result';

/** Default memory cap for a download — overridable per tool via `maxBytes`. */
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;

const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/ogg': '.ogg',
};

/** File extension from the content-type, else the URL path, else `.bin`. */
function extensionFor(url: string, mime: string): string {
  if (MIME_EXT[mime]) return MIME_EXT[mime];
  try {
    const ext = extname(new URL(url).pathname).toLowerCase();
    if (ext) return ext;
  } catch {
    // Not a parseable URL — fall through to the default.
  }
  return '.bin';
}

/** Base file name from the URL path, capped — `download` when not parseable. */
function baseNameFor(url: string): string {
  try {
    const path = new URL(url).pathname;
    return (basename(path, extname(path)) || 'download').slice(0, 60);
  } catch {
    return 'download';
  }
}

export interface DownloadToolConfig {
  /** Tool name. Default `'download'`. */
  name?: string;
  description: string;
  /** Tool input shape (e.g. `{ url: z.string().optional(), id: z.string().optional() }`). */
  inputSchema: z.ZodRawShape;
  /** Resolve the args to a media URL — `null` when there is nothing to download. */
  resolveUrl: (args: Record<string, unknown>) => Promise<string | null> | string | null;
  /** Directory to save into by default. */
  defaultDir: string;
  /** Read a per-call output directory from the args. */
  dirFromArgs?: (args: Record<string, unknown>) => string | undefined;
  /**
   * Allow downloading from private / internal / loopback hosts. Default `false`
   * — the SSRF guard, since the URL comes from model-controlled args. Enable
   * only in a trusted network.
   */
  allowPrivateHosts?: boolean;
  /** Max bytes to read before aborting (memory cap). Default 100 MB. */
  maxBytes?: number;
}

/**
 * Register a native "download" tool — resolves a URL from the args, fetches it
 * and writes it to disk with a content-type / URL-derived extension. Returns
 * the saved path / size / mime.
 */
export function mountDownload(server: McpServer, config: DownloadToolConfig): void {
  const name = config.name ?? 'download';
  // A native tool lands in the SAME `tools/list` as the contract tools, so one
  // undeliverable name here takes them all down too. → ADR 0035.
  assertToolName(name, '<native>', 'download');
  server.registerTool(
    name,
    { description: config.description, inputSchema: z.object(config.inputSchema) },
    async (rawArgs) => {
      const args: Record<string, unknown> = isRecord(rawArgs) ? rawArgs : {};
      // One boundary for every failure mode — resolveUrl, fetch rejection,
      // mkdir/writeFile (EACCES/ENOSPC), body stream — all report with the
      // same `Download failed:` prefix rather than a bare rejection.
      try {
        const url = await config.resolveUrl(args);
        if (!url) return textResult('Nothing to download.', true);

        // SSRF guard: the URL is model-derived, so route it through the same
        // per-redirect-hop private-host / scheme check `view_file` uses.
        const res = await fetchGuarded(new URL(url), config.allowPrivateHosts ?? false);
        if (!res.ok) return textResult(`Download failed: HTTP ${res.status}`, true);

        const mimeType =
          (res.headers.get('content-type') ?? '').split(';')[0]?.trim() ||
          'application/octet-stream';
        const max = config.maxBytes ?? DEFAULT_MAX_BYTES;
        const declared = Number(res.headers.get('content-length') ?? 0);
        if (declared > max) {
          await res.body?.cancel();
          return textResult(`Download failed: file exceeds the ${max}-byte cap`, true);
        }
        // Size cap: a model-controlled URL must not OOM the process via an
        // unbounded / understated-length body. `baseNameFor` is basename-only,
        // so the filename cannot traverse out of `dir`.
        const buffer = await readCapped(res, max);
        if (!buffer)
          return textResult(`Download failed: file exceeds the ${max}-byte cap`, true);

        const dir = config.dirFromArgs?.(args) ?? config.defaultDir;
        const filePath = join(dir, `${baseNameFor(url)}${extensionFor(url, mimeType)}`);
        await writeDownload(dir, filePath, buffer);

        return textResult(
          JSON.stringify({ path: filePath, size: buffer.length, mimeType }, null, 2),
        );
      } catch (err) {
        return textResult(
          `Download failed: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }
    },
  );
}
