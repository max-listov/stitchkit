import type { VisitBootstrapResponse, VisitEntryContext } from '../schemas';
import { DEFAULT_BOT_USER_AGENT_PATTERN, isBotUserAgent } from './bot';

/** Who is asking for the lease. */
export interface VisitActor {
  /** The caller's identity, or `null` for an anonymous caller. */
  ownerId: string | null;
  userAgent?: string | null;
}

/** An active visit as the store reports it. */
export interface ActiveVisit {
  id: string;
  ownerId: string | null;
  startedAt: Date;
}

/**
 * The outbox health a bootstrap reports, written onto the visit so the
 * server can see a browser whose queue is unavailable or overflowing.
 */
export interface VisitOutboxHealth {
  outboxState: VisitEntryContext['outboxState'];
  outboxQueued: number;
  outboxDropped: number;
  outboxReportedAt: Date;
}

/**
 * Which visits the caller may continue. `adopting`: an anonymous visit or the
 * caller's own — the visit that started before sign-in is continued and
 * adopted. `owned`: only the caller's own — every visitor already has an
 * identity, an anonymous visit is never continued.
 */
export type VisitOwnership = 'adopting' | 'owned';

export interface FindActiveVisitQuery {
  browserStreamId: string;
  /** A visit whose `lastActivityAt` is before this is not active. */
  cutoff: Date;
  actorOwnerId: string | null;
  ownership: VisitOwnership;
  /** The visit the browser believes it is in; preferred when still active. */
  previousVisitId?: string;
}

/**
 * The store the application implements over its database. Everything runs
 * inside `withLineageLock`, which serialises bootstraps of one browser
 * lineage — two tabs starting at once must not each open a visit.
 */
export interface TrackingVisitStore<TTx = unknown> {
  withLineageLock<T>(browserStreamId: string, fn: (tx: TTx) => Promise<T>): Promise<T>;
  findActive(tx: TTx, query: FindActiveVisitQuery): Promise<ActiveVisit | null>;
  /** Extend the lease; `health` is the browser's outbox report. */
  touch(tx: TTx, visitId: string, now: Date, health: VisitOutboxHealth): Promise<void>;
  /**
   * Give an anonymous visit to the caller. Required under `ownership:
   * 'adopting'` — `issueVisitLease` refuses to run without it rather than
   * continue an anonymous visit and leave it anonymous; an `owned` store
   * never adopts and may omit it.
   */
  adopt?(tx: TTx, visit: ActiveVisit, actorOwnerId: string, now: Date): Promise<void>;
  /** Close every open visit of the lineage before a new one starts. */
  endOpen(tx: TTx, browserStreamId: string, now: Date): Promise<void>;
  /** Write a new visit; the application derives device, geo and source itself. */
  create(
    tx: TTx,
    visit: { id: string; actor: VisitActor; entry: VisitEntryContext; startedAt: Date },
    health: VisitOutboxHealth,
  ): Promise<void>;
}

export interface IssueVisitLeaseOptions {
  ownership: VisitOwnership;
  /** Idle time that ends a visit. Default 30 minutes. */
  idleMs?: number;
  now?: () => Date;
  randomUUID?: () => string;
  botPattern?: RegExp;
}

export interface IssuedVisitLease extends VisitBootstrapResponse {
  /** `continued` when an active visit was extended, `started` when a new one opened. */
  outcome: 'continued' | 'started' | 'bot';
  /** The anonymous visit that was adopted by the caller, when one was. */
  adopted: ActiveVisit | null;
}

/**
 * Issue or renew a visit lease.
 *
 * A bot gets a lease that exists in no store: its later events are then
 * `identity-invalid`, and neither the visit nor the events reach a report.
 * Otherwise, under the lineage lock: the visit the browser names if it is
 * still active and continuable, else the most recent active one; found —
 * touch it (and adopt it when anonymous and the caller is identified); not
 * found — end whatever is open and start a new one.
 */
export async function issueVisitLease<TTx>(
  store: TrackingVisitStore<TTx>,
  actor: VisitActor,
  entry: VisitEntryContext,
  {
    ownership,
    idleMs = 30 * 60 * 1000,
    now = () => new Date(),
    randomUUID = () => crypto.randomUUID(),
    botPattern = DEFAULT_BOT_USER_AGENT_PATTERN,
  }: IssueVisitLeaseOptions,
): Promise<IssuedVisitLease> {
  if (ownership === 'adopting' && !store.adopt) {
    throw new Error("issueVisitLease: ownership 'adopting' requires store.adopt");
  }
  const at = now();
  const expiresAt = new Date(at.getTime() + idleMs).toISOString();
  if (isBotUserAgent(actor.userAgent, botPattern)) {
    return { visitId: randomUUID(), expiresAt, outcome: 'bot', adopted: null };
  }
  const health: VisitOutboxHealth = {
    outboxState: entry.outboxState,
    outboxQueued: entry.outboxQueued,
    outboxDropped: entry.outboxDropped,
    outboxReportedAt: at,
  };
  return store.withLineageLock(entry.browserStreamId, async (tx) => {
    const query: FindActiveVisitQuery = {
      browserStreamId: entry.browserStreamId,
      cutoff: new Date(at.getTime() - idleMs),
      actorOwnerId: actor.ownerId,
      ownership,
    };
    // The store answers the query; the module still checks the answer. A
    // store that overlooked `ownership` must not hand another person's visit
    // to this caller — the rule is enforced here, not trusted to be applied.
    const continuable = (visit: ActiveVisit | null): ActiveVisit | null =>
      visit &&
      (visit.ownerId === actor.ownerId || (visit.ownerId === null && ownership === 'adopting'))
        ? visit
        : null;
    const requested = entry.previousVisitId
      ? continuable(
          await store.findActive(tx, { ...query, previousVisitId: entry.previousVisitId }),
        )
      : null;
    const active = requested ?? continuable(await store.findActive(tx, query));
    if (active) {
      let adopted: ActiveVisit | null = null;
      if (
        ownership === 'adopting' &&
        active.ownerId === null &&
        actor.ownerId &&
        store.adopt
      ) {
        await store.adopt(tx, active, actor.ownerId, at);
        adopted = active;
      }
      await store.touch(tx, active.id, at, health);
      return { visitId: active.id, expiresAt, outcome: 'continued', adopted };
    }
    await store.endOpen(tx, entry.browserStreamId, at);
    const visitId = randomUUID();
    await store.create(tx, { id: visitId, actor, entry, startedAt: at }, health);
    return { visitId, expiresAt, outcome: 'started', adopted: null };
  });
}
