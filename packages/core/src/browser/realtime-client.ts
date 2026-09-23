/**
 * A typed realtime client bound over any transport shaped like the Socket.IO
 * client: every inbound event validated against the contract, every
 * acknowledged request parsed on both sides.
 */
import type { StitchLogger } from '../internal/logger';
import type {
  RealtimeAcknowledgedEvent,
  RealtimeAcknowledgement,
  RealtimeContract,
  RealtimeEventRegistry,
  RealtimeRejectedEventHook,
  RealtimeRequestArguments,
} from '../realtime/contract';
import type { RealtimeRequestOptions } from '../realtime/request';
import {
  createValidatedRealtimeSocket,
  parseRealtimeRequestAcknowledgement,
  parseRealtimeRequestArguments,
  type ValidatedRealtimeSocket,
} from '../realtime/socket';
import type { SocketEventMap, SocketIOClient } from './socket-io';
import { observeRealtimeRequestPhase, realtimeRequestTraces } from './socket-io-trace';

export type RealtimeClientTransport = Pick<
  SocketIOClient<SocketEventMap, SocketEventMap>,
  'connected' | 'on' | 'emit' | 'emitWithAck' | 'onConnectionChange'
>;

export interface BoundRealtimeClient<
  TServerToClient extends RealtimeEventRegistry,
  TClientToServer extends RealtimeEventRegistry,
> extends ValidatedRealtimeSocket<TServerToClient, TClientToServer> {
  readonly connected: boolean;
  request<TEvent extends RealtimeAcknowledgedEvent<TClientToServer>>(
    event: TEvent,
    ...args: [
      ...RealtimeRequestArguments<TClientToServer[TEvent]>,
      options: RealtimeRequestOptions,
    ]
  ): Promise<RealtimeAcknowledgement<TClientToServer[TEvent]>>;
  onConnectionChange(listener: (connected: boolean, reason?: string) => void): () => void;
}

export interface BindRealtimeClientOptions {
  onRejected?: RealtimeRejectedEventHook;
  logger?: StitchLogger;
}

function assertRealtimeClientTransport(transport: RealtimeClientTransport): void {
  for (const capability of ['on', 'emit', 'emitWithAck', 'onConnectionChange']) {
    if (typeof Reflect.get(transport, capability) !== 'function') {
      throw new TypeError(`Realtime client transport does not implement ${capability}()`);
    }
  }
  if (typeof transport.connected !== 'boolean') {
    throw new TypeError('Realtime client transport does not expose boolean connected');
  }
}

/** Add contract validation and typed acknowledgements without owning the transport lifecycle. */
export function bindRealtimeClient<
  const TServerToClient extends RealtimeEventRegistry,
  const TClientToServer extends RealtimeEventRegistry,
>(
  contract: RealtimeContract<TServerToClient, TClientToServer>,
  transport: RealtimeClientTransport,
  { onRejected, logger }: BindRealtimeClientOptions = {},
): BoundRealtimeClient<TServerToClient, TClientToServer> {
  assertRealtimeClientTransport(transport);
  const events = createValidatedRealtimeSocket({
    target: transport,
    inbound: contract.serverToClient,
    outbound: contract.clientToServer,
    inboundDirection: 'client-inbound',
    outboundDirection: 'client-outbound',
    onRejected,
    logger,
    subscribe: (event, handler) => {
      const subscribe = Reflect.get(transport, 'on');
      if (typeof subscribe !== 'function') {
        throw new Error('Socket.IO client does not implement on()');
      }
      const unsubscribe = Reflect.apply(subscribe, transport, [event, handler]);
      if (typeof unsubscribe !== 'function') {
        throw new Error('Socket.IO client on() did not return an unsubscribe function');
      }
      return () => {
        Reflect.apply(unsubscribe, undefined, []);
      };
    },
  });

  async function request<TEvent extends RealtimeAcknowledgedEvent<TClientToServer>>(
    event: TEvent,
    ...args: [
      ...RealtimeRequestArguments<TClientToServer[TEvent]>,
      options: RealtimeRequestOptions,
    ]
  ): Promise<RealtimeAcknowledgement<TClientToServer[TEvent]>> {
    const options = args.at(-1);
    if (!options || typeof options !== 'object' || !('timeoutMs' in options)) {
      throw new TypeError(`Realtime request "${event}" requires { timeoutMs }`);
    }
    const timeoutMs = options.timeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError(`Realtime request "${event}" timeoutMs must be finite and > 0`);
    }
    const values = args.slice(0, -1);
    const parsedArgs = parseRealtimeRequestArguments(
      contract.clientToServer,
      event,
      'client-outbound',
      values,
    );
    const definition = contract.clientToServer[event];
    if (!definition?.ack) {
      throw new Error(`Realtime request "${event}" has no acknowledgement schema`);
    }
    const pending = transport.emitWithAck(event, parsedArgs, options);
    const trace = realtimeRequestTraces.get(pending);
    if (trace) realtimeRequestTraces.delete(pending);
    const value = await pending;
    let acknowledgement: unknown;
    try {
      acknowledgement = parseRealtimeRequestAcknowledgement(
        definition.ack,
        event,
        'client-inbound',
        value,
        onRejected,
        logger,
      );
    } finally {
      if (trace && !trace.closed) {
        trace.closed = true;
        observeRealtimeRequestPhase(trace, 'settled');
      }
    }
    // Boundary cast: Socket.IO's emitter returns `unknown`; the selected
    // contract key and successful Zod ack parse above prove the conditional
    // acknowledgement output that TypeScript cannot retain through registry
    // indexing.
    return acknowledgement as RealtimeAcknowledgement<TClientToServer[TEvent]>;
  }

  return {
    ...events,
    get connected() {
      return transport.connected;
    },
    request,
    onConnectionChange: (listener) => transport.onConnectionChange(listener),
  };
}
