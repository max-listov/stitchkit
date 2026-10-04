import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createGunzip, createGzip } from 'node:zlib';
import type { CliBuildAsset } from './manifest';
import { waitForPublication } from './publication-control';

/** Fixed-size blocks keep a one-byte-per-chunk source inside the byte memory budget. */
export async function collectCliBytes(
  source: Uint8Array | ReadableStream<unknown> | NodeReadableStream<unknown>,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    throw new RangeError('CLI asset byte cap must be a positive safe integer');
  const blocks: Uint8Array[] = [];
  let total = 0;
  let filled = 0;
  let block: Uint8Array | undefined;
  const consume = (chunk: unknown) => {
    signal?.throwIfAborted();
    if (!(chunk instanceof Uint8Array))
      throw new TypeError('CLI asset stream must contain Uint8Array chunks');
    if (total + chunk.byteLength > maxBytes)
      throw new RangeError(`CLI asset exceeds ${maxBytes} bytes`);
    for (let offset = 0; offset < chunk.byteLength; ) {
      if (!block || filled === block.length) {
        block = new Uint8Array(Math.min(64 * 1024, maxBytes - total));
        blocks.push(block);
        filled = 0;
      }
      const count = Math.min(chunk.byteLength - offset, block.length - filled);
      block.set(chunk.subarray(offset, offset + count), filled);
      filled += count;
      total += count;
      offset += count;
    }
  };
  if (source instanceof Uint8Array) consume(source);
  else {
    const reader = source.getReader();
    let chunks = 0;
    try {
      for (;;) {
        const next = signal
          ? await waitForPublication(reader.read(), signal)
          : await reader.read();
        if (next.done) break;
        consume(next.value);
        // Even an infinite source of empty, synchronously available chunks must let its deadline fire.
        if (++chunks % 128 === 0) {
          if (signal) await waitForPublication(nextTurn(), signal);
          else await nextTurn();
        }
      }
    } catch (error) {
      void reader.cancel(error).catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
  }
  signal?.throwIfAborted();
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of blocks) {
    const count = Math.min(chunk.length, total - offset);
    bytes.set(chunk.subarray(0, count), offset);
    offset += count;
  }
  return bytes;
}

async function transformAsset(
  bytes: Uint8Array,
  kind: 'gzip' | 'gunzip',
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const codec = kind === 'gzip' ? createGzip() : createGunzip();
  // The collector accepts both platform stream types and validates their emitted chunks.
  const output = Readable.toWeb(codec);
  codec.end(bytes);
  try {
    return await collectCliBytes(output, maxBytes, signal);
  } finally {
    codec.destroy();
  }
}

export function gzipCliAsset(
  bytes: Uint8Array,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  return transformAsset(bytes, 'gzip', maxBytes, signal);
}

export async function decodeCliAsset(
  transferred: Uint8Array,
  asset: Pick<CliBuildAsset, 'compression' | 'size' | 'sha256'>,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ bytes: Uint8Array; sha256: string }> {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    !Number.isSafeInteger(asset.size) ||
    asset.size <= 0
  )
    throw new RangeError('CLI asset size and cap must be positive safe integers');
  if (asset.size > maxBytes)
    throw new RangeError(`CLI asset declared size exceeds ${maxBytes} bytes`);
  const bytes =
    asset.compression === 'gzip'
      ? await transformAsset(transferred, 'gunzip', asset.size, signal)
      : transferred;
  if (bytes.length !== asset.size)
    throw new Error(`CLI asset is ${bytes.length} bytes, manifest says ${asset.size}`);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== asset.sha256)
    throw new Error(
      'CLI asset digest does not match the manifest (checksum mismatch) — refusing to install it',
    );
  return { bytes, sha256 };
}
