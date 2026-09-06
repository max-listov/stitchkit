/**
 * `stitchkit/tracking/server` — the decisions a tracking backend makes,
 * without the storage it makes them over. The application reads visits and
 * stored hashes from its own database, hands them here, and writes what comes
 * back; `issueVisitLease` runs the visit algorithm over a store interface the
 * application implements. No database, no schema, no domain. → ADR 0166.
 */

// The schema types this entrypoint's own signatures are written in.
//
// They are shared with the browser side and live on `stitchkit/tracking`, which
// satisfies the "a consumer can reach it" rule and still costs a round trip:
// the first import a store implementation reaches for is the entrypoint whose
// functions it is implementing, and `issueVisitLease` names all three. Nothing
// is renamed and nothing is redefined here — the same symbols, reachable from
// the entrypoint that requires them.
export type {
  TrackingDisposition,
  VisitBootstrapResponse,
  VisitEntryContext,
} from './tracking/schemas';
export {
  type ActiveIntervalOptions,
  type ActiveTimeInterval,
  activeIntervalOf,
} from './tracking/server/active-interval';
export { DEFAULT_BOT_USER_AGENT_PATTERN, isBotUserAgent } from './tracking/server/bot';
export {
  type DispositionEvent,
  type DispositionInput,
  type DispositionResult,
  dispositionTrackingBatch,
  type KnownVisit,
} from './tracking/server/disposition';
export { hashTrackingEvent } from './tracking/server/hash';
export {
  createPresenceRegistry,
  type PresenceEntry,
  type PresenceRegistry,
} from './tracking/server/presence';
export {
  type ActiveVisit,
  type FindActiveVisitQuery,
  type IssuedVisitLease,
  type IssueVisitLeaseOptions,
  issueVisitLease,
  type TrackingVisitStore,
  type VisitActor,
  type VisitOutboxHealth,
  type VisitOwnership,
} from './tracking/server/visit-lease';
