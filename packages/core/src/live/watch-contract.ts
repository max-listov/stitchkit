/**
 * The wire protocol of a watched read — one contract, shared by both ends.
 *
 * A watched read is a GET that the server re-runs when something it depends on
 * changes, pushing the new answer to everyone watching. The protocol is four
 * events on the realtime contract the application already runs, and it is
 * declared once here so the hub and the client cannot drift: a second copy of
 * these shapes on the client is exactly the hand-written frame parsing that
 * `defineContract` exists to end.
 *
 * The state vocabulary is `LiveStatePhase` and `LiveStateStopReason` — the ones
 * the live-state controller already publishes — and not a second, poorer pair.
 * A reader with one component on a controller's phase and another on a watch's
 * state must be able to compare them, and `live | unavailable` beside
 * `idle | opening | live | resync-required | unavailable | closed` cannot be
 * compared at all. It also supplies the third answer a two-word vocabulary
 * loses: `opening` — subscribed, nothing read yet — which is neither healthy nor
 * broken, and rendering it as "unavailable" tells a user something is wrong when
 * the truth is that it is early.
 */
import { z } from 'zod';
import { LiveStatePhaseSchema, LiveStateStopReasonSchema } from '../browser/live-state';
import type { RealtimeContract } from '../realtime/contract';
import { WatchDeltaSchema } from './watch-delta';

/** The identity of one watched read: an operation plus the arguments it was asked with. */
export const WatchKeySchema = z
  .object({
    /** `OperationIdentity.serviceName` — the contract's service. */
    service: z.string().min(1),
    /** `OperationIdentity.key` — the action within it. */
    action: z.string().min(1),
    /**
     * A digest of the arguments, order-independent.
     *
     * A digest rather than the arguments themselves because this string is
     * repeated in every frame of the subscription, and arguments have no bounded
     * size. Order-independent because `{a,b}` and `{b,a}` are the same question,
     * and a key that disagreed would silently split one shared read into two —
     * the exact saving a shared read exists for, lost to object literal order.
     */
    digest: z.string().min(1),
  })
  .strict()
  .readonly();
export type WatchKey = z.infer<typeof WatchKeySchema>;

/**
 * What a subscriber already holds, offered when it opens a key.
 *
 * Both halves are needed and neither is redundant. The revision says *which*
 * answer it has; the fingerprint proves it is that answer and not a different
 * one wearing the same number — revisions restart at zero when a hub restarts or
 * a key is released and re-acquired, so a bare revision would let a client keep
 * a value from a previous life of the source and be told it was current.
 */
export const WatchHaveSchema = z
  .object({ revision: z.number().int().nonnegative(), fingerprint: z.string().min(1) })
  .strict()
  .readonly();
export type WatchHave = z.infer<typeof WatchHaveSchema>;

export const WatchOpenSchema = z
  .object({ key: WatchKeySchema, args: z.unknown(), have: WatchHaveSchema.optional() })
  .readonly();

export const WatchAcceptedSchema = z
  .object({
    accepted: z.boolean(),
    /** Present only on a refusal, and said in words rather than a flag. */
    reason: z.string().optional(),
  })
  .strict()
  .readonly();

/**
 * A new answer, said in one of three ways.
 *
 * Three shapes rather than one with optional fields, because "which of these is
 * it" then has an answer the parser enforces instead of a convention the two
 * ends have to keep separately. A frame that carried both a value and a
 * difference, or neither, would be accepted by a shape with optionals and means
 * nothing; here it cannot be written.
 *
 * `fingerprint` is on all three and is the identity of the value the receiver
 * holds *after* applying the frame. It is what makes reassembly checkable: a
 * client that applies a difference and arrives somewhere else knows immediately,
 * rather than rendering a plausible wrong answer until the next full value
 * happens along. It is order-independent, so the two ends agree even though
 * rebuilding an object from a difference does not preserve key order.
 */
const watchValueParts = {
  key: WatchKeySchema,
  /**
   * Monotonic per key. A frame carrying a revision no newer than the one the
   * receiver already has is a late answer to an older question and is dropped.
   */
  revision: z.number().int().nonnegative(),
  /** `argumentsDigest({ value })` of the value this frame leaves the receiver holding. */
  fingerprint: z.string().min(1),
};

export const WatchValueSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('full'), ...watchValueParts, value: z.unknown() }).readonly(),
  z
    .object({
      kind: z.literal('delta'),
      ...watchValueParts,
      /** The revision the difference is against — what the receiver must already hold. */
      base: z.number().int().nonnegative(),
      delta: WatchDeltaSchema,
    })
    .readonly(),
  /**
   * The answer the subscriber already has is still current.
   *
   * Sent in reply to an `open` that offered a matching `have`, and it is the
   * whole point of offering one: a page that reconnects with the current answer
   * pays a frame of tens of bytes instead of the value again.
   */
  z.object({ kind: z.literal('unchanged'), ...watchValueParts }).readonly(),
]);

export const WatchStateSchema = z
  .object({
    key: WatchKeySchema,
    phase: LiveStatePhaseSchema,
    reason: LiveStateStopReasonSchema.optional(),
    /** The read's own failure, in the words it used. Absent while healthy. */
    code: z.string().optional(),
    message: z.string().optional(),
  })
  .readonly();

export type WatchValueFrame = z.infer<typeof WatchValueSchema>;
export type WatchStateFrame = z.infer<typeof WatchStateSchema>;

export const WATCH_OPEN = 'stitchkit.watch.open';
export const WATCH_CLOSE = 'stitchkit.watch.close';
export const WATCH_VALUE = 'stitchkit.watch.value';
export const WATCH_STATE = 'stitchkit.watch.state';

/**
 * The realtime contract a watched read travels on.
 *
 * Merge it into the application's own contract — `{ serverToClient: {...app,
 * ...watchContract.serverToClient}, … }` — or bind it on its own. Event names
 * are namespaced so a merge cannot collide with an application's topics.
 */
export const watchContract = {
  serverToClient: {
    [WATCH_VALUE]: { args: z.tuple([WatchValueSchema]) },
    [WATCH_STATE]: { args: z.tuple([WatchStateSchema]) },
  },
  clientToServer: {
    [WATCH_OPEN]: { args: z.tuple([WatchOpenSchema]), ack: WatchAcceptedSchema },
    [WATCH_CLOSE]: { args: z.tuple([z.object({ key: WatchKeySchema }).readonly()]) },
  },
} as const satisfies RealtimeContract<
  Record<string, { args: z.ZodType<unknown[]> }>,
  Record<string, { args: z.ZodType<unknown[]>; ack?: z.ZodType }>
>;

/** The wire key as one string — what a map is keyed by on both ends. */
export function watchKeyString(key: WatchKey): string {
  return `${key.service}/${key.action}/${key.digest}`;
}
