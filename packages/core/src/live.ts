/**
 * `stitchkit/live` — declarations for the things that change while a caller is
 * watching: announcements and watched reads.
 *
 * Browser-safe and evolving. Browser-safe because both halves are declarations
 * plus a client, and a client that cannot run in a browser is not a client.
 * Evolving because the shape here is being found with its first consumers — the
 * entrypoint says so rather than leaving a reader to discover it in a minor.
 *
 * What lives here is deliberately small: this entrypoint owns no transport. The
 * wire is the Socket.IO realtime contract from `stitchkit`, the in-process
 * delivery is `createEventBus` from `stitchkit/server`, and the server halves of
 * a watched read live in `stitchkit/application`. → ADR 0150.
 */
export {
  defineEvents,
  type EventDecision,
  type EventDeliveryMode,
  type EventPayloads,
  type EventsConfig,
  type EventsDeclaration,
  type EventTopicDeclaration,
  type EventTopicRegistry,
  type EventTopicsOfMode,
  type EventUndecided,
  toRealtimeContract,
  type WireTopic,
} from './live/events';
export {
  createWatchClient,
  type TypedWatchClient,
  type WatchClientConfig,
  type WatchHandle,
  type WatchListeners,
  type WatchTransport,
} from './live/watch-client';
export {
  WATCH_CLOSE,
  WATCH_OPEN,
  WATCH_STATE,
  WATCH_VALUE,
  type WatchKey,
  WatchKeySchema,
  type WatchStateFrame,
  WatchStateSchema,
  type WatchValueFrame,
  WatchValueSchema,
  watchContract,
  watchKeyString,
} from './live/watch-contract';
