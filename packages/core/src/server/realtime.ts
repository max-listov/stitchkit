import type { DefaultEventsMap, Socket, Server as SocketIOServer } from 'socket.io';
import type { SocketEventMap } from '../browser/socket-io';
import type { StitchLogger } from '../internal/logger';
import type {
  RealtimeContract,
  RealtimeEventRegistry,
  RealtimeRejectedEventHook,
} from '../realtime/contract';
import {
  createValidatedRealtimeSocket,
  type ValidatedRealtimeSocket,
} from '../realtime/socket';

export interface RealtimeServerConnection<
  TServerToClient extends RealtimeEventRegistry,
  TClientToServer extends RealtimeEventRegistry,
  TData = any,
> {
  /**
   * Raw Socket.IO socket for rooms and application-owned delivery policy.
   * `raw.data` carries the typed handshake identity when the server was
   * created with a `handshake` gate.
   */
  raw: Socket<SocketEventMap, SocketEventMap, DefaultEventsMap, TData>;
  events: ValidatedRealtimeSocket<TClientToServer, TServerToClient>;
  to(
    room: string,
  ): Pick<ValidatedRealtimeSocket<RealtimeEventRegistry, TServerToClient>, 'emit'>;
}

export interface RealtimeServer<
  TServerToClient extends RealtimeEventRegistry,
  TClientToServer extends RealtimeEventRegistry,
  TData = any,
> {
  onConnection(
    handler: (
      connection: RealtimeServerConnection<TServerToClient, TClientToServer, TData>,
    ) => void | Promise<void>,
  ): () => void;
  emit: ValidatedRealtimeSocket<RealtimeEventRegistry, TServerToClient>['emit'];
  to(
    room: string,
  ): Pick<ValidatedRealtimeSocket<RealtimeEventRegistry, TServerToClient>, 'emit'>;
}

export interface RealtimeServerHandle<TData = any> {
  io: SocketIOServer<SocketEventMap, SocketEventMap, DefaultEventsMap, TData>;
}

export function bindRealtimeServer<
  const TServerToClient extends RealtimeEventRegistry,
  const TClientToServer extends RealtimeEventRegistry,
  TData = any,
>(
  contract: RealtimeContract<TServerToClient, TClientToServer>,
  handle: RealtimeServerHandle<TData>,
  options: { onRejected?: RealtimeRejectedEventHook; logger?: StitchLogger } = {},
): RealtimeServer<TServerToClient, TClientToServer, TData> {
  const outbound = (target: object) =>
    createValidatedRealtimeSocket({
      target,
      inbound: {},
      outbound: contract.serverToClient,
      inboundDirection: 'server-inbound',
      outboundDirection: 'server-outbound',
      onRejected: options.onRejected,
      logger: options.logger,
    });
  const broadcast = outbound(handle.io);
  return {
    onConnection: (handler) => {
      const listener = (
        raw: Socket<SocketEventMap, SocketEventMap, DefaultEventsMap, TData>,
      ) => {
        const events = createValidatedRealtimeSocket({
          target: raw,
          inbound: contract.clientToServer,
          outbound: contract.serverToClient,
          inboundDirection: 'server-inbound',
          outboundDirection: 'server-outbound',
          onRejected: options.onRejected,
          logger: options.logger,
        });
        // A connection handler that fails — synchronously or not — fails that
        // connection, never the server: the socket is closed and the error
        // logged, and every other connection goes on. It still runs inside the
        // `connection` event, so listeners it attaches see the first frame.
        const failed = (error: unknown) => {
          try {
            raw.disconnect(true);
          } catch {
            // A socket that cannot be closed is already gone; the failure to
            // report is the handler's.
          }
          if (options.logger)
            options.logger.error('Realtime connection handler failed', { error });
          else console.error('[stitchkit] realtime connection handler failed', error);
        };
        try {
          void Promise.resolve(
            handler({ raw, events, to: (room) => outbound(raw.to(room)) }),
          ).catch(failed);
        } catch (error) {
          failed(error);
        }
      };
      handle.io.on('connection', listener);
      return () => {
        handle.io.off('connection', listener);
      };
    },
    emit: broadcast.emit,
    to: (room) => outbound(handle.io.to(room)),
  };
}
