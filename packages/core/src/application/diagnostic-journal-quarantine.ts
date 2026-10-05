import { rename } from 'node:fs/promises';
import { isRecord } from '../internal/typed';
import type { DiagnosticJournalStartupRefusalPolicy } from './diagnostic-journal-contract';
import {
  DIAGNOSTIC_JOURNAL_LISTED_QUARANTINE_LIMIT,
  DiagnosticJournalRecoveryError,
  type DiagnosticJournalRecoveryErrorOptions,
  type DiagnosticJournalRecoveryStatus,
} from './diagnostic-journal-read-contract';

/** One quarantined file beside the journal, as the recovery status reports it. */
export type DiagnosticJournalQuarantinedFile = NonNullable<
  DiagnosticJournalRecoveryStatus['quarantined']
>[number];

/** A file opening could not keep in place; `quarantineFailed` is set by the handler itself. */
export type DiagnosticJournalStartupRefusal = Omit<
  DiagnosticJournalRecoveryErrorOptions,
  'quarantineFailed'
>;

/**
 * Applies the declared startup-refusal policy to one file: `fail` throws the typed refusal,
 * `quarantine` renames the file to `<file>.quarantined-<epoch>` in the same directory and
 * returns what to report. The rename moves a symlink itself, never its target, and the epoch is
 * unique per open, so it never replaces another file. When the rename fails, the refusal stands
 * and carries both errors.
 */
export function createStartupRefusalHandler(
  policy: DiagnosticJournalStartupRefusalPolicy,
  epoch: string,
): (refusal: DiagnosticJournalStartupRefusal) => Promise<DiagnosticJournalQuarantinedFile> {
  return async (refusal) => {
    if (policy === 'fail') throw new DiagnosticJournalRecoveryError(refusal);
    const quarantinedAs = `${refusal.file}.quarantined-${epoch}`;
    try {
      await rename(refusal.file, quarantinedAs);
    } catch (error) {
      throw new DiagnosticJournalRecoveryError({
        ...refusal,
        quarantineFailed: true,
        cause: new AggregateError(
          refusal.cause === undefined ? [error] : [refusal.cause, error],
          'Diagnostic journal could not move a refused file aside',
        ),
      });
    }
    const code =
      refusal.reason === 'unreadable' &&
      isRecord(refusal.cause) &&
      typeof refusal.cause.code === 'string'
        ? refusal.cause.code
        : undefined;
    return {
      file: refusal.file,
      quarantinedAs,
      reason: refusal.reason,
      ...(code !== undefined && { code }),
    };
  };
}

/**
 * The journal file a directory entry was quarantined from, as a name in the same directory, or
 * `undefined` when `name` is not `<journal>.quarantined-*` or `<journal>.<n>.quarantined-*`.
 * `prefix` is the journal's base name followed by a dot.
 */
export function quarantinedOrigin(name: string, prefix: string): string | undefined {
  if (!name.startsWith(prefix)) return undefined;
  const match = /^(?:(\d+)\.)?quarantined-[\s\S]+$/.exec(name.slice(prefix.length));
  if (!match) return undefined;
  const index = match[1];
  return index === undefined ? prefix.slice(0, -1) : `${prefix}${index}`;
}

type ListedQuarantine = Pick<
  DiagnosticJournalRecoveryStatus,
  'quarantined' | 'quarantinedUnlisted'
>;

/**
 * What the recovery status lists: the files this open moved, then the ones earlier opens left,
 * at most {@link DIAGNOSTIC_JOURNAL_LISTED_QUARANTINE_LIMIT}; the rest are counted.
 */
export function listQuarantinedFiles(
  movedNow: readonly DiagnosticJournalQuarantinedFile[],
  movedEarlier: readonly DiagnosticJournalQuarantinedFile[],
): ListedQuarantine {
  const total = movedNow.length + movedEarlier.length;
  if (total === 0) return {};
  const limit = DIAGNOSTIC_JOURNAL_LISTED_QUARANTINE_LIMIT;
  const quarantined = [
    ...movedNow.slice(0, limit),
    ...movedEarlier.slice(0, Math.max(0, limit - movedNow.length)),
  ];
  const unlisted = total - quarantined.length;
  return { quarantined, ...(unlisted > 0 && { quarantinedUnlisted: unlisted }) };
}
