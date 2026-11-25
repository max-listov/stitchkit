/**
 * `stitchkit/sync` — the client half of an offline-first sync: which local
 * changes leave next, pending edits on top of remote rows, deletes that win
 * until acknowledged, the cursor session, and the wire a server answers in.
 * No driver and no domain: it runs in a browser, in Hermes and in Bun.
 */
export {
  acknowledgeableOutboxIds,
  coveredOutboxIds,
  decideOutboxBatch,
  type OutboxBatchDecision,
  type OutboxPage,
  type OutboxPolicy,
  type OutboxQuarantine,
  type OutboxQuarantineReason,
  type OutboxRow,
  type OutboxSetAside,
  replaceableOutboxRow,
} from '../sync/outbox';
export {
  applyOverlay,
  deriveOverlay,
  type Overlay,
  type OverlayInput,
  type OverlaySpec,
  type PendingUpdate,
} from '../sync/overlay';
export {
  type ClassifiedChangeResult,
  classifyChangeResults,
  mergeStreamCursors,
  SYNC_CHANGE_OUTCOMES,
  SYNC_STALE_CURSOR,
  type SyncChangeAction,
  type SyncChangeOutcome,
  type SyncChangeResult,
  SyncChangeResultSchema,
  type SyncPageHeader,
  SyncPageHeaderSchema,
  type SyncPageRequest,
  SyncPageRequestSchema,
  type SyncPushLimits,
  SyncPushResultSchema,
  type SyncResultReading,
  type SyncStreamPage,
  syncPushRequestSchema,
} from '../sync/protocol';
export {
  createSyncSession,
  DEFAULT_SYNC_RETRY,
  type Eventually,
  type SyncFailure,
  type SyncSession,
  type SyncSessionDiagnostics,
  type SyncSessionLog,
  type SyncSessionPorts,
  type SyncSnapshotResume,
} from '../sync/session';
export {
  decideRemoteRow,
  dependentRowVisible,
  type FullSyncSets,
  orphansOf,
  type RemoteRowDecision,
  staleAfterFullSync,
  type TombstoneSource,
} from '../sync/tombstones';
