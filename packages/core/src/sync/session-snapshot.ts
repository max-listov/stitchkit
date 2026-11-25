/**
 * What a full snapshot carries apart from its pages: the position it saved, read back after a
 * restart and refused when it names no page; the version its catch-up starts from; and its
 * rebase, whose refusal is told apart from a refusal of a page's apply.
 */
import { assertNonNegativeSafeInteger } from '../internal/positive-integer';
import type { Eventually, SyncSnapshotResume } from './session';

/** A refusal of `rebasePending`, told apart from a refusal of the page's apply. */
export class RebaseFailed {
  constructor(readonly cause: unknown) {}
}

/** A saved snapshot position as `readCursor` returned it, refused when it names no page. */
export function checkedResume(saved: SyncSnapshotResume): SyncSnapshotResume {
  if (saved.from !== null)
    assertNonNegativeSafeInteger('a saved snapshot position: from', saved.from, TypeError, {
      absent: 'refused',
    });
  if (typeof saved.snapshot !== 'string' || saved.snapshot.length === 0)
    throw new TypeError('a saved snapshot position has no snapshot id');
  if ('token' in saved) {
    if (typeof saved.token !== 'string' || saved.token.length === 0)
      throw new TypeError('a saved snapshot position has no token');
    return saved;
  }
  assertNonNegativeSafeInteger('a saved snapshot position: after', saved.after, TypeError, {
    absent: 'refused',
  });
  return saved;
}

/**
 * Where the catch-up of a continued snapshot starts: where the snapshot began. Pages by
 * version may already stand past that point, on rows that changed while it ran, and a
 * deletion in between is in no full page: only a catch-up from the beginning carries it. The
 * earlier of the two is always safe, because a change delivered twice is applied once. A
 * snapshot paged by token lists only rows at or below where it began, so that version stands.
 */
export function catchUpFrom(resume: SyncSnapshotResume): number | null {
  if ('token' in resume) return resume.from;
  return resume.from === null ? resume.after : Math.min(resume.from, resume.after);
}

/** Run the app's rebase of a completed snapshot; a refusal, thrown or rejected, is `RebaseFailed`. */
export function rebaseSnapshot(
  rebase: (snapshot: string) => Eventually<void>,
  snapshot: string,
): Eventually<void> {
  try {
    const done = rebase(snapshot);
    return done instanceof Promise
      ? done.catch((error) => {
          throw new RebaseFailed(error);
        })
      : done;
  } catch (error) {
    throw new RebaseFailed(error);
  }
}
