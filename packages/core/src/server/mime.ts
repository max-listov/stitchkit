/**
 * Extension → MIME map shared by `staticRoute` and `serveFile`. Covers the web
 * asset types plus the media / document types that benefit from Range requests
 * (`serveFile`). Not exhaustive — unknown extensions fall back to
 * `application/octet-stream`, and a caller can always pass an explicit
 * `contentType`.
 */
import { extname } from 'node:path';

const MIME_BY_EXT: Record<string, string> = {
  // Web assets
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  // Media (Range-seekable)
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.oga': 'audio/ogg',
  '.ogg': 'audio/ogg',
  // Documents / archives
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
};

/** MIME type for a path's extension, or `application/octet-stream` if unknown. */
export function mimeForPath(path: string): string {
  return MIME_BY_EXT[extname(path).toLowerCase()] ?? 'application/octet-stream';
}
