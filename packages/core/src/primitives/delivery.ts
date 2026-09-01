import { z } from 'zod';
import { type DomainEvent, DomainEventSchema } from './event';

export const DomainEventDestinationSchema = z.object({
  id: z.string().min(1),
  transport: z.string().min(1),
  address: z.string().min(1),
});
export type DomainEventDestination = z.infer<typeof DomainEventDestinationSchema>;

export const DomainEventDeliveryOutcomeSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('delivered'), receipt: z.string().min(1).optional() }),
  z.object({
    outcome: z.literal('retryable'),
    code: z.string().min(1),
    retryAt: z.iso.datetime({ offset: true }),
  }),
  z.object({ outcome: z.literal('terminal'), code: z.string().min(1) }),
  z.object({ outcome: z.literal('unknown'), code: z.string().min(1) }),
]);
export type DomainEventDeliveryOutcome = z.infer<typeof DomainEventDeliveryOutcomeSchema>;

export const DomainEventDeliveryClaimSchema = z.object({
  event: DomainEventSchema,
  destination: DomainEventDestinationSchema,
  attempt: z.number().int().positive(),
});
export type DomainEventDeliveryClaim = z.infer<typeof DomainEventDeliveryClaimSchema>;

export interface DomainEventOutbox {
  /** Atomically claim one already committed destination, or return undefined. */
  claim(eventId: string): Promise<DomainEventDeliveryClaim | undefined>;
  /** Mark a successful claim complete. */
  delivered(
    claim: DomainEventDeliveryClaim,
    outcome: Extract<DomainEventDeliveryOutcome, { outcome: 'delivered' }>,
  ): Promise<void>;
  /** Schedule the next claim at the declared instant. */
  retry(
    claim: DomainEventDeliveryClaim,
    outcome: Extract<DomainEventDeliveryOutcome, { outcome: 'retryable' }>,
  ): Promise<void>;
  /** Retire a destination after a definitive refusal. */
  terminal(
    claim: DomainEventDeliveryClaim,
    outcome: Extract<DomainEventDeliveryOutcome, { outcome: 'terminal' }>,
  ): Promise<void>;
  /** Hold an unclassified failure for inspection; it must not become an automatic retry. */
  unknown(
    claim: DomainEventDeliveryClaim,
    outcome: Extract<DomainEventDeliveryOutcome, { outcome: 'unknown' }>,
  ): Promise<void>;
}

export interface DomainEventRoute {
  readonly type: string;
  readonly destinations: (event: DomainEvent) => readonly DomainEventDestination[];
}

export interface DomainEventTransport {
  readonly send: (
    event: DomainEvent,
    destination: DomainEventDestination,
  ) => Promise<DomainEventDeliveryOutcome>;
}

export interface DomainEventDeliveryPlan {
  readonly event: DomainEvent;
  readonly destinations: readonly DomainEventDestination[];
}

export interface DomainEventDispatchResult {
  readonly eventId: string;
  readonly attempts: number;
  readonly exhausted: boolean;
}

/**
 * Compose routing with an application-owned committed outbox. The dispatcher cannot accept a raw
 * event: callers persist `plan(event)` transactionally, then dispatch only by stable event id.
 */
export function defineDomainEventDelivery(config: {
  readonly routes: readonly DomainEventRoute[];
  readonly transports: Readonly<Record<string, DomainEventTransport>>;
  readonly outbox: DomainEventOutbox;
  readonly maxClaimsPerDispatch?: number;
}) {
  const maxClaims = config.maxClaimsPerDispatch ?? 100;
  if (!Number.isSafeInteger(maxClaims) || maxClaims <= 0) {
    throw new RangeError('maxClaimsPerDispatch must be a positive safe integer');
  }
  return Object.freeze({
    plan(eventInput: DomainEvent): DomainEventDeliveryPlan {
      const event = DomainEventSchema.parse(eventInput);
      const destinations = config.routes
        .filter((route) => route.type === event.type)
        .flatMap((route) => route.destinations(event))
        .map((destination) => DomainEventDestinationSchema.parse(destination));
      const ids = new Set<string>();
      for (const destination of destinations) {
        if (ids.has(destination.id)) {
          throw new Error(`[stitchkit] duplicate destination id "${destination.id}"`);
        }
        ids.add(destination.id);
      }
      return Object.freeze({ event, destinations: Object.freeze(destinations) });
    },
    async dispatch(eventId: string): Promise<DomainEventDispatchResult> {
      let attempts = 0;
      while (attempts < maxClaims) {
        const claim = await config.outbox.claim(eventId);
        if (!claim) return { eventId, attempts, exhausted: false };
        const parsedClaim = DomainEventDeliveryClaimSchema.parse(claim);
        if (parsedClaim.event.id !== eventId) {
          throw new Error('[stitchkit] outbox claim event id does not match dispatch request');
        }
        const transport = config.transports[parsedClaim.destination.transport];
        let outcome: DomainEventDeliveryOutcome;
        if (!transport) {
          outcome = { outcome: 'unknown', code: 'TRANSPORT_NOT_DECLARED' };
        } else {
          try {
            outcome = DomainEventDeliveryOutcomeSchema.parse(
              await transport.send(parsedClaim.event, parsedClaim.destination),
            );
          } catch {
            outcome = { outcome: 'unknown', code: 'TRANSPORT_FAILED' };
          }
        }
        switch (outcome.outcome) {
          case 'delivered':
            await config.outbox.delivered(parsedClaim, outcome);
            break;
          case 'retryable':
            await config.outbox.retry(parsedClaim, outcome);
            break;
          case 'terminal':
            await config.outbox.terminal(parsedClaim, outcome);
            break;
          case 'unknown':
            await config.outbox.unknown(parsedClaim, outcome);
            break;
        }
        attempts += 1;
      }
      return { eventId, attempts, exhausted: true };
    },
  });
}
