/**
 * `stitchkit/release` — a page follows the release it was built for.
 *
 * The server keeps a marker of the current frontend build and names it on
 * every HTTP response and every socket connection; the browser compares that
 * to its own build id and reloads under a declared policy. Reading the build
 * id, sending the deploy signal and the moment to reload are the
 * application's; the comparison, the channels and the policy are here, once.
 * → ADR 0167.
 */
export { RELEASE_HEADER } from './release/header';
export {
  createReleaseMarker,
  type ReleaseMarker,
  type ReleaseMarkerConfig,
  type ReleaseRefresh,
} from './release/marker';
export {
  bindReleaseToSocketServer,
  observeReleaseFromSocket,
  type ReleaseSocketEmitter,
  type ReleaseSocketListener,
  type ReleaseSocketOptions,
  type ReleaseSocketServer,
} from './release/socket';
export {
  browserReleaseHost,
  createReleaseWatcher,
  type ReleaseReloadPolicy,
  type ReleaseWatcher,
  type ReleaseWatcherConfig,
  type ReleaseWatcherHost,
} from './release/watcher';
