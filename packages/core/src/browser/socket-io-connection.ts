import {
  RealtimeRequestDisconnectedError,
  RealtimeRequestTimeoutError,
} from '../realtime/request';
import { createRetainedTopics } from './retained';
import type { SocketEventMap, SocketIOClientConfig } from './socket-io';
import type { IoFn } from './socket-io-peer';

type ClientSocket = ReturnType<IoFn>;

function toIoAuth(
  auth: SocketIOClientConfig['auth'],
): Record<string, unknown> | ((cb: (data: object) => void) => void) | undefined {
  if (typeof auth !== 'function') return auth;
  return (cb) => {
    void Promise.resolve()
      .then(auth)
      .then(cb, () => cb({}));
  };
}

/** The `io()` options this client's configuration stands for. */
export function ioOptions<TServerEvents extends SocketEventMap>(
  config: SocketIOClientConfig<TServerEvents>,
) {
  return {
    path: config.path ?? '/socket.io/',
    withCredentials: config.withCredentials ?? true,
    auth: toIoAuth(config.auth),
    ...(config.query && { query: config.query }),
    ...(config.extraHeaders && { extraHeaders: config.extraHeaders }),
    transports: config.transports ?? ['websocket', 'polling'],
    autoConnect: false,
    reconnection: true,
    reconnectionAttempts: config.reconnectionAttempts ?? Infinity,
    reconnectionDelay: config.reconnectionDelay ?? 1000,
    reconnectionDelayMax: config.reconnectionDelayMax ?? 5000,
    timeout: config.timeout ?? 20_000,
  };
}

/**
 * A peer that will not load is a TERMINAL connection failure, and it is
 * reported as one.
 *
 * It used to be an unhandled rejection: `connect()` fired the load and
 * nothing was listening on the failure path, so a missing `socket.io-client`
 * took the process down at the first connect. The message was already the
 * right one — the loader has wrapped the cause in an explanatory error for a
 * long time — but an unhandled rejection is not something a caller can act
 * on, retry, or report: the only outcome available was the process dying.
 * For the self-contained-artifact consumer this adapter's `peers` option
 * exists for, that is the worst possible moment to have no choices.
 *
 * With no `onConnectError` the failure is still re-thrown, so a project that
 * asked for nothing keeps today's loud behaviour instead of a silent
 * never-connecting client.
 */
export function reportPeerFailure(
  config: Pick<SocketIOClientConfig, 'onConnectError'>,
  error: unknown,
): void {
  if (!config.onConnectError) throw error;
  config.onConnectError({
    message: error instanceof Error ? error.message : String(error),
    data: error,
    terminal: true,
  });
}

/**
 * One acknowledged emit, settled exactly once: by the acknowledgement, by its
 * timeout, or by the socket dropping — each a distinguishable rejection.
 */
export function awaitAcknowledgement(input: {
  active: ClientSocket;
  event: string;
  args: readonly unknown[];
  timeoutMs: number;
  pendingRequestDisconnects: Set<() => void>;
  closeTrace(phase: 'timeout' | 'disconnected'): void;
  emit(): Promise<unknown>;
}): Promise<unknown> {
  const { active, event } = input;
  return new Promise<unknown>((resolve, reject) => {
    let settled = false;
    const finish = (result: () => void): void => {
      if (settled) return;
      settled = true;
      input.pendingRequestDisconnects.delete(onDisconnect);
      active.off('disconnect', onDisconnect);
      result();
    };
    const onDisconnect = (): void => {
      finish(() => {
        input.closeTrace('disconnected');
        reject(new RealtimeRequestDisconnectedError(event));
      });
    };
    input.pendingRequestDisconnects.add(onDisconnect);
    active.on('disconnect', onDisconnect);
    const acknowledgement = input.emit();
    void acknowledgement.then(
      (value) => finish(() => resolve(value)),
      () => {
        finish(() => {
          const connected = active.connected;
          input.closeTrace(connected ? 'timeout' : 'disconnected');
          reject(
            connected
              ? new RealtimeRequestTimeoutError(event, input.timeoutMs)
              : new RealtimeRequestDisconnectedError(event),
          );
        });
      },
    );
  });
}

/**
 * Sticky events — retained last value per topic. The store lives outside the
 * socket, so a retained value survives a disconnect()/connect() cycle; each
 * value is the event's first emitted argument.
 */
export function createStickyEvents(retain: readonly PropertyKey[] | undefined) {
  const names = retain ? retain.map(String) : [];
  const known = new Set(names);
  const retained = names.length > 0 ? createRetainedTopics<Record<string, unknown>>() : null;
  return {
    /**
     * Record retained events' latest payload, independent of any user handler,
     * so the value is available to a subscriber that connects later. Attached
     * before connect so a handshake-time emission is captured too.
     */
    record(socket: ClientSocket): void {
      if (!retained) return;
      for (const name of names) {
        socket.on(name, (payload: unknown) => retained.record(name, payload));
      }
    },
    replay(name: string, handler: (...args: unknown[]) => void): void {
      if (retained && known.has(name)) retained.replay(name, (payload) => handler(payload));
    },
  };
}

/** The one pending server-disconnect recycle, replaced by a newer one and cleared on teardown. */
export function createRecycle(delay: number | false) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = (): void => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };
  return {
    clear,
    schedule(run: () => void): void {
      if (delay === false) return;
      clear();
      timer = setTimeout(() => {
        timer = null;
        run();
      }, delay);
    },
  };
}

/**
 * A connection error as the application hears it. `active === false` means
 * socket.io destroyed its own retry path (a namespace middleware rejection is
 * terminal); the caller then resets its connection intent so a later
 * `connect()` is not swallowed by the idempotence guard and re-reads a
 * function-form `auth`.
 */
export function connectErrorReport(error: Error, socket: ClientSocket | null) {
  return {
    message: error.message,
    data: Reflect.get(error, 'data'),
    terminal: socket !== null && !socket.active,
  };
}
