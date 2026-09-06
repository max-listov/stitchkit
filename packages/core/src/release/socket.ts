import type { ReleaseMarker } from './marker';
import type { ReleaseWatcher } from './watcher';

/** The little of a Socket.IO server this binding uses — structural, no peer import. */
export interface ReleaseSocketServer {
  on(event: 'connection', handler: (socket: ReleaseSocketEmitter) => void): unknown;
  emit(event: string, payload: { buildId: string | null }): unknown;
}

export interface ReleaseSocketEmitter {
  emit(event: string, payload: { buildId: string | null }): unknown;
}

/**
 * The little of a Socket.IO client this feed uses. Two dialects: a raw
 * socket.io client subscribes with `on` and unsubscribes with `off`; the
 * stitchkit client's `on` returns the unsubscribe itself. Both fit.
 */
export interface ReleaseSocketListener {
  on(event: string, handler: (payload: { buildId: string | null }) => void): unknown;
  off?(event: string, handler: (payload: { buildId: string | null }) => void): unknown;
}

export interface ReleaseSocketOptions {
  /** Event name on the wire. Default `release`. */
  event?: string;
}

/**
 * Tell every socket which build is current: each connection on arrival, and
 * everyone when the marker changes. A connection first `refresh()`es the
 * marker — the safety net: a deploy signal the process missed while it was
 * down is repaired by the next client that connects, because that connect
 * re-reads the file.
 */
export function bindReleaseToSocketServer(
  io: ReleaseSocketServer,
  marker: ReleaseMarker,
  options: ReleaseSocketOptions & { refreshOnConnection?: boolean } = {},
): () => void {
  const event = options.event ?? 'release';
  const refreshOnConnection = options.refreshOnConnection ?? true;
  const unsubscribe = marker.subscribe((buildId) => {
    io.emit(event, { buildId });
  });
  io.on('connection', (socket) => {
    // `refresh` never throws (the marker reports through `onError`), so a
    // connect handler cannot be what ends a connection.
    if (refreshOnConnection) marker.refresh();
    const buildId = marker.current();
    if (buildId !== null) socket.emit(event, { buildId });
  });
  return unsubscribe;
}

/** Feed a watcher from the socket event the server binding emits. */
export function observeReleaseFromSocket(
  socket: ReleaseSocketListener,
  watcher: ReleaseWatcher,
  options: ReleaseSocketOptions = {},
): () => void {
  const event = options.event ?? 'release';
  const handler = (payload: { buildId: string | null }) => watcher.observe(payload.buildId);
  const returned = socket.on(event, handler);
  return () => {
    if (typeof returned === 'function') returned();
    else socket.off?.(event, handler);
  };
}
