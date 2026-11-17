import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { openPinnedDirectory } from '../../internal/contained-directory';
import type { ContainedFileHandle } from '../../internal/contained-handle';
import { errnoOf } from '../../internal/errno';
import { fetchGuarded, readCapped } from '../../internal/secure-fetch';
import { writeDownload } from '../../internal/write-download';
import {
  type InlineFileBlock,
  inlineFileBlocks,
  inlineFileBytes,
  inlineFileName,
  linkSavedFiles,
} from './inline-files';

/** Default decoded byte cap per file — overridable via `maxDownloadBytes`. */
export const DEFAULT_DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024;

interface UrlMedia {
  url: string;
  name: string;
}

type MediaSource = UrlMedia | InlineFileBlock;

interface SavedFile {
  /** The display path printed in `saved`; the pinned root, not this path, owned the write. */
  path: string;
  name: string;
  size: number;
}

export interface SaveResultMediaOptions {
  /** `--output-dir` as typed; resolved and pinned once for the whole batch. */
  dir: string;
  /** The application's `download` callback: the URL media a result names. */
  download: ((result: unknown) => UrlMedia[]) | undefined;
  allowPrivateHosts: boolean;
  maxBytes: number;
  timeoutMs: number | undefined;
  quiet: boolean;
  stderr: (text: string) => void;
}

/**
 * `--output-dir`: save the URL files a successful result names and the files its `content`
 * carries inline as one batch, reporting each outcome to stderr. `ok` is false when any file
 * failed. `data` is the result as stdout prints it: a saved inline block is a link to its
 * file, everything else is as it was.
 */
export async function saveResultMedia(
  data: unknown,
  options: SaveResultMediaOptions,
): Promise<{ ok: boolean; data: unknown }> {
  const blocks = inlineFileBlocks(data);
  const sources: MediaSource[] = [...(options.download?.(data) ?? []), ...blocks];
  if (sources.length === 0) {
    if (!options.quiet) options.stderr('--output-dir: the result carries no files to save\n');
    return { ok: true, data };
  }
  const batch = await saveBatch(sources, options);
  return {
    ok: batch.ok,
    data: linkSavedFiles(data, blocks, (block) => batch.files.get(block)),
  };
}

/** Write every source through one pinned root; a failed source never stops its neighbours. */
async function saveBatch(
  sources: readonly MediaSource[],
  { dir, allowPrivateHosts, maxBytes, timeoutMs, quiet, stderr }: SaveResultMediaOptions,
): Promise<{ ok: boolean; files: Map<MediaSource, SavedFile> }> {
  const root = resolve(dir);
  const files = new Map<MediaSource, SavedFile>();
  let directory: ContainedFileHandle;
  try {
    directory = await openPinnedDirectory(root, { create: true, readable: false });
  } catch (error) {
    stderr(
      `failed to prepare download directory: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return { ok: false, files };
  }
  let ok = true;
  // A name is written once per batch. The same bytes again are already saved; different
  // bytes under that name would replace the first file while both report `saved`.
  const digests = new Map<string, string>();
  try {
    for (const source of sources) {
      try {
        const bytes =
          'url' in source
            ? await fetchDownload(source.url, allowPrivateHosts, maxBytes, timeoutMs)
            : inlineFileBytes(source.file, maxBytes);
        const digest = createHash('sha256').update(bytes).digest('hex');
        // Names are direct children; the descriptor, not the display path, owns the write.
        const name = basename(
          'url' in source ? source.name : inlineFileName(source.file, digest),
        );
        const path = resolve(root, name);
        const written = digests.get(name);
        if (written === undefined) {
          await writeDownload(directory, name, bytes);
          digests.set(name, digest);
          if (!quiet) stderr(`saved ${path} (${(bytes.length / 1024).toFixed(0)}KB)\n`);
        } else if (written !== digest) {
          throw new Error(
            `another file of this batch is already saved as ${JSON.stringify(name)}`,
          );
        }
        files.set(source, { path, name, size: bytes.length });
      } catch (err) {
        ok = false;
        // A filesystem error text names descriptor paths; the code says what happened.
        const reason = errnoOf(err) ?? (err instanceof Error ? err.message : String(err));
        const subject =
          'url' in source
            ? `failed to download ${source.url}`
            : `failed to save content[${source.index}]`;
        stderr(`${subject}: ${reason}\n`);
      }
    }
  } finally {
    try {
      await directory.close();
    } catch (error) {
      ok = false;
      stderr(
        `failed to close download directory: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
  return { ok, files };
}

/** Handler-derived URLs keep their per-hop SSRF guard, header deadline and body cap. */
async function fetchDownload(
  url: string,
  allowPrivateHosts: boolean,
  maxBytes: number,
  timeoutMs: number | undefined,
): Promise<Buffer> {
  const res = await fetchGuarded(new URL(url), allowPrivateHosts, { timeoutMs });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const bytes = await readCapped(res, maxBytes);
  if (!bytes) throw new Error(`file exceeds the ${maxBytes}-byte cap`);
  return bytes;
}
