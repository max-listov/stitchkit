/**
 * The shapes two consuming applications arrived at independently, word for
 * word — an event envelope, a batch, its dispositions, a visit's entry context
 * and lease. They carry no domain: the event *types* and any extra per-event
 * fields are the application's, handed in as parameters. → ADR 0166.
 */
import { z } from 'zod';

/** Campaign tags. Every field optional — `utm_source` alone is a legal entry. */
export const UtmDataSchema = z.object({
  source: z.string().max(200).optional(),
  medium: z.string().max(200).optional(),
  campaign: z.string().max(200).optional(),
  content: z.string().max(200).optional(),
  term: z.string().max(200).optional(),
});
export type UtmData = z.infer<typeof UtmDataSchema>;

export const AttributionDataSchema = z.object({
  utm: UtmDataSchema.optional(),
  referrer: z.string().optional(),
  landingPage: z.string().optional(),
});
export type AttributionData = z.infer<typeof AttributionDataSchema>;

/**
 * The build that produced an event: a git SHA, or `dev`. Shared by both
 * consumers already; `createTrackingSchemas({ buildIdPattern })` overrides it.
 */
export const DEFAULT_BUILD_ID_PATTERN = /^(dev|[a-f0-9]{7,40})$/;

/**
 * What the server decided about one event. Every value is terminal — the
 * outbox drops the event on any of them — because a retry would produce the
 * same answer: `duplicate` is the answer a re-sent accepted event gets, an
 * `identity-invalid` event belongs to a visit this browser does not own, and a
 * bot's events are never written.
 */
export const TrackingDispositionStatusSchema = z.enum([
  'accepted',
  'duplicate',
  'identity-invalid',
  'excluded-bot',
]);
export type TrackingDispositionStatus = z.infer<typeof TrackingDispositionStatusSchema>;

export const TrackingDispositionSchema = z.object({
  eventId: z.uuid(),
  status: TrackingDispositionStatusSchema,
});
export type TrackingDisposition = z.infer<typeof TrackingDispositionSchema>;

export const TrackEventsResponseSchema = z.object({
  accepted: z.number().int().nonnegative(),
  dispositions: z.array(TrackingDispositionSchema),
});
export type TrackEventsResponse = z.infer<typeof TrackEventsResponseSchema>;

export const VisitBootstrapResponseSchema = z.object({
  visitId: z.uuid(),
  expiresAt: z.iso.datetime(),
});
export type VisitBootstrapResponse = z.infer<typeof VisitBootstrapResponseSchema>;

/** The state of the browser-side outbox, reported with every visit bootstrap. */
export const TrackingOutboxStateSchema = z.enum(['available', 'unavailable']);
export type TrackingOutboxState = z.infer<typeof TrackingOutboxStateSchema>;

function trackingEventShape<TType extends string>(eventTypes: readonly [TType, ...TType[]]) {
  return {
    /** Client-minted, the idempotency key of the event. */
    eventId: z.uuid(),
    visitId: z.uuid(),
    /** Browser lineage — shared by every tab, survives reload and login. */
    browserStreamId: z.uuid(),
    /** Monotonic per lineage; reserved before the event is written anywhere. */
    browserSequence: z.number().int().nonnegative(),
    type: z.enum(eventTypes),
    page: z.string().max(2_000),
    metadata: z.record(z.string(), z.unknown()).optional(),
    clientTimestamp: z.number(),
  };
}

export type TrackingEventShape<TType extends string> = ReturnType<
  typeof trackingEventShape<TType>
>;

/**
 * The envelope every browser event travels in, before the application's extras.
 *
 * Written out rather than inferred: `z.infer` over a generic enum emits the
 * `type` field into the declaration as a mapped type the compiler cannot prove
 * is a `string`, and every generic constrained on this envelope then fails in
 * `dist/*.d.ts` while passing in `src` — the defect class of ADR 0161, caught
 * by `check-declarations-strict`. The schema stays the source of truth:
 * `tests/tracking-browser.test.ts` holds this type equal to its inference.
 */
export interface TrackingEventEnvelope<TType extends string = string> {
  eventId: string;
  visitId: string;
  browserStreamId: string;
  browserSequence: number;
  type: TType;
  page: string;
  metadata?: Record<string, unknown> | undefined;
  clientTimestamp: number;
}

/** A batch as the client sends it. */
export interface TrackEventsRequest<
  TEvent extends TrackingEventEnvelope = TrackingEventEnvelope,
> {
  buildId: string;
  events: TEvent[];
  utm?: UtmData;
}

function visitEntryContextShape(buildIdPattern: RegExp) {
  return {
    browserStreamId: z.uuid(),
    previousVisitId: z.uuid().optional(),
    origin: z.url().max(500),
    landingPath: z
      .string()
      .startsWith('/')
      .max(300)
      .regex(/^[^?#]*$/),
    referrer: z.url().max(2_000).optional(),
    utm: UtmDataSchema.optional(),
    displayMode: z.enum(['browser', 'standalone']),
    screenWidth: z.number().int().positive().max(20_000),
    screenHeight: z.number().int().positive().max(20_000),
    buildId: z.string().regex(buildIdPattern),
    outboxState: TrackingOutboxStateSchema,
    outboxQueued: z.number().int().nonnegative().max(1_000),
    outboxDropped: z.number().int().nonnegative(),
  };
}

export type VisitEntryContextShape = ReturnType<typeof visitEntryContextShape>;
export type VisitEntryContext = z.infer<z.ZodObject<VisitEntryContextShape>>;

export interface TrackingSchemasConfig<
  TType extends string,
  TExtras extends z.ZodRawShape | undefined,
> {
  /** The event types the browser may write. Server-side types are not on this list. */
  eventTypes: readonly [TType, ...TType[]];
  /** Extra per-event fields the application carries beside the envelope. */
  eventExtras?: TExtras extends z.ZodRawShape ? z.ZodObject<TExtras> : undefined;
  /** Default {@link DEFAULT_BUILD_ID_PATTERN}. */
  buildIdPattern?: RegExp;
  /** Events per batch; default 50 — the outbox reads batches of this size. */
  maxEventsPerBatch?: number;
}

/** Every schema of one tracking surface, built from the application's event types. */
export interface TrackingSchemas<TEvent extends z.ZodObject> {
  event: TEvent;
  request: z.ZodObject<{
    buildId: z.ZodString;
    events: z.ZodArray<TEvent>;
    utm: z.ZodOptional<typeof UtmDataSchema>;
  }>;
  response: typeof TrackEventsResponseSchema;
  disposition: typeof TrackingDispositionSchema;
  entry: z.ZodObject<VisitEntryContextShape>;
  bootstrap: typeof VisitBootstrapResponseSchema;
}

/**
 * The schemas of one tracking surface. Two overloads rather than a conditional
 * spread: a shape that TypeScript keeps internal while checking `src` is
 * written into the declaration as a union zod's shape constraint rejects
 * (0.78.0, 0.79.0 — ADR 0161), so the two cases are two signatures.
 */
export function createTrackingSchemas<TType extends string>(
  config: TrackingSchemasConfig<TType, undefined>,
): TrackingSchemas<z.ZodObject<TrackingEventShape<TType>>>;
export function createTrackingSchemas<TType extends string, TExtras extends z.ZodRawShape>(
  config: TrackingSchemasConfig<TType, TExtras>,
): TrackingSchemas<z.ZodObject<TrackingEventShape<TType> & TExtras>>;
export function createTrackingSchemas(
  config: TrackingSchemasConfig<string, z.ZodRawShape | undefined>,
): TrackingSchemas<z.ZodObject> {
  const base = z.object(trackingEventShape(config.eventTypes));
  const event = config.eventExtras ? base.extend(config.eventExtras.shape) : base;
  const buildIdPattern = config.buildIdPattern ?? DEFAULT_BUILD_ID_PATTERN;
  const maxEvents = config.maxEventsPerBatch ?? 50;
  return {
    event,
    request: z.object({
      /** The build that produced the events: tells an old tab from a new one. */
      buildId: z.string().regex(buildIdPattern),
      events: z.array(event).min(1).max(maxEvents),
      /** The browser's current-touch UTM at the moment of sending. */
      utm: UtmDataSchema.optional(),
    }),
    response: TrackEventsResponseSchema,
    disposition: TrackingDispositionSchema,
    entry: z.object(visitEntryContextShape(buildIdPattern)),
    bootstrap: VisitBootstrapResponseSchema,
  };
}
