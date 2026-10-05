/**
 * The server half of a chunked upload (`uploadInChunks` is the client half):
 * parts land on disk under the upload's owner, each with a receipt, and come
 * back in order once every part is in.
 *
 * - An upload is keyed by `owner` (whoever the application says sends it —
 *   a user, a user and a device) and the client-minted `uploadId`; the same id
 *   from another owner is another upload.
 * - `open` is idempotent: the same declaration again is `'reopened'`, a
 *   different one is `UPLOAD_CONFLICT`.
 * - A part's receipt is its size and sha256. The same bytes again are
 *   `'repeated'`; other bytes at the same index are `UPLOAD_CONFLICT`. The
 *   first writer wins across processes: a part's data file is named by its hash
 *   and its receipt is published by an exclusive link, so a loser can neither
 *   replace the receipt nor the bytes it names.
 * - Every part but the last is exactly `chunkBytes` long.
 * - `sweep` removes an upload nothing has touched for `staleAfterMs`.
 *
 * Refusals are `AppError`s with a 4xx status, so a handler that does not catch
 * them answers the client with a typed envelope the driver does not repeat.
 */

import { createHash } from 'node:crypto';
import {
  type FileHandle,
  link,
  mkdir,
  open,
  readdir,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import type { ZodType } from 'zod';
import { z } from 'zod';
import { AppError } from '../contract/errors';
import { stagingPath } from '../internal/atomic-staging';

export type ChunkSpoolErrorCode =
  | 'UPLOAD_INVALID'
  | 'UPLOAD_TOO_LARGE'
  | 'UPLOAD_NOT_FOUND'
  | 'UPLOAD_CONFLICT'
  | 'UPLOAD_CHUNK_OUT_OF_RANGE'
  | 'UPLOAD_CHUNK_SIZE'
  | 'UPLOAD_INCOMPLETE';

const STATUS: { readonly [Code in ChunkSpoolErrorCode]: number } = {
  UPLOAD_INVALID: 400,
  UPLOAD_TOO_LARGE: 413,
  UPLOAD_NOT_FOUND: 404,
  UPLOAD_CONFLICT: 409,
  UPLOAD_CHUNK_OUT_OF_RANGE: 400,
  UPLOAD_CHUNK_SIZE: 400,
  UPLOAD_INCOMPLETE: 409,
};

/**
 * Whether an error code is one the spool refuses with. An application that
 * maps error codes onto its own must map these too — an unmapped one would
 * reach its client as an unknown 500 instead of the spool's 4xx.
 */
export function isChunkSpoolErrorCode(code: string): code is ChunkSpoolErrorCode {
  return Object.hasOwn(STATUS, code);
}

/** Every code the spool refuses with. */
export const CHUNK_SPOOL_ERROR_CODES: readonly ChunkSpoolErrorCode[] = Object.freeze(
  Object.keys(STATUS).filter(isChunkSpoolErrorCode),
);

function refuse(
  code: ChunkSpoolErrorCode,
  message: string,
  details?: Record<string, unknown>,
): AppError {
  return new AppError(code, { message, status: STATUS[code], details });
}

export interface ChunkSpoolConfig<TMeta> {
  /** Where uploads in progress live; one directory per upload. */
  readonly directory: string;
  /** Bytes per part, the same number the client driver uses. */
  readonly chunkBytes: number;
  readonly maxFileBytes: number;
  /** What `open` stores beside the upload — file name, type, the app's fields. */
  readonly meta: ZodType<TMeta>;
  /** Default 24 hours. */
  readonly staleAfterMs?: number;
}

export interface ChunkSpoolKey {
  readonly owner: string;
  readonly uploadId: string;
}

export interface ChunkSpoolOpen<TMeta> extends ChunkSpoolKey {
  readonly totalBytes: number;
  readonly chunkCount: number;
  readonly meta: TMeta;
}

export interface ChunkSpoolPart extends ChunkSpoolKey {
  readonly index: number;
  readonly bytes: Blob;
}

export interface ChunkSpoolAssembly<TMeta> {
  readonly meta: TMeta;
  readonly totalBytes: number;
  /** The parts on disk, in order; valid until `discard`. */
  readonly chunkPaths: string[];
  /** The whole file, part after part. */
  stream(): ReadableStream<Uint8Array>;
}

export interface ChunkSpool<TMeta> {
  open(upload: ChunkSpoolOpen<TMeta>): Promise<'opened' | 'reopened'>;
  put(part: ChunkSpoolPart): Promise<'stored' | 'repeated'>;
  /** Every part, checked against its receipt; `UPLOAD_INCOMPLETE` names the first missing. */
  assemble(key: ChunkSpoolKey): Promise<ChunkSpoolAssembly<TMeta>>;
  discard(key: ChunkSpoolKey): Promise<void>;
  /** Remove uploads untouched for `staleAfterMs`; resolves with how many. */
  sweep(): Promise<number>;
}

const UPLOAD_ID = /^[A-Za-z0-9_-]{1,128}$/;
const Receipt = z.object({
  size: z.number().int().nonnegative(),
  sha256: z.string().length(64),
});
const Declaration = z.object({
  totalBytes: z.number().int().positive(),
  chunkCount: z.number().int().positive(),
  meta: z.unknown(),
});
const READ_BYTES = 64 * 1024;

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

/** Publish `bytes` at `path` unless something is already there; `false` if it was. */
async function publishOnce(path: string, bytes: Uint8Array | string): Promise<boolean> {
  const staging = stagingPath(path);
  await writeFile(staging, bytes, { flag: 'wx' });
  try {
    await link(staging, path);
    return true;
  } catch (error) {
    if (isErrorCode(error, 'EEXIST')) return false;
    throw error;
  } finally {
    await unlink(staging);
  }
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

function concatenated(paths: readonly string[]): ReadableStream<Uint8Array> {
  let index = 0;
  let handle: FileHandle | undefined;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const path = paths[index];
        if (path === undefined) {
          controller.close();
          return;
        }
        handle ??= await open(path, 'r');
        const buffer = new Uint8Array(READ_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, READ_BYTES, null);
        if (bytesRead > 0) {
          controller.enqueue(buffer.subarray(0, bytesRead));
          return;
        }
        await handle.close();
        handle = undefined;
        index += 1;
      }
    },
    async cancel() {
      await handle?.close();
    },
  });
}

export function createChunkSpool<TMeta>(config: ChunkSpoolConfig<TMeta>): ChunkSpool<TMeta> {
  const { directory, chunkBytes, maxFileBytes } = config;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) {
    throw new TypeError('createChunkSpool: chunkBytes must be a positive integer');
  }
  const staleAfterMs = config.staleAfterMs ?? 24 * 60 * 60 * 1000;

  const uploadDir = ({ owner, uploadId }: ChunkSpoolKey): string => {
    if (!UPLOAD_ID.test(uploadId)) {
      throw refuse('UPLOAD_INVALID', 'An upload id is 1–128 of [A-Za-z0-9_-]');
    }
    const key = createHash('sha256').update(owner).update('\0').update(uploadId).digest('hex');
    return join(directory, key);
  };

  const declaration = async (dir: string) => {
    try {
      const stored = Declaration.parse(await readJson(join(dir, 'upload.json')));
      return { ...stored, meta: config.meta.parse(stored.meta) };
    } catch (error) {
      if (isErrorCode(error, 'ENOENT')) {
        throw refuse('UPLOAD_NOT_FOUND', 'No such upload: open it first, or it was swept');
      }
      throw error;
    }
  };

  const partSize = (index: number, totalBytes: number, chunkCount: number): number =>
    index === chunkCount - 1 ? totalBytes - chunkBytes * index : chunkBytes;

  return {
    async open(upload) {
      const dir = uploadDir(upload);
      const { totalBytes, chunkCount } = upload;
      if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
        throw refuse('UPLOAD_INVALID', 'An upload declares a positive totalBytes');
      }
      if (totalBytes > maxFileBytes) {
        throw refuse('UPLOAD_TOO_LARGE', `A file is at most ${maxFileBytes} bytes`, {
          maxFileBytes,
          totalBytes,
        });
      }
      const expected = Math.ceil(totalBytes / chunkBytes);
      if (chunkCount !== expected) {
        throw refuse(
          'UPLOAD_INVALID',
          `${totalBytes} bytes in ${chunkBytes}-byte parts are ${expected} parts`,
          {
            chunkBytes,
            chunkCount,
            expectedChunkCount: expected,
          },
        );
      }
      const stored = JSON.stringify({
        totalBytes,
        chunkCount,
        meta: config.meta.parse(upload.meta),
      });
      await mkdir(dir, { recursive: true });
      if (await publishOnce(join(dir, 'upload.json'), stored)) return 'opened';
      const existing = await readFile(join(dir, 'upload.json'), 'utf8');
      if (existing !== stored) {
        throw refuse(
          'UPLOAD_CONFLICT',
          'This upload id is already open with another declaration',
        );
      }
      return 'reopened';
    },

    async put(part) {
      const dir = uploadDir(part);
      const { totalBytes, chunkCount } = await declaration(dir);
      if (!Number.isSafeInteger(part.index) || part.index < 0 || part.index >= chunkCount) {
        throw refuse(
          'UPLOAD_CHUNK_OUT_OF_RANGE',
          `Part ${part.index} is outside 0…${chunkCount - 1}`,
          {
            index: part.index,
            chunkCount,
          },
        );
      }
      const expectedSize = partSize(part.index, totalBytes, chunkCount);
      if (part.bytes.size !== expectedSize) {
        throw refuse('UPLOAD_CHUNK_SIZE', `Part ${part.index} is ${expectedSize} bytes`, {
          index: part.index,
          expectedSize,
          actualSize: part.bytes.size,
        });
      }
      const bytes = new Uint8Array(await part.bytes.arrayBuffer());
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      // The data first, named by its hash: whichever receipt wins names bytes that exist.
      await publishOnce(join(dir, `${part.index}.${sha256}.part`), bytes);
      const receipt = JSON.stringify({ size: bytes.byteLength, sha256 });
      if (await publishOnce(join(dir, `${part.index}.receipt.json`), receipt)) return 'stored';
      const existing = Receipt.parse(await readJson(join(dir, `${part.index}.receipt.json`)));
      if (existing.sha256 === sha256) return 'repeated';
      await rm(join(dir, `${part.index}.${sha256}.part`), { force: true });
      throw refuse('UPLOAD_CONFLICT', `Part ${part.index} already holds other bytes`, {
        index: part.index,
      });
    },

    async assemble(key) {
      const dir = uploadDir(key);
      const { totalBytes, chunkCount, meta } = await declaration(dir);
      const chunkPaths: string[] = [];
      for (let index = 0; index < chunkCount; index += 1) {
        let receipt: z.infer<typeof Receipt>;
        try {
          receipt = Receipt.parse(await readJson(join(dir, `${index}.receipt.json`)));
        } catch (error) {
          if (!isErrorCode(error, 'ENOENT')) throw error;
          throw refuse('UPLOAD_INCOMPLETE', `Part ${index} has not arrived`, {
            index,
            chunkCount,
          });
        }
        const path = join(dir, `${index}.${receipt.sha256}.part`);
        const { size } = await stat(path);
        if (size !== receipt.size || size !== partSize(index, totalBytes, chunkCount)) {
          throw new Error(`chunk spool: part ${index} on disk does not match its receipt`);
        }
        chunkPaths.push(path);
      }
      return { meta, totalBytes, chunkPaths, stream: () => concatenated(chunkPaths) };
    },

    async discard(key) {
      await rm(uploadDir(key), { recursive: true, force: true });
    },

    async sweep() {
      const entries = await readdir(directory, { withFileTypes: true }).catch(
        (error: unknown) => {
          if (isErrorCode(error, 'ENOENT')) return [];
          throw error;
        },
      );
      const cutoff = Date.now() - staleAfterMs;
      let removed = 0;
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = join(directory, entry.name);
        // A part landing renames into the directory and moves its mtime.
        if ((await stat(dir)).mtimeMs >= cutoff) continue;
        await rm(dir, { recursive: true, force: true });
        removed += 1;
      }
      return removed;
    },
  };
}
