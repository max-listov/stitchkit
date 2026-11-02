/**
 * `stitchkit/tracking` — the browser mechanics of visitor tracking: a
 * tab-shared outbox with reserved sequences and a short flush lease, delivery
 * with one bounded retry, the page-leave beacon that actually arrives, visible
 * time, scroll milestones, declarative clicks, attribution, and the client
 * that composes them. No React, no DOM at import time, no event vocabulary of
 * its own, and no `zod`: this runs on every page. The wire shapes are
 * `stitchkit/tracking/contract`, the server half `stitchkit/tracking/server`.
 * → ADR 0166, ADR 0280.
 */
export {
  type AttributionStorage,
  parseReferrer,
  parseUtmFromSearch,
  type ReferrerRule,
  type ResolveAttributionInput,
  type ResolvedAttribution,
  resolveAttribution,
} from '../tracking/attribution';
export { sendUnloadBeacon } from '../tracking/beacon';
export {
  type ClickTarget,
  type ResolveTrackedClickOptions,
  resolveTrackedClick,
  type TrackedClick,
  type TrackedClickAttributes,
} from '../tracking/clicks';
export {
  type BuiltinTrackingEventTypes,
  CONVENTIONAL_TRACKING_EVENT_TYPES,
  createTrackingClient,
  type EventsWithMetadata,
  type EventsWithoutMetadata,
  type TrackFn,
  type TrackingClient,
  type TrackingClientConfig,
} from '../tracking/client';
export {
  deliverTrackingBatch,
  type TrackingDeliveryOptions,
  type TrackingDeliveryOutcome,
} from '../tracking/delivery';
export {
  browserTrackingHost,
  type TrackingHost,
  type TrackingPageContext,
} from '../tracking/host';
export { createOncePerPage, type OncePerPage } from '../tracking/once-per-page';
export {
  createTrackingOutbox,
  type TrackingOutbox,
  type TrackingOutboxEvents,
  type TrackingOutboxHealth,
  type TrackingOutboxMeta,
  type TrackingOutboxOptions,
  type TrackingOutboxRecord,
  type TrackingOutboxStorage,
  type TrackingQueuedEvent,
} from '../tracking/outbox';
export { indexedDbOutboxStorage } from '../tracking/outbox-storage-indexeddb';
export { memoryOutboxStorage } from '../tracking/outbox-storage-memory';
export { redactTrackingText, redactTrackingValue } from '../tracking/privacy';
export {
  createScrollMilestones,
  type ScrollMilestones,
  scrollDepthPercent,
} from '../tracking/scroll';
export {
  createSequenceReserve,
  type SequenceReserve,
  type SequenceReserveOptions,
} from '../tracking/sequence-reserve';
export {
  createVisibleTimeMeter,
  type VisibleHeartbeat,
  type VisibleInterval,
  type VisibleTimeMeter,
  type VisibleTimeMeterOptions,
} from '../tracking/visible-time';
