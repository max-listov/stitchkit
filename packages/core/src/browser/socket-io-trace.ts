/**
 * Request-phase tracing for acknowledged Socket.IO emits: which phase a request
 * reached — handed to the engine, acknowledged on the wire, settled — observed
 * by reading only the packet envelope, never its payload.
 */
import { randomHex } from '../internal/random-hex';
import type {
  RealtimeRequestPhase,
  RealtimeRequestPhaseEvent,
  RealtimeRequestPhaseHook,
} from '../realtime/request';

type ClientSocket = ReturnType<typeof import('socket.io-client')['io']>;

export interface RealtimeRequestTrace {
  readonly requestId: string;
  readonly event: string;
  readonly startedAt: number;
  readonly observeClient?: RealtimeRequestPhaseHook;
  readonly observeRequest?: RealtimeRequestPhaseHook;
  nativeKey?: string;
  closed: boolean;
}

export const realtimeRequestTraces = new WeakMap<Promise<unknown>, RealtimeRequestTrace>();

export function observeRealtimeRequestPhase(
  trace: RealtimeRequestTrace,
  phase: RealtimeRequestPhase,
): void {
  const observation: RealtimeRequestPhaseEvent = {
    requestId: trace.requestId,
    event: trace.event,
    phase,
    elapsedMs: performance.now() - trace.startedAt,
  };
  const observers =
    trace.observeRequest && trace.observeRequest !== trace.observeClient
      ? [trace.observeClient, trace.observeRequest]
      : [trace.observeClient ?? trace.observeRequest];
  for (const observer of observers) {
    if (!observer) continue;
    try {
      const result = observer(observation);
      if (result) void Promise.resolve(result).catch(() => undefined);
    } catch {
      // Observability is isolated: a broken observer cannot change request truth.
    }
  }
}

interface SocketIoPacketIdentity {
  readonly namespace: string;
  readonly id: string;
}

/** Read only the Socket.IO packet envelope prefix; payload JSON is never parsed. */
function socketIoPacketIdentity(
  data: unknown,
  expected: 'event' | 'ack',
): SocketIoPacketIdentity | null {
  if (typeof data !== 'string') return null;
  const type = data.charAt(0);
  const binary = type === (expected === 'event' ? '5' : '6');
  if (type !== (expected === 'event' ? '2' : '3') && !binary) return null;

  let offset = 1;
  if (binary) {
    const separator = data.indexOf('-', offset);
    if (separator < 0) return null;
    for (let index = offset; index < separator; index += 1) {
      const code = data.charCodeAt(index);
      if (code < 48 || code > 57) return null;
    }
    offset = separator + 1;
  }

  let namespace = '/';
  if (data.charAt(offset) === '/') {
    const separator = data.indexOf(',', offset);
    if (separator < 0) return null;
    namespace = data.slice(offset, separator);
    offset = separator + 1;
  }

  const start = offset;
  while (offset < data.length) {
    const code = data.charCodeAt(offset);
    if (code < 48 || code > 57) break;
    offset += 1;
  }
  if (offset === start) return null;
  return { namespace, id: data.slice(start, offset) };
}

function packetIdentityKey(identity: SocketIoPacketIdentity): string {
  return `${identity.namespace}:${identity.id}`;
}

/** One client's traces: started per request, matched to engine packets by their envelope. */
export function createRequestTracer(onRequestPhase: RealtimeRequestPhaseHook | undefined) {
  const requestTracesByNativeKey = new Map<string, RealtimeRequestTrace>();
  const observedRequestEngines = new WeakSet<object>();
  let startingRequestTrace: RealtimeRequestTrace | null = null;
  return {
    /** A trace for one request, when anyone is listening for its phases. */
    start(event: string, onPhase: RealtimeRequestPhaseHook | undefined) {
      if (!onRequestPhase && !onPhase) return undefined;
      const trace: RealtimeRequestTrace = {
        requestId: randomHex(16),
        event,
        startedAt: performance.now(),
        observeClient: onRequestPhase,
        observeRequest: onPhase,
        closed: false,
      };
      return trace;
    },
    close(trace: RealtimeRequestTrace | undefined, phase: 'timeout' | 'disconnected'): void {
      if (!trace || trace.closed) return;
      trace.closed = true;
      if (trace.nativeKey) requestTracesByNativeKey.delete(trace.nativeKey);
      observeRealtimeRequestPhase(trace, phase);
    },
    /** Run the emit that creates the request's packet with its trace as the current one. */
    starting<T>(trace: RealtimeRequestTrace | undefined, emit: () => T): T {
      startingRequestTrace = trace ?? null;
      try {
        return emit();
      } finally {
        startingRequestTrace = null;
      }
    },
    /**
     * With a client-wide phase hook, watch every engine the socket's manager
     * opens — a reconnect brings a new one. `current` is read at open time, so
     * a socket released since is not observed.
     */
    observeEachOpen(target: ClientSocket, current: () => ClientSocket | null): void {
      if (!onRequestPhase) return;
      target.io.on('open', () => {
        const socket = current();
        if (socket) this.observe(socket);
      });
    },
    /** Watch a socket's engine for the packets that carry traced requests. */
    observe(target: ClientSocket): void {
      const engine = target.io.engine;
      if (!engine || observedRequestEngines.has(engine)) return;
      observedRequestEngines.add(engine);
      engine.on('packetCreate', (packet) => {
        if (!startingRequestTrace || packet.type !== 'message') return;
        const identity = socketIoPacketIdentity(packet.data, 'event');
        if (!identity) return;
        const key = packetIdentityKey(identity);
        startingRequestTrace.nativeKey = key;
        requestTracesByNativeKey.set(key, startingRequestTrace);
        observeRealtimeRequestPhase(startingRequestTrace, 'engine-handoff');
      });
      engine.on('packet', (packet) => {
        if (packet.type !== 'message') return;
        const identity = socketIoPacketIdentity(packet.data, 'ack');
        if (!identity) return;
        const key = packetIdentityKey(identity);
        const trace = requestTracesByNativeKey.get(key);
        if (!trace || trace.closed) return;
        observeRealtimeRequestPhase(trace, 'engine-ack-received');
        requestTracesByNativeKey.delete(key);
      });
    },
  };
}
