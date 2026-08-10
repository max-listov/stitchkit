import type { Socket, Server as SocketIOServer } from 'socket.io';
import type { SocketEventMap } from '../browser/socket-io';
import type { StitchLogger } from '../logger';
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
> {
  /** Raw Socket.IO socket for handshake auth, rooms and application-owned delivery policy. */
  raw: Socket;
  events: ValidatedRealtimeSocket<TClientToServer, TServerToClient>;
  to(
    room: string,
  ): Pick<ValidatedRealtimeSocket<RealtimeEventRegistry, TServerToClient>, 'emit'>;
}

export interface RealtimeServer<
  TServerToClient extends RealtimeEventRegistry,
  TClientToServer extends RealtimeEventRegistry,
> {
  onConnection(
    handler: (
      connection: RealtimeServerConnection<TServerToClient, TClientToServer>,
    ) => void | Promise<void>,
  ): () => void;
  emit: ValidatedRealtimeSocket<RealtimeEventRegistry, TServerToClient>['emit'];
  to(
    room: string,
  ): Pick<ValidatedRealtimeSocket<RealtimeEventRegistry, TServerToClient>, 'emit'>;
}

export interface RealtimeServerHandle {
  io: SocketIOServer<SocketEventMap, SocketEventMap>;
}

export function bindRealtimeServer<
  const TServerToClient extends RealtimeEventRegistry,
  const TClientToServer extends RealtimeEventRegistry,
>(
  contract: RealtimeContract<TServerToClient, TClientToServer>,
  handle: RealtimeServerHandle,
  options: { onRejected?: RealtimeRejectedEventHook; logger?: StitchLogger } = {},
): RealtimeServer<TServerToClient, TClientToServer> {
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
      const listener = (raw: Socket) => {
        const events = createValidatedRealtimeSocket({
          target: raw,
          inbound: contract.clientToServer,
          outbound: contract.serverToClient,
          inboundDirection: 'server-inbound',
          outboundDirection: 'server-outbound',
          onRejected: options.onRejected,
          logger: options.logger,
        });
        void handler({
          raw,
          events,
          to: (room) => outbound(raw.to(room)),
        });
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
