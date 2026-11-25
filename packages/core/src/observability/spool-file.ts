import { appendFile, chmod, mkdir, open, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from '../internal/atomic-file';
import { errnoOf } from '../internal/errno';

const SpoolLineSchema = z.union([
  z.strictObject({ k: z.string(), e: z.unknown() }),
  z.strictObject({ a: z.string() }),
]);

const READ_CHUNK_BYTES = 64 * 1024;

function safeJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/** A record line the file still owes: its text, and the record when it decodes. */
export interface OwedLine<T> {
  readonly line: string;
  readonly record?: T;
}

/** What a spool file still holds once its acknowledgements are applied, in file order. */
export interface SpoolScan<T> {
  /** Lines nobody could read — torn by a crash or written by a newer version: never erased. */
  readonly kept: readonly string[];
  readonly owed: ReadonlyMap<string, OwedLine<T>>;
}

/** A scan, or why the file holds more than one may keep in memory. */
export type SpoolScanResult<T> =
  | { readonly within: true; readonly scan: SpoolScan<T> }
  | { readonly within: false; readonly reason: string };

/** Bounds of one scan: the bytes of the lines kept in memory, and their count. */
export interface SpoolScanLimits {
  readonly maxBytes: number;
  readonly maxEntries: number;
}

/**
 * Read a spool file line by line, whatever its size, keeping only what it still owes: an
 * acknowledgement drops its record as it comes. Past `limits` — a single line, or the owed and
 * kept lines together — the scan stops and says so, rather than hold the file in memory.
 */
export async function scanSpoolFile<T>(
  path: string,
  decode: (value: unknown) => T,
  limits: SpoolScanLimits,
  onUnreadable?: (error: unknown) => void,
): Promise<SpoolScanResult<T>> {
  const kept: string[] = [];
  const owed = new Map<string, OwedLine<T>>();
  let retained = 0;
  const decoder = new TextDecoder();
  const take = (line: string): string | undefined => {
    if (line.length === 0) return undefined;
    const parsed = SpoolLineSchema.safeParse(safeJson(line));
    if (!parsed.success) {
      onUnreadable?.(parsed.error);
      kept.push(line);
      retained += Buffer.byteLength(line);
    } else if ('a' in parsed.data) {
      const acknowledged = owed.get(parsed.data.a);
      if (acknowledged !== undefined) retained -= Buffer.byteLength(acknowledged.line);
      owed.delete(parsed.data.a);
    } else {
      let record: T | undefined;
      try {
        record = decode(parsed.data.e);
      } catch (error) {
        onUnreadable?.(error);
      }
      const previous = owed.get(parsed.data.k);
      if (previous !== undefined) retained -= Buffer.byteLength(previous.line);
      owed.set(parsed.data.k, record === undefined ? { line } : { line, record });
      retained += Buffer.byteLength(line);
    }
    if (retained > limits.maxBytes)
      return `its owed and unreadable lines exceed ${limits.maxBytes} bytes`;
    if (kept.length + owed.size > limits.maxEntries)
      return `it owes more than ${limits.maxEntries} records`;
    return undefined;
  };
  const handle = await open(path, 'r');
  try {
    const buffer = new Uint8Array(READ_CHUNK_BYTES);
    let pending: Uint8Array[] = [];
    let pendingBytes = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      let start = 0;
      for (let index = 0; index < bytesRead; index += 1) {
        if (buffer[index] !== 0x0a) continue;
        pending.push(buffer.slice(start, index));
        const line = decoder.decode(Buffer.concat(pending));
        pending = [];
        pendingBytes = 0;
        start = index + 1;
        const beyond = take(line);
        if (beyond !== undefined) return { within: false, reason: beyond };
      }
      pending.push(buffer.slice(start, bytesRead));
      pendingBytes += bytesRead - start;
      if (pendingBytes > limits.maxBytes)
        return { within: false, reason: `a line exceeds ${limits.maxBytes} bytes` };
    }
    const beyond = take(decoder.decode(Buffer.concat(pending)));
    if (beyond !== undefined) return { within: false, reason: beyond };
  } finally {
    await handle.close();
  }
  return { within: true, scan: { kept, owed } };
}

/** The file a scan describes, rewritten: unreadable lines kept, then each owed record. */
export function spoolBodyOf<T>(scan: SpoolScan<T>): string {
  return [...scan.kept, ...[...scan.owed.values()].map((owed) => owed.line)]
    .map((line) => `${line}\n`)
    .join('');
}

/** The owed records that decode, in the order they were written. */
export function owedRecordsOf<T>(scan: SpoolScan<T>): Map<string, T> {
  const records = new Map<string, T>();
  for (const [key, owed] of scan.owed)
    if (owed.record !== undefined) records.set(key, owed.record);
  return records;
}

/** Where a spool's debt goes when it does not fit: beside the file, never over it. */
function asidePath(path: string): string {
  return `${path}.${Date.now()}.overflow`;
}

/** Move the whole spool file aside; answers where it went. */
export async function moveSpoolAside(path: string): Promise<string> {
  const target = asidePath(path);
  await rename(path, target);
  return target;
}

/** Write `body` — a spool file's debt — beside it, private like the spool; answers where. */
export async function writeSpoolAside(path: string, body: string): Promise<string> {
  const target = asidePath(path);
  await writeFileAtomic(target, body, { mode: 0o600 });
  return target;
}

/**
 * The spool file's size, with a torn last line (a crash mid-append) closed off and the
 * mode set; `0` when there is no file.
 */
export async function openSpoolFile(path: string): Promise<number> {
  let size: number;
  try {
    const handle = await open(path, 'r');
    try {
      size = (await handle.stat()).size;
      let torn = false;
      if (size > 0) {
        const last = Buffer.alloc(1);
        await handle.read(last, 0, 1, size - 1);
        torn = last[0] !== 0x0a;
      }
      if (torn) {
        await appendFile(path, '\n');
        size += 1;
      }
    } finally {
      await handle.close();
    }
    await chmod(path, 0o600);
  } catch (error) {
    if (errnoOf(error) !== 'ENOENT') throw error;
    return 0;
  }
  return size;
}

/** Append one line, creating the file `0o600` and its directory when missing. */
export async function appendSpoolLine(path: string, text: string): Promise<void> {
  try {
    await appendFile(path, text, { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    // ENOENT here is the directory: `appendFile` creates the file, not the path above it.
    if (errnoOf(error) !== 'ENOENT') throw error;
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, text, { encoding: 'utf8', mode: 0o600 });
  }
}
