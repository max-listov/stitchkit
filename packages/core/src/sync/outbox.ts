/**
 * Which local changes leave the device next.
 *
 * An offline-first client writes every local change to an outbox and sends it
 * when it can. The policy is the same on every host, so it lives here once;
 * reading pages of rows, committing what was decided and sending it stay with
 * the host. The rules:
 *
 * - FIFO, page by page: a decision carries over through `previous`, so a key
 *   blocked on one page stays blocked on the next.
 * - A row depends on keys (by default its entity): it is ripe when no earlier
 *   unresolved row shares one of them. A row that waits holds all its keys, so
 *   nothing behind it overtakes it; rows that share no key go side by side.
 * - A row sent and unanswered goes again with the same change id after
 *   `retryAfterMs`; a row whose `sentAt` is missing or unreadable goes now
 *   rather than wait forever. The `sent` marks of a decision are committed
 *   before the batch leaves: from then on the row is never replaced
 *   (`replaceableOutboxRow`), since its id stands for one content.
 * - A row that cannot be sent — unparsable JSON, not a change, larger than a
 *   whole batch, a status this policy does not know — is quarantined.
 * - A `quarantined` or `held` row (set aside for a person: `classifyChangeResults`
 *   → `hold`) is skipped. By default it holds its keys until the person retries
 *   or discards it, because the rows after it were made on top of it;
 *   `setAside: 'releases-keys'` lets the rows after it go.
 * - A `confirmed` row was acknowledged with a version and stays on top of
 *   remote rows until the cursor covers it (`coveredOutboxIds`); it is never
 *   sent again and holds nothing.
 * - A batch is measured in exact UTF-8 bytes of the message, envelope and
 *   separators included, and in changes.
 */

import { utf8ByteLength } from '../internal/bounded-body';
import { assertTimerMs } from '../internal/deadline';
import { assertPositiveSafeInteger } from '../internal/positive-integer';

/** One outbox row as storage holds it; `payloadJson` is parsed here, before a driver can throw on it. */
export interface OutboxRow {
  readonly id: string;
  readonly entity: string;
  readonly entityId: string;
  readonly payloadJson: string;
  readonly status: string;
  readonly sentAt: string | null;
  readonly attempts: number;
}

/** Reason an outbox row cannot be sent and is moved to quarantine. */
export type OutboxQuarantineReason = 'invalid_json' | 'invalid_change' | 'payload_too_large';

/** Record identifying an outbox row to quarantine and why. */
export interface OutboxQuarantine {
  readonly id: string;
  readonly reason: OutboxQuarantineReason;
}

/**
 * What a quarantined or held row does to the rows after it: `holds-keys` keeps
 * every later row that shares one of its keys waiting for a person;
 * `releases-keys` lets them go, for rows that stand on their own.
 */
export type OutboxSetAside = 'holds-keys' | 'releases-keys';

/** Batching, retry, and wire-size rules governing outbox dispatch decisions. */
export interface OutboxPolicy<ROW extends OutboxRow, CHANGE> {
  /** Build the change that goes on the wire, or `undefined` when the row is not one. */
  toChange(row: ROW, payload: unknown): CHANGE | undefined;
  /** UTF-8 bytes of the push message with no changes in it. */
  emptyEnvelopeBytes: number;
  /** The largest message, envelope included. */
  maxBytes: number;
  maxChanges: number;
  /** How long a sent, unanswered row waits before it goes again; a timer delay. */
  retryAfterMs: number;
  /**
   * The keys a row depends on; it waits while an earlier unresolved row shares
   * one. Default: one key, the entity and its id. No keys — it depends on nothing.
   */
  keysOf?(row: ROW): readonly string[];
  /** What a quarantined or held row does to the rows after it. Default `holds-keys`. */
  setAside?: OutboxSetAside;
}

/** Pure batch selection result listing changes to send, rows to quarantine, and wake timing. */
export interface OutboxBatchDecision<CHANGE> {
  /** The changes to send, in order. */
  send: CHANGE[];
  /** The rows to mark sent, with their new attempt count. */
  sent: { id: string; sentAt: string; attempts: number }[];
  quarantine: OutboxQuarantine[];
  /** The keys rows of this decision hold; a later row sharing one waits. */
  blockedKeys: ReadonlySet<string>;
  /** Bytes of the message these changes make. */
  bytes: number;
  /** The batch is full: read and send again at once. */
  full: boolean;
  /** When to look again, in milliseconds; `null` when nothing waits. */
  nextWakeMs: number | null;
}

function defaultKeys(row: OutboxRow): readonly string[] {
  return [JSON.stringify([row.entity, row.entityId])];
}

const SET_ASIDE: readonly OutboxSetAside[] = ['holds-keys', 'releases-keys'];

/** Clock, policy, and carry-over decision passed to `decideOutboxBatch` for one page of rows. */
export interface OutboxPage<ROW extends OutboxRow, CHANGE> {
  /** The clock, in ms since the epoch. */
  readonly now: number;
  readonly policy: OutboxPolicy<ROW, CHANGE>;
  /** The decision of the pages before this one. */
  readonly previous?: OutboxBatchDecision<CHANGE>;
}

/** The numbers of a policy, refused before a row is decided: a `NaN` limit bounds nothing. */
function checkedPolicy(
  policy: Pick<
    OutboxPolicy<OutboxRow, unknown>,
    'emptyEnvelopeBytes' | 'maxBytes' | 'maxChanges' | 'retryAfterMs'
  >,
): void {
  for (const name of ['emptyEnvelopeBytes', 'maxBytes', 'maxChanges'] as const)
    assertPositiveSafeInteger(`[stitchkit] sync: ${name}`, policy[name], RangeError, {
      absent: 'refused',
    });
  assertTimerMs('retryAfterMs', policy.retryAfterMs, { absent: 'refused' });
}

/** Decide one page of rows, carrying `previous` over from the pages before it. */
export function decideOutboxBatch<ROW extends OutboxRow, CHANGE>(
  rows: readonly ROW[],
  page: OutboxPage<ROW, CHANGE>,
): OutboxBatchDecision<CHANGE> {
  const { now, policy, previous } = page;
  checkedPolicy(policy);
  const keysOf = policy.keysOf ?? defaultKeys;
  const setAside = policy.setAside ?? 'holds-keys';
  if (!SET_ASIDE.includes(setAside))
    throw new RangeError(
      `[stitchkit] sync: setAside is ${SET_ASIDE.map((name) => `'${name}'`).join(' or ')}`,
    );
  const blocked = new Set(previous?.blockedKeys);
  const decision: OutboxBatchDecision<CHANGE> = {
    send: [...(previous?.send ?? [])],
    sent: [...(previous?.sent ?? [])],
    quarantine: [...(previous?.quarantine ?? [])],
    blockedKeys: blocked,
    bytes: previous?.bytes ?? policy.emptyEnvelopeBytes,
    full: previous?.full ?? false,
    nextWakeMs: previous?.nextWakeMs ?? null,
  };
  const wakeIn = (delay: number) => {
    decision.nextWakeMs = Math.min(decision.nextWakeMs ?? delay, delay);
  };
  const hold = (keys: readonly string[]) => {
    for (const key of keys) blocked.add(key);
  };
  const setAsideRow = (keys: readonly string[]) => {
    if (setAside === 'holds-keys') hold(keys);
  };
  const quarantine = (id: string, reason: OutboxQuarantineReason, keys: readonly string[]) => {
    decision.quarantine.push({ id, reason });
    setAsideRow(keys);
  };
  for (const row of rows) {
    if (decision.full) break;
    if (row.status === 'confirmed') continue;
    const keys = keysOf(row);
    if (row.status === 'quarantined' || row.status === 'held') {
      setAsideRow(keys);
      continue;
    }
    if (keys.some((key) => blocked.has(key))) {
      hold(keys);
      continue;
    }
    const sentAt = row.sentAt === null ? Number.NaN : Date.parse(row.sentAt);
    if (row.status === 'sent' && Number.isFinite(sentAt)) {
      const delay = sentAt + policy.retryAfterMs - now;
      if (delay > 0) {
        hold(keys);
        wakeIn(delay);
        continue;
      }
    }
    let payload: unknown;
    try {
      payload = JSON.parse(row.payloadJson);
    } catch {
      quarantine(row.id, 'invalid_json', keys);
      continue;
    }
    const change =
      row.status === 'pending' || row.status === 'sent'
        ? policy.toChange(row, payload)
        : undefined;
    if (change === undefined) {
      quarantine(row.id, 'invalid_change', keys);
      continue;
    }
    const size = utf8ByteLength(JSON.stringify(change));
    if (policy.emptyEnvelopeBytes + size > policy.maxBytes) {
      quarantine(row.id, 'payload_too_large', keys);
      continue;
    }
    const increment = size + (decision.send.length === 0 ? 0 : 1);
    if (
      decision.bytes + increment > policy.maxBytes ||
      decision.send.length >= policy.maxChanges
    ) {
      decision.full = true;
      decision.nextWakeMs = 0;
      break;
    }
    decision.bytes += increment;
    decision.send.push(change);
    decision.sent.push({
      id: row.id,
      sentAt: new Date(now).toISOString(),
      attempts: row.attempts + 1,
    });
    hold(keys);
    wakeIn(policy.retryAfterMs);
  }
  return decision;
}

/**
 * A late acknowledgement after a reconnect is valid; one for an unattempted,
 * set-aside or already confirmed row is not.
 */
export function acknowledgeableOutboxIds(
  rows: readonly { id: string; status: string; attempts: number }[],
): string[] {
  return rows
    .filter(
      (row) =>
        row.status !== 'quarantined' &&
        row.status !== 'held' &&
        row.status !== 'confirmed' &&
        row.attempts > 0,
    )
    .map((row) => row.id);
}

/**
 * Whether a row may still be replaced — another edit folded into it, its
 * payload rewritten. Only while it never left: the `sent` mark a decision
 * returns, committed before the send, survives a restart, and from then on the
 * row's change id stands for the content the server may already hold.
 */
export function replaceableOutboxRow(
  row: Pick<OutboxRow, 'status' | 'sentAt' | 'attempts'>,
): boolean {
  return row.status === 'pending' && row.sentAt === null && row.attempts === 0;
}

/**
 * Confirmed rows the cursor now covers: they leave the outbox, and the overlay
 * with them. A confirmed row stays on top of remote rows until the client has
 * read the version its change got, so the screen never shows the older remote
 * value between the answer and the feed; one confirmed without a version leaves
 * at once.
 */
export function coveredOutboxIds(
  rows: readonly { id: string; status: string; confirmedVersion: number | null }[],
  cursor: number | null,
): string[] {
  return rows
    .filter(
      (row) =>
        row.status === 'confirmed' &&
        (row.confirmedVersion === null || (cursor !== null && row.confirmedVersion <= cursor)),
    )
    .map((row) => row.id);
}
