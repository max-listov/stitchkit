/**
 * What a batch already did, written so an interrupted run does not lose it.
 *
 * The record is keyed by the line's id and carries a digest of the line's
 * CONTENT. Both halves are load-bearing. Without the id a resumed run cannot
 * tell which lines are done; without the digest a line edited under the same id
 * is silently replayed with the previous answer — the batch reports success for
 * an operation nobody ran.
 *
 * Written through the same atomic rename the binary replacement uses: a
 * checkpoint that can be half-written is a checkpoint that costs exactly what
 * it was there to prevent.
 */
import { existsSync, readFileSync } from 'node:fs';
import { writeFileAtomic } from '../../internal/atomic-file';
import { safeJsonParse } from '../../internal/safe-json';
import { argumentsDigest } from '../../internal/stable-digest';
import { isRecord } from '../../internal/typed';

/** One recorded line: what it was, and what running it produced. */
export interface CliCheckpointEntry {
  digest: string;
  answer: unknown;
}

export interface CliCheckpoint {
  entries: Record<string, CliCheckpointEntry>;
  digestOf(line: { command: string; args: Record<string, unknown> }): string;
  record(id: string, digest: string, answer: unknown): void;
}

function emptyCheckpoint(entries: Record<string, CliCheckpointEntry>): CliCheckpoint {
  return {
    entries,
    digestOf: (line) => argumentsDigest({ command: line.command, args: line.args }),
    record(id, digest, answer) {
      entries[id] = { digest, answer };
    },
  };
}

/**
 * Read a checkpoint, or start an empty one.
 *
 * A file that cannot be parsed starts an empty checkpoint rather than throwing:
 * the alternative is a batch that refuses to run because of a corrupted record
 * of a previous run, which is worse than doing the work again.
 */
export function readCliCheckpoint(path: string): CliCheckpoint {
  if (!existsSync(path)) return emptyCheckpoint({});
  try {
    const parsed: unknown = safeJsonParse(readFileSync(path, 'utf8'));
    const entries: Record<string, CliCheckpointEntry> = {};
    if (isRecord(parsed) && isRecord(parsed.entries)) {
      for (const [id, value] of Object.entries(parsed.entries)) {
        if (isRecord(value) && typeof value.digest === 'string') {
          entries[id] = { digest: value.digest, answer: value.answer };
        }
      }
    }
    return emptyCheckpoint(entries);
  } catch {
    return emptyCheckpoint({});
  }
}

/** Persist the checkpoint atomically. */
export function writeCliCheckpoint(path: string, checkpoint: CliCheckpoint): void {
  writeFileAtomic(
    path,
    Buffer.from(`${JSON.stringify({ entries: checkpoint.entries }, null, 2)}\n`, 'utf8'),
    0o600,
  );
}
