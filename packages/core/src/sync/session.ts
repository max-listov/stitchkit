/**
 * The cursor sync session of an offline-first client — one per account, the
 * same on a desktop host and a phone.
 *
 * What a page contains, and how it is applied to local storage, stays with the
 * app; this owns the order of the session: one session at a time (incremental
 * or full), paging by `nextCursor`, catching up versions announced mid-session,
 * a deferred full sync, a growing pause between retries, and asking for the
 * same page again after the transport dropped it, a snapshot paged by token, a
 * full snapshot at once when the server no longer keeps the cursor, and the
 * moment pending local changes are rebased. Every port may be synchronous
 * (`bun:sqlite`) or asynchronous (`expo-sqlite`): after each wait the session
 * checks its generation, so a `stop` or `onDisconnect` in the middle of a cursor
 * read or a page apply neither sends another page nor schedules a retry.
 *
 * The request and the page header are neutral; the app maps them to its wire.
 */
import type { BackoffPolicy } from '../internal/backoff';
import type { SyncPageHeader, SyncPageRequest } from './protocol';
import { SyncSessionMachine } from './session-machine';

/** A result that is here (a synchronous driver) or will be (an asynchronous one). */
export type Eventually<T> = T | Promise<T>;

/** Logger interface used by a client sync session to record progress and failures. */
export interface SyncSessionLog {
  debug?(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

export { DEFAULT_SYNC_RETRY } from './session-machine';

/**
 * Where an interrupted full snapshot stands: the position of its next page — the
 * `token` of a snapshot paged by token, the cursor `after` of one paged by
 * version — `from`, the version it began at, which its catch-up starts from, and
 * `snapshot`, its id, which `apply` and `rebasePending` name and which a snapshot
 * continued after a restart keeps.
 */
export type SyncSnapshotResume =
  | { readonly snapshot: string; readonly token: string; readonly from: number | null }
  | { readonly snapshot: string; readonly after: number; readonly from: number | null };

/** Host storage, transport, and scheduling ports supplied to `createSyncSession`. */
export interface SyncSessionPorts<PAGE extends SyncPageHeader> {
  /** The transport is connected; without it no session starts. */
  isConnected(): boolean;
  /**
   * What `saveCursor` or `saveProgress` saved last. Return null for an uninitialized store.
   * A nonnegative integer, including zero, requests changes after that version.
   * A `SyncSnapshotResume` continues the interrupted full snapshot where it stands.
   */
  readCursor(): Eventually<number | SyncSnapshotResume | null>;
  /**
   * A full sync begins: the local projection is kept, the cursor reset, accumulators
   * cleared. The outbox stays: pending changes are rebased once the snapshot is in.
   */
  beginFullSync(): Eventually<void>;
  send(request: SyncPageRequest): void;
  /**
   * Apply a page to the projection; a refusal is a throw, and the session retries.
   * `current()` is false once the session was dropped; `snapshot` is the id of the full
   * snapshot the page belongs to (`null` in an incremental session). Mark each row a
   * snapshot page writes with it, in the same write: the rows marked with an id are the
   * ones that snapshot named, across a restart too, which is what `staleAfterFullSync`
   * needs — a set held in memory loses the pages of the process before.
   */
  apply(
    page: PAGE,
    context: { readonly current: () => boolean; readonly snapshot: string | null },
  ): Eventually<void>;
  /** The last page was applied: save the cursor (no version — the cursor does not move). */
  saveCursor(version: number | undefined): Eventually<void>;
  /**
   * A page was applied and more follow: save where the session stands, so `readCursor`
   * returns it after a restart — the next cursor of an incremental session, a
   * `SyncSnapshotResume` in a full snapshot. Optional; with it an interrupted session
   * continues from there, without it a full snapshot starts over.
   */
  saveProgress?(progress: number | SyncSnapshotResume): Eventually<void>;
  /**
   * A full snapshot — asked for, forced by the server or after `stale_cursor` — is
   * applied: merge pending local changes onto what it brought before they are sent.
   * Runs before the snapshot's cursor is saved, with the snapshot's id: the place to
   * clean the rows it did not name (`staleAfterFullSync`). A refusal is
   * `rebase_failed`, and the session retries.
   */
  rebasePending?(snapshot: string): Eventually<void>;
  log: SyncSessionLog;
  /** A timer; returns its cancellation. Default `setTimeout`. */
  schedule?(run: () => void, delayMs: number): () => void;
  now?(): number;
  newId?(): string;
  /** How long a page may take to arrive; a timer delay, refused at creation otherwise. Default 30 000 ms. */
  deadlineMs?: number;
  /** The pause between failed sessions. Default `DEFAULT_SYNC_RETRY`. */
  retry?: BackoffPolicy;
}

/** The last sync failure — for readiness: a poisoned page is seen, not only logged. */
export interface SyncFailure {
  reason: string;
  message: string | null;
  at: string;
  consecutive: number;
}

/** Point-in-time diagnostic snapshot of an active or idle sync session. */
export interface SyncSessionDiagnostics {
  sessionId: string;
  requestId: string;
  mode: 'incremental' | 'full' | null;
  ageMs: number;
  lastFailure: SyncFailure | null;
}

/** Client cursor sync session controller returned by `createSyncSession`. */
export interface SyncSession<PAGE extends SyncPageHeader> {
  /**
   * Catch up: a new session, or remember the request while one runs. With
   * synchronous ports the whole step finishes before the call returns.
   */
  requestSync(): Eventually<void>;
  /** A full snapshot: now, or after the current session. */
  requestFullSync(): Eventually<void>;
  handleResponse(page: PAGE): Eventually<void>;
  /** A refusal of a page request; `stale_cursor` loads a full snapshot at once. */
  handleError(message: {
    sessionId: string;
    requestId: string;
    code: string;
  }): Eventually<void>;
  /** The connection came up, or back. */
  onReconnect(): Eventually<void>;
  /** The connection went down: an unfinished session is dropped; the machine stays alive. */
  onDisconnect(): void;
  diagnostics(): SyncSessionDiagnostics;
  /** For good: later events are ignored. */
  stop(): void;
}

/** Create an account-scoped client cursor sync session over host storage and transport ports. */
export function createSyncSession<PAGE extends SyncPageHeader>(
  ports: SyncSessionPorts<PAGE>,
): SyncSession<PAGE> {
  const machine = new SyncSessionMachine(ports);
  return {
    requestSync: () => machine.requestSync(),
    requestFullSync: () => machine.requestFullSync(),
    handleResponse: (page) => machine.handleResponse(page),
    handleError: (message) => machine.handleError(message),
    onReconnect: () => machine.onReconnect(),
    onDisconnect: () => machine.reset(),
    diagnostics: () => machine.diagnostics(),
    stop: () => machine.stop(),
  };
}
