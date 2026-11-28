import { bindRealtimeClient, type RealtimeClientTransport } from '../browser/realtime-client';
import type { ClientFetch } from '../browser/transport';
import { abortError } from '../internal/abort-error';
import { type BackoffPolicy, createBackoff } from '../internal/backoff';
import { assertTimerMs, type IdleTimer, startIdleTimer } from '../internal/deadline';
import { assertPositiveSafeInteger } from '../internal/positive-integer';
import {
  type ActiveAgentStream,
  type AgentWorkLimits,
  handleAgentRpcRequest,
  handleAgentStreamOpen,
  type RelayAgentClient,
} from './agent-handlers';
import {
  DEFAULT_DEVICE_RELAY_HEARTBEAT_INTERVAL_MS,
  DEFAULT_DEVICE_RELAY_LEASE_TTL_MS,
  DEFAULT_DEVICE_RELAY_MAX_CONCURRENT_STREAMS,
  DEFAULT_DEVICE_RELAY_MAX_IN_FLIGHT_RPCS,
  DEFAULT_DEVICE_RELAY_MAX_REQUEST_BYTES,
  DEFAULT_DEVICE_RELAY_MAX_RESPONSE_BYTES,
  DEFAULT_DEVICE_RELAY_MAX_STREAM_FRAME_BYTES,
  DeviceRelayError,
  type DeviceRelayJsonValue,
  deviceRelayRealtimeContract,
} from './contract';

/** Declarative local allowlist rule evaluated on the user's machine before executing any relayed RPC. */
export interface DeviceRelayRpcAllowRule {
  readonly methods?: readonly string[];
  readonly pathPrefix?: string;
  readonly exactPath?: string;
}

/** One upstream event produced by a local desktop stream handler. */
export interface DeviceRelayUpstreamFrame {
  readonly cursor?: string;
  readonly payload: DeviceRelayJsonValue;
}

/** Input passed to `DeviceRelayAgentConfig.openStream` after allowlist validation succeeds. */
export interface DeviceRelayAgentStreamInput {
  readonly topic: string;
  readonly cursor?: string;
  readonly params?: Readonly<Record<string, DeviceRelayJsonValue>>;
  readonly signal: AbortSignal;
}

/** Live lifecycle snapshot of `DeviceRelayAgent`. */
export interface DeviceRelayAgentState {
  readonly status: 'idle' | 'registering' | 'online' | 'disconnected' | 'refused' | 'closed';
  readonly deviceId: string;
  readonly leaseExpiresAt?: number;
  readonly lastError?: DeviceRelayError;
}

/** Configuration for `createDeviceRelayAgent` running on a user's desktop machine. */
export interface DeviceRelayAgentConfig {
  /** Outbound realtime transport connected to the backend (Socket.IO client or compatible). */
  readonly transport: RealtimeClientTransport;
  /** Stable identifier of this user device. */
  readonly deviceId: string;
  /** Declared capabilities advertised to the backend hub. */
  readonly capabilities: readonly string[];
  /** Requested lease TTL in ms (default 30 000). */
  readonly leaseTtlMs?: number;
  /** Heartbeat interval in ms (default 10 000; must be less than `leaseTtlMs`). */
  readonly heartbeatIntervalMs?: number;
  /** Timeout for `stitchkit.relay.hello` acknowledgement in ms (default 10 000). */
  readonly helloTimeoutMs?: number;
  /** Timeout for `stitchkit.relay.heartbeat` acknowledgement in ms (default 5 000). */
  readonly heartbeatTimeoutMs?: number;
  /** Maximum accepted request body size in bytes (default 64 KiB). */
  readonly maxRequestBodyBytes?: number;
  /** Maximum sent response body size in bytes (default 1 MiB). */
  readonly maxResponseBodyBytes?: number;
  /** Maximum concurrent in-flight unary RPCs executed locally (default 64). */
  readonly maxInFlightRequests?: number;
  /** Maximum concurrent local upstream streams (default 32). */
  readonly maxConcurrentStreams?: number;
  /** Maximum UTF-8 byte length of one emitted stream payload (default 64 KiB). */
  readonly maxStreamFrameBytes?: number;
  /** Defence-in-depth local allowlist for incoming RPCs (default-deny when omitted). */
  readonly allowRpc?:
    | readonly DeviceRelayRpcAllowRule[]
    | ((request: { readonly method: string; readonly path: string }) => boolean);
  /** Defence-in-depth local allowlist for incoming stream topics (default-deny when omitted). */
  readonly allowStreamTopics?: readonly string[] | ((topic: string) => boolean);
  /** Local fetch implementation invoked only for allowlisted unary RPCs. */
  readonly fetch?: ClientFetch;
  /** Local stream factory invoked only for allowlisted topics. */
  readonly openStream?: (
    input: DeviceRelayAgentStreamInput,
  ) =>
    | AsyncIterable<DeviceRelayUpstreamFrame>
    | Promise<AsyncIterable<DeviceRelayUpstreamFrame>>;
  /** Observer called on agent lifecycle state transitions. */
  readonly onStateChange?: (state: DeviceRelayAgentState) => void;
  /** Observer called on typed relay errors (including non-retryable registration refusals). */
  readonly onError?: (error: DeviceRelayError) => void;
  /** Optional clock for deterministic tests (defaults to `Date.now`). */
  readonly now?: () => number;
}

/** Running desktop relay agent handle. */
export interface DeviceRelayAgent {
  getState(): DeviceRelayAgentState;
  close(): void;
}

interface ValidatedAgentConfig {
  leaseTtlMs: number;
  heartbeatIntervalMs: number;
  helloTimeoutMs: number;
  heartbeatTimeoutMs: number;
  limits: AgentWorkLimits;
}

function validateAgentConfig(config: DeviceRelayAgentConfig): ValidatedAgentConfig {
  if (!config.deviceId.trim()) {
    throw new TypeError('DeviceRelayAgentConfig.deviceId cannot be empty');
  }
  const leaseTtlMs = config.leaseTtlMs ?? DEFAULT_DEVICE_RELAY_LEASE_TTL_MS;
  const heartbeatIntervalMs =
    config.heartbeatIntervalMs ??
    Math.min(
      DEFAULT_DEVICE_RELAY_HEARTBEAT_INTERVAL_MS,
      Math.max(10, Math.floor(leaseTtlMs / 3)),
    );
  const helloTimeoutMs = config.helloTimeoutMs ?? 10_000;
  const heartbeatTimeoutMs = config.heartbeatTimeoutMs ?? 5_000;
  const limits: AgentWorkLimits = {
    maxRequestBodyBytes: config.maxRequestBodyBytes ?? DEFAULT_DEVICE_RELAY_MAX_REQUEST_BYTES,
    maxResponseBodyBytes:
      config.maxResponseBodyBytes ?? DEFAULT_DEVICE_RELAY_MAX_RESPONSE_BYTES,
    maxInFlightRequests: config.maxInFlightRequests ?? DEFAULT_DEVICE_RELAY_MAX_IN_FLIGHT_RPCS,
    maxConcurrentStreams:
      config.maxConcurrentStreams ?? DEFAULT_DEVICE_RELAY_MAX_CONCURRENT_STREAMS,
    maxStreamFrameBytes:
      config.maxStreamFrameBytes ?? DEFAULT_DEVICE_RELAY_MAX_STREAM_FRAME_BYTES,
  };
  assertTimerMs('DeviceRelayAgentConfig.leaseTtlMs', leaseTtlMs);
  assertTimerMs('DeviceRelayAgentConfig.heartbeatIntervalMs', heartbeatIntervalMs);
  assertTimerMs('DeviceRelayAgentConfig.helloTimeoutMs', helloTimeoutMs);
  assertTimerMs('DeviceRelayAgentConfig.heartbeatTimeoutMs', heartbeatTimeoutMs);
  if (heartbeatIntervalMs >= leaseTtlMs) {
    throw new RangeError(
      'DeviceRelayAgentConfig.heartbeatIntervalMs must be less than leaseTtlMs',
    );
  }
  assertPositiveSafeInteger(
    'DeviceRelayAgentConfig.maxRequestBodyBytes',
    limits.maxRequestBodyBytes,
  );
  assertPositiveSafeInteger(
    'DeviceRelayAgentConfig.maxResponseBodyBytes',
    limits.maxResponseBodyBytes,
  );
  assertPositiveSafeInteger(
    'DeviceRelayAgentConfig.maxInFlightRequests',
    limits.maxInFlightRequests,
  );
  assertPositiveSafeInteger(
    'DeviceRelayAgentConfig.maxConcurrentStreams',
    limits.maxConcurrentStreams,
  );
  assertPositiveSafeInteger(
    'DeviceRelayAgentConfig.maxStreamFrameBytes',
    limits.maxStreamFrameBytes,
  );
  return { leaseTtlMs, heartbeatIntervalMs, helloTimeoutMs, heartbeatTimeoutMs, limits };
}

interface AgentLifecycleController {
  getState(): DeviceRelayAgentState;
  isClosed(): boolean;
  onConnection(connected: boolean): void;
  close(): void;
}

const HELLO_RETRY_BACKOFF: BackoffPolicy = {
  minDelayMs: 50,
  maxDelayMs: 5_000,
  jitter: 0.2,
};

function createAgentLifecycle(input: {
  config: DeviceRelayAgentConfig;
  validated: ValidatedAgentConfig;
  client: RelayAgentClient;
  now: () => number;
  abortAllWork: (reason: string) => void;
}): AgentLifecycleController {
  const { config, validated, client, now, abortAllWork } = input;
  const helloBackoff = createBackoff(HELLO_RETRY_BACKOFF);
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let helloRetryTimer: IdleTimer | undefined;
  let generation = 0;
  let closed = false;
  let permanentlyRefused = false;
  let state: DeviceRelayAgentState = { status: 'idle', deviceId: config.deviceId };

  const setState = (next: DeviceRelayAgentState): void => {
    state = next;
    config.onStateChange?.(next);
  };
  const stopHeartbeat = (): void => {
    if (heartbeatTimer !== undefined) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
  };
  const stopHelloRetry = (): void => {
    if (helloRetryTimer !== undefined) {
      helloRetryTimer.stop();
      helloRetryTimer = undefined;
    }
  };
  const scheduleHelloRetry = (epoch: number): void => {
    stopHelloRetry();
    if (closed || permanentlyRefused || epoch !== generation || !client.connected) return;
    helloRetryTimer = startIdleTimer(
      helloBackoff.next(),
      () => {
        helloRetryTimer = undefined;
        if (closed || permanentlyRefused || epoch !== generation || !client.connected) return;
        void register(epoch);
      },
      { unref: true },
    );
  };

  const startHeartbeat = (epoch: number, effectiveLeaseMs: number): void => {
    stopHeartbeat();
    const intervalMs = Math.min(
      validated.heartbeatIntervalMs,
      Math.max(10, Math.floor(effectiveLeaseMs / 2)),
    );
    heartbeatTimer = setInterval(() => {
      if (closed || permanentlyRefused || epoch !== generation || !client.connected) return;
      void client
        .request(
          'stitchkit.relay.heartbeat',
          { schemaVersion: 1, deviceId: config.deviceId, sentAtMs: now() },
          { timeoutMs: validated.heartbeatTimeoutMs },
        )
        .then((ack) => {
          if (closed || epoch !== generation) return;
          if (ack.outcome === 'ok') {
            setState({
              status: 'online',
              deviceId: config.deviceId,
              leaseExpiresAt: ack.leaseExpiresAtMs,
            });
            return;
          }
          const err = new DeviceRelayError(ack.code, ack.message, {
            retryable: ack.retryable,
            deviceId: config.deviceId,
          });
          config.onError?.(err);
          stopHeartbeat();
          abortAllWork(ack.message);
          if (!ack.retryable) {
            permanentlyRefused = true;
            setState({ status: 'refused', deviceId: config.deviceId, lastError: err });
            return;
          }
          setState({ status: 'disconnected', deviceId: config.deviceId, lastError: err });
          scheduleHelloRetry(epoch);
        })
        .catch((cause) => {
          if (closed || epoch !== generation) return;
          config.onError?.(
            new DeviceRelayError('TRANSPORT_ERROR', 'Relay heartbeat failed', {
              retryable: true,
              deviceId: config.deviceId,
              cause,
            }),
          );
        });
    }, intervalMs);
    heartbeatTimer.unref?.();
  };

  const register = async (epoch: number): Promise<void> => {
    stopHelloRetry();
    if (closed || permanentlyRefused || epoch !== generation || !client.connected) return;
    setState({ status: 'registering', deviceId: config.deviceId });
    try {
      const ack = await client.request(
        'stitchkit.relay.hello',
        {
          schemaVersion: 1,
          deviceId: config.deviceId,
          capabilities: [...config.capabilities],
          leaseTtlMs: validated.leaseTtlMs,
        },
        { timeoutMs: validated.helloTimeoutMs },
      );
      if (closed || epoch !== generation) return;
      if (ack.outcome === 'error') {
        const err = new DeviceRelayError(ack.code, ack.message, {
          retryable: ack.retryable,
          deviceId: config.deviceId,
        });
        config.onError?.(err);
        if (!ack.retryable) {
          permanentlyRefused = true;
          stopHeartbeat();
          stopHelloRetry();
          setState({ status: 'refused', deviceId: config.deviceId, lastError: err });
        } else {
          setState({ status: 'disconnected', deviceId: config.deviceId, lastError: err });
          scheduleHelloRetry(epoch);
        }
        return;
      }
      helloBackoff.reset();
      stopHelloRetry();
      setState({
        status: 'online',
        deviceId: config.deviceId,
        leaseExpiresAt: ack.leaseExpiresAtMs,
      });
      startHeartbeat(epoch, ack.leaseTtlMs);
    } catch (cause) {
      if (closed || epoch !== generation) return;
      const err = new DeviceRelayError('TRANSPORT_ERROR', 'Relay hello failed', {
        retryable: true,
        deviceId: config.deviceId,
        cause,
      });
      config.onError?.(err);
      setState({ status: 'disconnected', deviceId: config.deviceId, lastError: err });
      scheduleHelloRetry(epoch);
    }
  };

  return {
    getState: () => state,
    isClosed: () => closed,
    onConnection(connected) {
      if (closed || permanentlyRefused) return;
      generation += 1;
      const epoch = generation;
      stopHelloRetry();
      helloBackoff.reset();
      if (!connected) {
        stopHeartbeat();
        abortAllWork('Transport disconnected');
        setState({ status: 'disconnected', deviceId: config.deviceId });
        return;
      }
      void register(epoch);
    },
    close() {
      if (closed) return;
      closed = true;
      generation += 1;
      stopHeartbeat();
      stopHelloRetry();
      abortAllWork('Agent closed');
      setState({ status: 'closed', deviceId: config.deviceId });
    },
  };
}

/** Create the desktop-side User Device Relay agent with local allowlist enforcement and credit-paced streaming. */
export function createDeviceRelayAgent(config: DeviceRelayAgentConfig): DeviceRelayAgent {
  const validated = validateAgentConfig(config);
  const client = bindRealtimeClient(deviceRelayRealtimeContract, config.transport);
  const now = config.now ?? (() => Date.now());
  const inFlightRpcs = new Map<string, AbortController>();
  const activeStreams = new Map<string, ActiveAgentStream>();

  const abortAllWork = (reason: string): void => {
    for (const controller of inFlightRpcs.values()) controller.abort(abortError(reason));
    inFlightRpcs.clear();
    for (const stream of activeStreams.values()) {
      stream.closed = true;
      stream.controller.abort(abortError(reason));
      stream.wakeCredit?.();
    }
    activeStreams.clear();
  };

  const lifecycle = createAgentLifecycle({ config, validated, client, now, abortAllWork });

  const offRpc = client.on('stitchkit.relay.rpc-request', (request) => {
    void handleAgentRpcRequest({
      config,
      client,
      limits: validated.limits,
      inFlightRpcs,
      isClosed: lifecycle.isClosed,
      request,
    });
  });
  const offCancel = client.on('stitchkit.relay.rpc-cancel', (cancel) => {
    inFlightRpcs.get(cancel.requestId)?.abort(abortError(cancel.reason ?? 'Cancelled by hub'));
  });
  const offStreamOpen = client.on('stitchkit.relay.stream-open', (request) => {
    handleAgentStreamOpen({
      config,
      client,
      limits: validated.limits,
      activeStreams,
      isClosed: lifecycle.isClosed,
      request,
    });
  });
  const offStreamCredit = client.on('stitchkit.relay.stream-credit', (credit) => {
    const entry = activeStreams.get(credit.streamId);
    if (!entry || entry.closed) return;
    entry.credits += credit.credits;
    entry.wakeCredit?.();
  });
  const offStreamClose = client.on('stitchkit.relay.stream-close', (closeFrame) => {
    const entry = activeStreams.get(closeFrame.streamId);
    if (!entry) return;
    entry.closed = true;
    entry.controller.abort(abortError(closeFrame.reason ?? 'Closed by hub'));
    entry.wakeCredit?.();
  });

  const offConnection = client.onConnectionChange((connected) =>
    lifecycle.onConnection(connected),
  );
  if (client.connected) lifecycle.onConnection(true);

  return {
    getState: lifecycle.getState,
    close() {
      offRpc();
      offCancel();
      offStreamOpen();
      offStreamCredit();
      offStreamClose();
      offConnection();
      lifecycle.close();
    },
  };
}
