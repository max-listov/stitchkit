import { basename, resolve } from 'node:path';
import { openPinnedDirectory } from '../../internal/contained-directory';
import type { ContainedFileHandle } from '../../internal/contained-handle';
import { errnoOf } from '../../internal/errno';
import { fetchGuarded, readCapped } from '../../internal/secure-fetch';
import { writeDownload } from '../../internal/write-download';

/** Default memory cap per downloaded file — overridable via `maxDownloadBytes`. */
export const DEFAULT_DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024;

/** Download each extracted URL into `dir`, reporting per-file outcome to stderr. */
export async function downloadResults(
  files: Array<{ url: string; name: string }>,
  dir: string,
  stderr: (text: string) => void,
  quiet: boolean,
  allowPrivate: boolean,
  maxBytes: number,
  timeoutMs: number | undefined,
): Promise<boolean> {
  const root = resolve(dir);
  if (files.length === 0) return true;
  let directory: ContainedFileHandle;
  try {
    directory = await openPinnedDirectory(root, { create: true, readable: false });
  } catch (error) {
    stderr(
      `failed to prepare download directory: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return false;
  }
  let succeeded = true;
  try {
    for (const file of files) {
      try {
        // `file.url` is handler/remote-derived → SSRF-guard it (private hosts,
        // non-http(s) schemes, per-redirect-hop) and cap the body so a hostile or
        // huge resource cannot OOM the CLI.
        const res = await fetchGuarded(new URL(file.url), allowPrivate, { timeoutMs });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buffer = await readCapped(res, maxBytes);
        if (!buffer) throw new Error(`file exceeds the ${maxBytes}-byte cap`);
        // Names are direct children; the descriptor, not this display path, owns the write.
        const name = basename(file.name);
        await writeDownload(directory, name, buffer);
        if (!quiet)
          stderr(`saved ${resolve(root, name)} (${(buffer.length / 1024).toFixed(0)}KB)\n`);
      } catch (err) {
        succeeded = false;
        // A filesystem error text names descriptor paths; the code says what happened.
        const reason = errnoOf(err) ?? (err instanceof Error ? err.message : String(err));
        stderr(`failed to download ${file.url}: ${reason}\n`);
      }
    }
  } finally {
    try {
      await directory.close();
    } catch (error) {
      succeeded = false;
      stderr(
        `failed to close download directory: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
  return succeeded;
}
