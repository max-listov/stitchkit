import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { z } from 'zod';
import { writeAtomicFileData } from '../internal/atomic-file';
import { publishAtomicFile } from '../internal/atomic-publication';
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
}

const missing = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

/** One durable atomic state transition under the canonical process-instance lock. */
export function createFileStateStore<TState>(
  path: string,
  options: FileStateStoreOptions<TState>,
): StateStore<TState> {
  if ('staleLockMs' in options || 'retryMs' in options)
    throw new TypeError('File state store lock age/retry options are unsupported');
  const lockTimeoutMs = options.lockTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 0)
    throw new TypeError('lockTimeoutMs must be a nonnegative safe integer');

  const parseFile = async (): Promise<TState | null> => {
    let source: string;
    try {
      source = await readFile(path, 'utf8');
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
      return withExclusiveLock(
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
            await context.assertHeld();
            const current = await parseFile();
            await context.assertHeld();
            const next = await transition(current, context);
            await context.assertHeld();
            const state = options.schema.parse(next.state);
            await writeAtomicFileData(
              path,
              `${JSON.stringify(state)}\n`,
              { durability: 'directory' },
              {
                open,
                unlink,
                async publish(staged, target, replace, directorySync) {
                  await context.assertHeld();
                  await publishAtomicFile(staged, target, replace, directorySync);
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
