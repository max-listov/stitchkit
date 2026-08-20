import { basename, extname, resolve } from 'node:path';
import { z } from 'zod';
import { fetchGuarded, readCapped } from '../internal/secure-fetch';
import { writeDownload } from '../internal/write-download';

/** Default memory cap for a download — overridable per operation. */
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

/** Stable neutral result shared by raw MCP and managed runtime downloads. */
export const DownloadResultSchema = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
  mimeType: z.string(),
});

export type DownloadResult = z.infer<typeof DownloadResultSchema>;

/** Expected, caller-safe download failure; unexpected runtime errors still throw raw. */
export class DownloadOperationError extends Error {
  constructor(
    public readonly code: 'DOWNLOAD_HTTP_ERROR' | 'DOWNLOAD_TOO_LARGE',
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'DownloadOperationError';
  }
}

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

export interface DownloadOperationConfig {
  url: string;
  dir: string;
  allowPrivateHosts?: boolean;
  maxBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Fetch and persist one URL without owning tool registration or presentation. */
export async function runDownloadOperation(
  config: DownloadOperationConfig,
): Promise<DownloadResult> {
  const res = await fetchGuarded(new URL(config.url), config.allowPrivateHosts ?? false, {
    timeoutMs: config.timeoutMs,
    signal: config.signal,
  });
  if (!res.ok) {
    throw new DownloadOperationError('DOWNLOAD_HTTP_ERROR', `HTTP ${res.status}`, 502);
  }

  const mimeType =
    (res.headers.get('content-type') ?? '').split(';')[0]?.trim() ||
    'application/octet-stream';
  const max = config.maxBytes ?? DEFAULT_MAX_BYTES;
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > max) {
    await res.body?.cancel();
    throw new DownloadOperationError(
      'DOWNLOAD_TOO_LARGE',
      `file exceeds the ${max}-byte cap`,
      413,
    );
  }
  const buffer = await readCapped(res, max);
  if (!buffer) {
    throw new DownloadOperationError(
      'DOWNLOAD_TOO_LARGE',
      `file exceeds the ${max}-byte cap`,
      413,
    );
  }

  const dir = resolve(config.dir);
  const filePath = resolve(
    dir,
    `${baseNameFor(config.url)}${extensionFor(config.url, mimeType)}`,
  );
  await writeDownload(dir, filePath, buffer);
  return { path: filePath, size: buffer.length, mimeType };
}
