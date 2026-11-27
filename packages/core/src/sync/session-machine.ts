/**
 * The order of one cursor sync session, as a machine with named steps; the
 * public `createSyncSession` is its facade. Every step that waits checks the
 * generation it started in afterwards, so a `stop` or a disconnect during a
 * cursor read or a page apply neither sends another page nor schedules a retry.
 */
import { type BackoffPolicy, BackoffPolicySchema, backoffDelay } from '../internal/backoff';
import { assertTimerMs } from '../internal/deadline';
import { assertNonNegativeSafeInteger } from '../internal/positive-integer';
import { SYNC_STALE_CURSOR, type SyncPageHeader } from './protocol';
import type {
  Eventually,
  SyncFailure,
  SyncSessionDiagnostics,
  SyncSessionPorts,
  SyncSnapshotResume,
} from './session';
import { catchUpFrom, checkedResume, RebaseFailed, rebaseSnapshot } from './session-snapshot';
import { chain, defaultNewId, guarded, setTimeoutSchedule } from './session-steps';

/** Where a page starts: after a version, or at the token of a snapshot paged by token. */
interface PagePosition {
  readonly after: number | null;
  readonly token: string | null;
}

/** The default pause between failed sessions: 2 s, doubling to a minute, no jitter. */
export const DEFAULT_SYNC_RETRY: BackoffPolicy = {
  minDelayMs: 2_000,
  maxDelayMs: 60_000,
  jitter: 0,
};

export class SyncSessionMachine<PAGE extends SyncPageHeader> {
  private readonly deadlineMs: number;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly schedule: (run: () => void, delayMs: number) => () => void;
  private mode: 'incremental' | 'full' | null = null;
  // Requests that arrive mid-session (or while the cursor is read) run next.
  private fullSyncPending = false;
  private incrementalPending = false;
  private starting = false;
  private stopped = false;
  private generation = 0;
  private sessionId = '';
  private requestId = '';
  private startedAt = 0;
  private cancelTimer: (() => void) | undefined;
  // Consecutive failures grow the pause to its ceiling: a deterministic apply error must not
  // spin a full snapshot of the account every two seconds.
  private failures = 0;
  private lastFailure: SyncFailure | null = null;
  // The position of the page awaited and how many pages of the session are applied: a transport
  // failure in the middle of a full sync asks for the same page again instead of starting over.
  private pageCursor: number | null = null;
  private pageToken: string | null = null;
  private pagesApplied = 0;
  // A full sync dropped mid-snapshot with pages applied: the session opens as full again and
  // asks for the page at this position instead of starting the snapshot over.
  private resume: SyncSnapshotResume | null = null;
  // The newest version when a full snapshot began. Its pages follow the cursor of
  // live rows, so a row deleted after it was paged never reappears in them: the
  // snapshot saves this version, and the next incremental session — from here —
  // brings what changed while it ran, deletes included.
  private snapshotFrom: number | null = null;
  /** The id of the running full snapshot, kept with its saved position across a restart. */
  private snapshot: string | null = null;

  constructor(private readonly ports: SyncSessionPorts<PAGE>) {
    assertTimerMs('deadlineMs', ports.deadlineMs);
    this.deadlineMs = ports.deadlineMs ?? 30_000;
    this.now = ports.now ?? Date.now;
    this.newId = ports.newId ?? defaultNewId();
    if (ports.retry) BackoffPolicySchema.parse(ports.retry);
    this.schedule = ports.schedule ?? setTimeoutSchedule;
  }

  private alive(stamp: number): boolean {
    return !this.stopped && stamp === this.generation;
  }

  private clearTimer(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
  }

  private after(delayMs: number, run: () => void): void {
    this.clearTimer();
    const stamp = this.generation;
    this.cancelTimer = this.schedule(() => {
      this.cancelTimer = undefined;
      if (this.alive(stamp)) run();
    }, delayMs);
  }

  private snapshotId(): string {
    if (this.snapshot === null) throw new Error('Sync snapshot id outside a full snapshot');
    return this.snapshot;
  }

  private position(): PagePosition {
    return { after: this.pageCursor, token: this.pageToken };
  }

  /** Where the running snapshot stands, as `saveProgress` saves it and `readCursor` returns it. */
  private snapshotResume(): SyncSnapshotResume | null {
    const { snapshot, snapshotFrom: from } = this;
    if (snapshot === null) return null;
    if (this.pageToken !== null) return { snapshot, token: this.pageToken, from };
    if (this.pageCursor !== null) return { snapshot, after: this.pageCursor, from };
    return null;
  }

  /**
   * Drop the session. An interrupted full sync with no page applied comes back full from zero;
   * with pages applied (and a port that saves its progress) it continues from the next page.
   * A partial snapshot cleans nothing.
   */
  reset(): void {
    this.clearTimer();
    this.generation += 1;
    this.starting = false;
    if (this.mode === 'full') {
      const resume =
        this.ports.saveProgress !== undefined && this.pagesApplied > 0
          ? this.snapshotResume()
          : null;
      if (resume !== null) this.resume = resume;
      else {
        this.fullSyncPending = true;
        // A stopped session is the end of the account's sync: its ports belong to a closed account.
        if (!this.stopped) this.callBegin();
      }
    }
    this.mode = null;
    this.requestId = '';
  }

  private callBegin(): void {
    try {
      const done = this.ports.beginFullSync();
      if (done instanceof Promise)
        done.catch((error) => this.ports.log.error('beginFullSync failed', error));
    } catch (error) {
      this.ports.log.error('beginFullSync failed', error);
    }
  }

  private recover(reason: string, error?: unknown): void {
    this.failures += 1;
    const delay = backoffDelay(this.ports.retry ?? DEFAULT_SYNC_RETRY, this.failures);
    const message = error instanceof Error ? error.message : error ? String(error) : null;
    this.lastFailure = {
      reason,
      message,
      at: new Date(this.now()).toISOString(),
      consecutive: this.failures,
    };
    const entry = JSON.stringify({
      event: 'sync.retry',
      sessionId: this.sessionId,
      requestId: this.requestId,
      reason,
      message,
      failures: this.failures,
      delayMs: delay,
      ageMs: this.now() - this.startedAt,
    });
    if (error) this.ports.log.error(entry, error);
    else this.ports.log.warn(entry);
    const transport = reason === 'deadline' || reason === 'send_failed';
    if (transport && this.mode === 'full' && this.pagesApplied > 0) {
      this.requestId = '';
      const position = this.position();
      this.after(delay, () => this.sendPage(position));
      return;
    }
    this.reset();
    this.after(delay, () => void this.onReconnect());
  }

  private sendPage(position: PagePosition): void {
    if (this.stopped) return;
    this.clearTimer();
    this.pageCursor = position.after;
    this.pageToken = position.token;
    const { after: cursor, token } = position;
    this.requestId = this.newId();
    const expected = this.requestId;
    this.after(this.deadlineMs, () => {
      if (this.requestId === expected) this.recover('deadline');
    });
    const { sessionId, requestId, mode } = this;
    this.ports.log.debug?.(
      JSON.stringify({ event: 'sync.request', sessionId, requestId, cursor, token, mode }),
    );
    try {
      this.ports.send({ sessionId, requestId, after: cursor, token, full: mode === 'full' });
    } catch (error) {
      this.recover('send_failed', error);
    }
  }

  private openSession(next: 'incremental' | 'full'): void {
    this.mode = next;
    this.sessionId = this.newId();
    this.startedAt = this.now();
    this.pageCursor = null;
    this.pageToken = null;
    this.pagesApplied = 0;
    this.snapshotFrom = null;
    this.snapshot = next === 'full' ? this.newId() : null;
  }

  requestSync(): Eventually<void> {
    if (this.stopped || !this.ports.isConnected()) return;
    if (this.mode || this.starting) {
      this.incrementalPending = true;
      return;
    }
    this.incrementalPending = false;
    if (this.resume !== null) {
      const resume = this.resume;
      this.resume = null;
      this.continueSnapshot(resume);
      return;
    }
    this.starting = true;
    const stamp = this.generation;
    return guarded(
      () =>
        chain(this.ports.readCursor(), (cursor) => {
          if (!this.alive(stamp)) return;
          this.starting = false;
          if (cursor !== null && typeof cursor === 'object') {
            // An interrupted snapshot continues where it stands, by token or by version.
            this.continueSnapshot(checkedResume(cursor));
            return;
          }
          if (cursor !== null)
            assertNonNegativeSafeInteger('saved sync cursor', cursor, TypeError, {
              absent: 'refused',
            });
          this.openSession(cursor === null ? 'full' : 'incremental');
          return chain(cursor === null ? this.ports.beginFullSync() : undefined, () => {
            if (this.alive(stamp)) this.sendPage({ after: cursor, token: null });
          });
        }),
      (error) => {
        if (!this.alive(stamp)) return;
        this.starting = false;
        this.mode = null;
        this.recover('cursor_unavailable', error);
      },
    );
  }

  /** Open a full session at the page an interrupted snapshot stands on, under its own id. */
  private continueSnapshot(resume: SyncSnapshotResume): void {
    this.openSession('full');
    this.snapshot = resume.snapshot;
    this.snapshotFrom = catchUpFrom(resume);
    this.sendPage(
      'token' in resume
        ? { after: null, token: resume.token }
        : { after: resume.after, token: null },
    );
  }

  private startFullSync(): Eventually<void> {
    if (this.stopped || !this.ports.isConnected()) return;
    // A session runs or starts: the full snapshot waits for its end instead of overlapping it.
    if (this.mode || this.starting) {
      this.fullSyncPending = true;
      return;
    }
    this.fullSyncPending = false;
    this.resume = null;
    this.starting = true;
    const stamp = this.generation;
    return guarded(
      () =>
        chain(this.ports.beginFullSync(), () => {
          if (!this.alive(stamp)) return;
          this.starting = false;
          this.openSession('full');
          this.sendPage({ after: null, token: null });
        }),
      (error) => {
        if (!this.alive(stamp)) return;
        this.starting = false;
        this.fullSyncPending = true;
        this.recover('begin_failed', error);
      },
    );
  }

  requestFullSync(): Eventually<void> {
    this.fullSyncPending = true;
    if (!this.mode && !this.starting) return this.startFullSync();
  }

  private matches(message: { sessionId: string; requestId: string }): boolean {
    return (
      !this.stopped &&
      this.mode !== null &&
      message.sessionId === this.sessionId &&
      message.requestId === this.requestId
    );
  }

  onReconnect(): Eventually<void> {
    if (this.stopped || !this.ports.isConnected()) return;
    return this.fullSyncPending ? this.startFullSync() : this.requestSync();
  }

  /** A snapshot paged by token was applied and more follows: save where it stands, ask on. */
  private nextToken(token: string, stamp: number): Eventually<void> {
    if (this.mode !== 'full') throw new Error('Sync pagination token outside a full snapshot');
    if (token === this.pageToken) throw new Error('Sync pagination token did not advance');
    const snapshot = this.snapshotId();
    return chain(
      this.ports.saveProgress?.({ snapshot, token, from: this.snapshotFrom }),
      () => {
        if (!this.alive(stamp)) return;
        this.pagesApplied += 1;
        this.sendPage({ after: null, token });
      },
    );
  }

  /** Merge pending local changes onto a full snapshot, its refusal marked as its own. */
  private rebasePending(): Eventually<void> {
    const rebase = this.ports.rebasePending;
    return rebase ? rebaseSnapshot(rebase, this.snapshotId()) : undefined;
  }

  /** The page was applied: ask for the next one, or save the cursor and run what waited. */
  private finishPage(page: PAGE, stamp: number, expected: string): Eventually<void> {
    if (!this.alive(stamp)) return;
    if (page.hasMore) {
      if (typeof page.nextToken === 'string') return this.nextToken(page.nextToken, stamp);
      const next = page.nextCursor ?? null;
      if (next === null || (this.pageCursor !== null && next <= this.pageCursor)) {
        throw new Error('Sync pagination cursor did not advance');
      }
      // In a snapshot the saved position carries where it began, so a restart continues the
      // snapshot instead of catching up from a page that may stand past a delete.
      const progress =
        this.mode === 'full'
          ? { snapshot: this.snapshotId(), after: next, from: this.snapshotFrom }
          : next;
      return chain(this.ports.saveProgress?.(progress), () => {
        if (!this.alive(stamp)) return;
        this.pagesApplied += 1;
        this.sendPage({ after: next, token: null });
      });
    }
    const full = this.mode === 'full';
    const from = full ? this.snapshotFrom : null;
    const catchUp = from !== null && (page.latestVersion ?? from) > from;
    return chain(full ? this.rebasePending() : undefined, () =>
      this.saveLastPage(
        stamp,
        expected,
        catchUp ? from : (page.latestVersion ?? from ?? undefined),
        catchUp,
      ),
    );
  }

  /** The session's last page is in: save its cursor, then run what waited. */
  private saveLastPage(
    stamp: number,
    expected: string,
    cursor: number | undefined,
    catchUp: boolean,
  ): Eventually<void> {
    if (!this.alive(stamp)) return;
    return chain(this.ports.saveCursor(cursor), () => {
      if (!this.alive(stamp)) return;
      this.pagesApplied += 1;
      if (catchUp) this.incrementalPending = true;
      this.ports.log.info(
        JSON.stringify({
          event: 'sync.completed',
          sessionId: this.sessionId,
          requestId: expected,
          ageMs: this.now() - this.startedAt,
        }),
      );
      this.mode = null;
      this.failures = 0;
      this.lastFailure = null;
      if (this.fullSyncPending) return this.startFullSync();
      if (this.incrementalPending) return this.requestSync();
    });
  }

  handleResponse(page: PAGE): Eventually<void> {
    if (!this.matches(page)) return;
    this.clearTimer();
    const stamp = this.generation;
    const expected = this.requestId;
    this.requestId = '';
    // A promotion begins a snapshot first; its refusal is a begin failure, not an apply one.
    let beginning = page.full && this.mode !== 'full';
    return guarded(
      () => {
        const begun: Eventually<void> = beginning
          ? chain(this.ports.beginFullSync(), () => {
              beginning = false;
              if (!this.alive(stamp)) return;
              this.mode = 'full';
              this.pageCursor = null;
              this.pageToken = null;
              this.pagesApplied = 0;
              this.snapshotFrom = null;
              this.snapshot = this.newId();
            })
          : undefined;
        return chain(begun, () => {
          if (!this.alive(stamp)) return;
          if (
            this.mode === 'full' &&
            this.snapshotFrom === null &&
            page.latestVersion !== undefined
          )
            this.snapshotFrom = page.latestVersion;
          return chain(
            this.ports.apply(page, {
              current: () => this.alive(stamp),
              snapshot: this.mode === 'full' ? this.snapshotId() : null,
            }),
            () => this.finishPage(page, stamp, expected),
          );
        });
      },
      (error) => {
        if (!this.alive(stamp)) return;
        if (!this.requestId) this.requestId = expected;
        if (beginning) this.fullSyncPending = true;
        if (error instanceof RebaseFailed) this.recover('rebase_failed', error.cause);
        else this.recover(beginning ? 'begin_failed' : 'apply_failed', error);
      },
    );
  }

  handleError(message: {
    sessionId: string;
    requestId: string;
    code: string;
  }): Eventually<void> {
    if (!this.matches(message)) return;
    if (message.code !== SYNC_STALE_CURSOR) return this.recover(message.code);
    if (this.mode === 'incremental') {
      // The feed no longer holds what follows the cursor: a full snapshot replaces it now.
      // Not a failure to wait out — the same request can only be refused again.
      this.ports.log.warn(
        JSON.stringify({
          event: 'sync.reload',
          sessionId: this.sessionId,
          reason: message.code,
        }),
      );
      this.reset();
      this.fullSyncPending = true;
      return this.startFullSync();
    }
    // Inside a snapshot the token or cursor it stands on is gone: it starts over, after a pause.
    this.pagesApplied = 0;
    this.recover(message.code);
  }

  diagnostics(): SyncSessionDiagnostics {
    return {
      sessionId: this.sessionId,
      requestId: this.requestId,
      mode: this.mode,
      ageMs: this.mode ? this.now() - this.startedAt : 0,
      lastFailure: this.lastFailure,
    };
  }

  stop(): void {
    this.stopped = true;
    this.reset();
  }
}
