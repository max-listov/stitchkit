import { basename, resolve } from 'node:path';
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
  let succeeded = true;
  for (const file of files) {
    try {
      // `file.url` is handler/remote-derived → SSRF-guard it (private hosts,
      // non-http(s) schemes, per-redirect-hop) and cap the body so a hostile or
      // huge resource cannot OOM the CLI.
      const res = await fetchGuarded(new URL(file.url), allowPrivate, { timeoutMs });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buffer = await readCapped(res, maxBytes);
      if (!buffer) throw new Error(`file exceeds the ${maxBytes}-byte cap`);
      // `file.name` is untrusted → basename-only, then re-check containment so a
      // crafted name (`../../etc/x`, absolute path) cannot escape the output dir.
      const target = resolve(root, basename(file.name));
      await writeDownload(root, target, buffer);
      if (!quiet) stderr(`saved ${target} (${(buffer.length / 1024).toFixed(0)}KB)\n`);
    } catch (err) {
      succeeded = false;
      stderr(
        `failed to download ${file.url}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
  return succeeded;
}
