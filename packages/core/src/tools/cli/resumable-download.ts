/**
 * Download a CLI build so that a slow or broken link costs time, not progress.
 *
 * Without a `partialPath` the transfer is held in memory, as it always was, and only the idle
 * bound is new. With one, every received chunk is appended to that file and a description of
 * what it holds — the URL, the build's digest and the server's validator — is written beside
 * it, so the next attempt asks for the rest (`Range: bytes=N-`, `If-Range: <validator>`)
 * instead of starting over. The server decides: `206` from the right offset continues the
 * file, `200` replaces it, `416` with the full length means it is already whole.
 *
 * Nothing about a continued file is trusted. The finished transfer is decoded and checked
 * against the manifest exactly like a fresh one; a continued file that fails — a corrupt
 * part, a build replaced on the server under the same name — is thrown away and downloaded
 * once more from zero, and a fresh one that fails is a refusal.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { writeFileAtomicSync } from '../../internal/atomic-file';
import { fetchGuarded, readCapped } from '../../internal/secure-fetch';
import { ExclusiveLockError, withExclusiveLock } from '../../internal/with-exclusive-lock';

export interface CliAssetDownload {
  url: URL;
  /** The build's digest from the manifest — what makes a kept part this build's part. */
  sha256: string;
  allowPrivateHosts: boolean;
  /** Ceiling on transferred bytes, a continued part included. */
  maxBytes: number;
  timeoutMs: number;
  idleTimeoutMs?: number;
  /** Keep the transfer here between attempts; without it nothing survives a failure. */
  partialPath?: string;
}

const PartialRecordSchema = z.object({
  url: z.string(),
  sha256: z.string(),
  /** A strong `ETag` or a `Last-Modified` date — what `If-Range` repeats back. */
  validator: z.string().optional(),
});
type PartialRecord = z.infer<typeof PartialRecordSchema>;

/** One transfer: the bytes, and whether they continued a kept part. */
interface Transfer {
  bytes: Uint8Array;
  continued: boolean;
}

/**
 * Download the asset and hand it to `decode`, which throws when the bytes are not the build.
 * Returns what `decode` returns.
 */
export async function downloadCliAsset<T>(
  config: CliAssetDownload,
  decode: (bytes: Uint8Array) => Promise<T>,
): Promise<T> {
  const { partialPath } = config;
  if (partialPath === undefined) return decode(await downloadInMemory(config));
  mkdirSync(dirname(partialPath), { recursive: true, mode: 0o700 });
  try {
    return await withExclusiveLock(
      `${partialPath}.lock`,
      async () => {
        const first = await downloadToPart(config, partialPath, true);
        try {
          return await decodeAndForget(first, partialPath, decode);
        } catch (error) {
          if (!first.continued) throw error;
          // The part may have been corrupt or another build's: one clean attempt settles it.
          return decodeAndForget(
            await downloadToPart(config, partialPath, false),
            partialPath,
            decode,
          );
        }
      },
      { timeoutMs: 0, label: 'CLI update download' },
    );
  } catch (error) {
    if (error instanceof ExclusiveLockError && error.code === 'LOCK_TIMEOUT') {
      throw new Error(
        `[stitchkit] update: another update is already downloading into ${partialPath}`,
        { cause: error },
      );
    }
    throw error;
  }
}

async function decodeAndForget<T>(
  transfer: Transfer,
  partialPath: string,
  decode: (bytes: Uint8Array) => Promise<T>,
): Promise<T> {
  try {
    return await decode(transfer.bytes);
  } finally {
    // Decoded or refused, the part has served: kept, a corrupt one would be continued forever.
    forgetPart(partialPath);
  }
}

async function downloadInMemory(config: CliAssetDownload): Promise<Uint8Array> {
  const response = await fetchGuarded(
    config.url,
    config.allowPrivateHosts,
    fetchOptions(config),
  );
  if (!response.ok) {
    throw new Error(`[stitchkit] update download responded ${response.status}`);
  }
  const transferred = await readCapped(response, config.maxBytes);
  if (!transferred) throw new Error('[stitchkit] update download exceeded the size ceiling');
  return transferred;
}

function fetchOptions(config: CliAssetDownload, headers?: Record<string, string>) {
  return {
    timeoutMs: config.timeoutMs,
    bodyTimeoutMs: config.timeoutMs,
    ...(config.idleTimeoutMs !== undefined && { idleTimeoutMs: config.idleTimeoutMs }),
    ...(headers && { headers }),
  };
}

function recordPath(partialPath: string): string {
  return `${partialPath}.json`;
}

function forgetPart(partialPath: string): void {
  rmSync(partialPath, { force: true });
  rmSync(recordPath(partialPath), { force: true });
}

/** The kept part's length, when it is a part of this very build; otherwise it is removed. */
function keptLength(
  config: CliAssetDownload,
  partialPath: string,
): {
  offset: number;
  record?: PartialRecord;
} {
  if (!existsSync(partialPath) || !existsSync(recordPath(partialPath))) {
    forgetPart(partialPath);
    return { offset: 0 };
  }
  let record: PartialRecord | undefined;
  try {
    const parsed = PartialRecordSchema.safeParse(
      JSON.parse(readFileSync(recordPath(partialPath), 'utf8')),
    );
    if (parsed.success) record = parsed.data;
  } catch {
    record = undefined;
  }
  if (!record || record.url !== config.url.href || record.sha256 !== config.sha256) {
    forgetPart(partialPath);
    return { offset: 0 };
  }
  const offset = statSync(partialPath).size;
  if (offset > config.maxBytes) {
    forgetPart(partialPath);
    return { offset: 0 };
  }
  return { offset, record };
}

/** A `Content-Range` value (`bytes A-B/N`, or `*` for the range) → its start and total, or `null`. */
function readContentRange(value: string | null): { start?: number; total?: number } | null {
  if (value === null) return null;
  const match = /^bytes\s+(?:(\d+)-\d+|\*)\/(\d+|\*)$/i.exec(value.trim());
  if (!match) return null;
  return {
    ...(match[1] !== undefined && { start: Number(match[1]) }),
    ...(match[2] !== '*' && match[2] !== undefined && { total: Number(match[2]) }),
  };
}

/** What `If-Range` may repeat: a strong `ETag`, else `Last-Modified`; a weak tag is neither. */
function validatorOf(response: Response): string | undefined {
  const etag = response.headers.get('etag');
  if (etag && !etag.startsWith('W/')) return etag;
  return response.headers.get('last-modified') ?? undefined;
}

async function downloadToPart(
  config: CliAssetDownload,
  partialPath: string,
  resume: boolean,
): Promise<Transfer> {
  if (!resume) forgetPart(partialPath);
  const kept = resume ? keptLength(config, partialPath) : { offset: 0 };
  const headers: Record<string, string> = {};
  if (kept.offset > 0) {
    headers.range = `bytes=${kept.offset}-`;
    if (kept.record?.validator) headers['if-range'] = kept.record.validator;
  }
  const response = await fetchGuarded(
    config.url,
    config.allowPrivateHosts,
    fetchOptions(config, headers),
  );
  if (kept.offset > 0 && response.status === 416) {
    await response.body?.cancel().catch(() => undefined);
    // The part may already be the whole file; anything else about it is unknown.
    if (readContentRange(response.headers.get('content-range'))?.total === kept.offset) {
      return { bytes: readFileSync(partialPath), continued: true };
    }
    return downloadToPart(config, partialPath, false);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`[stitchkit] update download responded ${response.status}`);
  }
  let offset = 0;
  if (kept.offset > 0 && response.status === 206) {
    if (readContentRange(response.headers.get('content-range'))?.start !== kept.offset) {
      await response.body?.cancel().catch(() => undefined);
      return downloadToPart(config, partialPath, false);
    }
    offset = kept.offset;
  } else if (response.status === 206) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('[stitchkit] update download answered a range nobody asked for');
  }
  const validator = offset > 0 ? kept.record?.validator : validatorOf(response);
  // A fresh body starts from an empty part before the record names its validator: a record that
  // described bytes the part does not hold would continue another build's file.
  if (offset === 0) rmSync(partialPath, { force: true });
  writeFileAtomicSync(
    recordPath(partialPath),
    JSON.stringify({
      url: config.url.href,
      sha256: config.sha256,
      ...(validator !== undefined && { validator }),
    }),
    { mode: 0o600 },
  );
  await appendBody(response, partialPath, offset, config.maxBytes);
  return { bytes: readFileSync(partialPath), continued: offset > 0 };
}

/** Append the body to the part; a failure keeps what arrived and says so. */
async function appendBody(
  response: Response,
  partialPath: string,
  offset: number,
  maxBytes: number,
): Promise<void> {
  const out = await open(partialPath, offset > 0 ? 'a' : 'w', 0o600);
  let total = offset;
  try {
    if (response.body) {
      for await (const chunk of response.body) {
        if (total + chunk.byteLength > maxBytes) throw new SizeCeilingError();
        await out.write(chunk);
        total += chunk.byteLength;
      }
    }
  } catch (error) {
    await out.close().catch(() => undefined);
    if (error instanceof SizeCeilingError) {
      forgetPart(partialPath);
      throw new Error('[stitchkit] update download exceeded the size ceiling');
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `[stitchkit] update download stopped after ${total} bytes (${reason}); ` +
        `they are kept in ${partialPath} and the next update continues from there`,
      { cause: error },
    );
  }
  await out.close();
}

class SizeCeilingError extends Error {}
