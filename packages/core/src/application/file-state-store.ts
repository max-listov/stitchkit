import { mkdir, open, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { z } from 'zod';
import { writeAtomicFileData } from '../internal/atomic-file';
import { publishAtomicFile } from '../internal/atomic-publication';
import { readBoundedFile } from '../internal/bounded-file-read';
import { assertPositiveSafeInteger } from '../internal/positive-integer';
import { withExclusiveLock } from '../internal/with-exclusive-lock';
import type { StateStore, StateStoreUpdateContext } from './state-store';

export interface FileStateStoreCorruption {
  readonly path: string;
  readonly error: unknown;
}

export interface FileStateStoreOptions<TState> {
  readonly schema: z.ZodType<TState>;
  /** `throw` is the safe default. `empty` is appropriate for reconstructable ledgers. */
  readonly corrupt?: 'throw' | 'empty';
  readonly onCorrupt?: (failure: FileStateStoreCorruption) => void | Promise<void>;
  /** Maximum wait to acquire the lock; never revokes a live transition. Default 10 s. */
  readonly lockTimeoutMs?: number;
  /**
   * Largest state file a read accepts, in bytes; a larger file is refused before
   * it is parsed and is not treated as corruption. Every update reads, validates
   * and rewrites the whole file, so state that grows toward this size makes each
   * update proportionally slower. Default 64 MiB.
   */
  readonly maxBytes?: number;
}

/** The write and the lock a store runs on; the seam where tests count work. */
export interface FileStateStoreIO {
  readonly write: typeof writeAtomicFileData;
  readonly lock: typeof withExclusiveLock;
}

const NATIVE_IO: FileStateStoreIO = { write: writeAtomicFileData, lock: withExclusiveLock };
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

const encode = (state: unknown): string => `${JSON.stringify(state)}\n`;

const missing = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

/**
 * One durable atomic state transition under the canonical process-instance lock.
 * A transition whose resulting state encodes to the bytes it started from
 * changes nothing and writes nothing.
 */
export function createFileStateStore<TState>(
  path: string,
  options: FileStateStoreOptions<TState>,
): StateStore<TState> {
  return createFileStateStoreOn(path, options, NATIVE_IO);
}

/** {@link createFileStateStore} over an explicit write and lock. */
export function createFileStateStoreOn<TState>(
  path: string,
  options: FileStateStoreOptions<TState>,
  io: FileStateStoreIO,
): StateStore<TState> {
  if ('staleLockMs' in options || 'retryMs' in options)
    throw new TypeError('File state store lock age/retry options are unsupported');
  const lockTimeoutMs = options.lockTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 0)
    throw new TypeError('lockTimeoutMs must be a nonnegative safe integer');
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  assertPositiveSafeInteger('maxBytes', maxBytes);

  const parseFile = async (): Promise<TState | null> => {
    let source: string;
    try {
      source = new TextDecoder().decode((await readBoundedFile(path, maxBytes)).bytes);
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
    try {
      return options.schema.parse(JSON.parse(source));
    } catch (error) {
      await options.onCorrupt?.({ path, error });
      if (options.corrupt === 'empty') return null;
      throw error;
    }
  };

  return {
    read: parseFile,
    async update(transition) {
      await mkdir(dirname(path), { recursive: true });
      return io.lock(
        `${path}.lock`,
        async (lock) => {
          let active = true;
          const context: StateStoreUpdateContext = {
            async assertHeld() {
              if (!active) throw new Error('State store transaction is no longer active');
              await lock.assertHeld();
            },
          };
          try {
            // The lock was taken a moment ago. Fencing is checked once before the
            // transition runs on what was read, and once at the commit point below.
            const current = await parseFile();
            // Taken before the transition, which may change `current` in place.
            const before = current === null ? null : encode(current);
            await context.assertHeld();
            const next = await transition(current, context);
            const state = options.schema.parse(next.state);
            const text = encode(state);
            if (text === before) return next.result;
            await io.write(
              path,
              text,
              { durability: 'directory' },
              {
                open,
                unlink,
                async publish(staged, target, publication) {
                  await context.assertHeld();
                  await publishAtomicFile(staged, target, publication);
                },
              },
            );
            return next.result;
          } finally {
            active = false;
          }
        },
        { label: `state store ${path}`, timeoutMs: lockTimeoutMs },
      );
    },
  };
}
