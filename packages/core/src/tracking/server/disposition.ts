import type { TrackingDisposition } from '../schemas';
import { DEFAULT_BOT_USER_AGENT_PATTERN, isBotUserAgent } from './bot';
import { hashTrackingEvent } from './hash';

/** What the decision needs from a stored visit. */
export interface KnownVisit {
  id: string;
  browserStreamId: string;
  /** The visit's owner, or `null` for an anonymous visit. */
  ownerId: string | null;
}

/** The least an incoming event needs for the decision. */
export interface DispositionEvent {
  eventId: string;
  visitId: string;
  browserStreamId: string;
}

export interface DispositionInput<TEvent extends DispositionEvent> {
  events: readonly TEvent[];
  /** The visits the batch names, as the application read them. */
  visits: readonly KnownVisit[];
  /** `eventId → stored payload hash` for the batch's ids the application already holds. */
  existing: ReadonlyMap<string, string>;
  /** The caller's identity, or `null` for an anonymous caller. */
  actorOwnerId: string | null;
  userAgent?: string | null;
  botPattern?: RegExp;
}

export interface DispositionResult<TEvent extends DispositionEvent> {
  /** Events to write, in batch order. */
  accepted: TEvent[];
  /** One per incoming event, in batch order. */
  dispositions: TrackingDisposition[];
  /** Duplicates whose payload differs from the stored one — worth a warning. */
  conflicts: string[];
  /**
   * Anonymous visits the batch names while the caller is identified: the
   * application may adopt them (assign the owner, back-fill the events, record
   * the merge) in the same transaction it writes the batch with.
   */
  adoptable: string[];
}

/**
 * Decide every event of a batch without touching storage.
 *
 * - a bot's batch is `excluded-bot` in full, and nothing is written;
 * - an event naming a visit the batch's browser does not own — unknown, a
 *   different lineage, or owned by someone else — is `identity-invalid`;
 * - an `eventId` already stored is `duplicate` (a redelivery), and a
 *   `conflict` besides if the payload changed;
 * - the rest is `accepted`.
 *
 * An anonymous visit (`ownerId: null`) accepts events from anyone holding the
 * lineage: that is the visit that started before sign-in. When the caller is
 * identified it is also listed as `adoptable`.
 */
export function dispositionTrackingBatch<TEvent extends DispositionEvent>({
  events,
  visits,
  existing,
  actorOwnerId,
  userAgent,
  botPattern = DEFAULT_BOT_USER_AGENT_PATTERN,
}: DispositionInput<TEvent>): DispositionResult<TEvent> {
  if (isBotUserAgent(userAgent, botPattern)) {
    return {
      accepted: [],
      dispositions: events.map((event) => ({
        eventId: event.eventId,
        status: 'excluded-bot',
      })),
      conflicts: [],
      adoptable: [],
    };
  }
  const visitsById = new Map(visits.map((visit) => [visit.id, visit]));
  const accepted: TEvent[] = [];
  const dispositions: TrackingDisposition[] = [];
  const conflicts: string[] = [];
  const adoptable = new Set<string>();
  // An id accepted earlier in this same batch is stored from the application's
  // point of view: the second occurrence is a duplicate now, not a unique-key
  // violation later, which would fail the whole write and leave the outbox
  // retrying a batch that can never be answered.
  const acceptedHashes = new Map<string, string>();
  for (const event of events) {
    const visit = visitsById.get(event.visitId);
    if (
      !visit ||
      visit.browserStreamId !== event.browserStreamId ||
      (visit.ownerId !== null && visit.ownerId !== actorOwnerId)
    ) {
      dispositions.push({ eventId: event.eventId, status: 'identity-invalid' });
      continue;
    }
    const stored = existing.get(event.eventId) ?? acceptedHashes.get(event.eventId);
    if (stored !== undefined) {
      if (stored !== hashTrackingEvent(event)) conflicts.push(event.eventId);
      dispositions.push({ eventId: event.eventId, status: 'duplicate' });
      continue;
    }
    if (visit.ownerId === null && actorOwnerId) adoptable.add(visit.id);
    acceptedHashes.set(event.eventId, hashTrackingEvent(event));
    accepted.push(event);
    dispositions.push({ eventId: event.eventId, status: 'accepted' });
  }
  return { accepted, dispositions, conflicts, adoptable: [...adoptable] };
}
