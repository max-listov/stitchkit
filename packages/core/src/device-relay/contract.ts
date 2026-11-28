import { z } from 'zod';
import { MAX_TIMER_MS } from '../internal/timers';
import { defineRealtimeContract } from '../realtime/contract';

/** Synthetic HTTP origin used to parse relative paths cleanly in browser, Hermes, Bun and Node. */
export const DEVICE_RELAY_ORIGIN = 'http://device-relay.invalid';
/** Default conservative device lease TTL (30 s). */
export const DEFAULT_DEVICE_RELAY_LEASE_TTL_MS = 30_000;
/** Default desktop agent heartbeat cadence (10 s). */
export const DEFAULT_DEVICE_RELAY_HEARTBEAT_INTERVAL_MS = 10_000;
/** Default timeout for a unary relayed fetch call (30 s). */
export const DEFAULT_DEVICE_RELAY_RPC_TIMEOUT_MS = 30_000;
/** Default unary request body limit (64 KiB). */
export const DEFAULT_DEVICE_RELAY_MAX_REQUEST_BYTES = 64 * 1024;
/** Default unary response body limit (1 MiB). */
export const DEFAULT_DEVICE_RELAY_MAX_RESPONSE_BYTES = 1024 * 1024;
/** Default maximum UTF-8 byte size for one serialized stream event payload (64 KiB). */
export const DEFAULT_DEVICE_RELAY_MAX_STREAM_FRAME_BYTES = 64 * 1024;
/** Default ceiling on concurrent unary RPCs per connected device. */
export const DEFAULT_DEVICE_RELAY_MAX_IN_FLIGHT_RPCS = 64;
/** Default ceiling on concurrent open streams per connected device. */
export const DEFAULT_DEVICE_RELAY_MAX_CONCURRENT_STREAMS = 32;
/** Default per-stream frame buffer and credit window. */
export const DEFAULT_DEVICE_RELAY_MAX_BUFFERED_FRAMES = 128;

/** Header `[name, value]` pair preserved across relay frames. */
export const DeviceRelayHeaderEntrySchema = z.tuple([z.string(), z.string()]);
/** Header `[name, value]` pair inferred from `DeviceRelayHeaderEntrySchema`. */
export type DeviceRelayHeaderEntry = z.infer<typeof DeviceRelayHeaderEntrySchema>;

/** Wire body encoding for unary relayed HTTP payloads. */
export const DeviceRelayBodyEncodingSchema = z.enum(['utf8', 'base64']);
/** Wire body encoding inferred from `DeviceRelayBodyEncodingSchema`. */
export type DeviceRelayBodyEncoding = z.infer<typeof DeviceRelayBodyEncodingSchema>;

/** Live availability state of a registered user device. */
export const DeviceRelayStatusSchema = z.enum(['online', 'offline']);
/** Live availability state inferred from `DeviceRelayStatusSchema`. */
export type DeviceRelayStatus = z.infer<typeof DeviceRelayStatusSchema>;

/** Why a previously registered device transitioned to `offline`. */
export const DeviceRelayOfflineReasonSchema = z.enum([
  'disconnected',
  'lease-expired',
  'replaced',
  'closed',
]);
/** Offline transition reason inferred from `DeviceRelayOfflineReasonSchema`. */
export type DeviceRelayOfflineReason = z.infer<typeof DeviceRelayOfflineReasonSchema>;

/** Honest delivery boundary for a failed relay call (`unknown` forbids blind non-idempotent retries). */
export const DeviceRelayDeliveryStateSchema = z.enum(['not-sent', 'unknown', 'delivered']);
/** Honest delivery boundary inferred from `DeviceRelayDeliveryStateSchema`. */
export type DeviceRelayDeliveryState = z.infer<typeof DeviceRelayDeliveryStateSchema>;

/** Typed failure codes separating retryable transport/offline faults from non-retryable refusals. */
export const DeviceRelayErrorCodeSchema = z.enum([
  'UNAUTHORIZED',
  'FORBIDDEN',
  'IDENTITY_MISMATCH',
  'OPERATION_NOT_ALLOWED',
  'INVALID_REQUEST',
  'PAYLOAD_TOO_LARGE',
  'DEVICE_OFFLINE',
  'DELIVERY_UNKNOWN',
  'DEVICE_BUSY',
  'STREAM_CAPACITY',
  'STREAM_UNAVAILABLE',
  'STREAM_OVERFLOW',
  'FRAME_UNREPRESENTABLE',
  'TIMEOUT',
  'TRANSPORT_ERROR',
  'BROKER_UNAVAILABLE',
  'CLOSED',
]);
/** Failure code inferred from `DeviceRelayErrorCodeSchema`. */
export type DeviceRelayErrorCode = z.infer<typeof DeviceRelayErrorCodeSchema>;

const RETRYABLE_ERROR_CODES = new Set<DeviceRelayErrorCode>([
  'DEVICE_OFFLINE',
  'DEVICE_BUSY',
  'STREAM_CAPACITY',
  'TIMEOUT',
  'TRANSPORT_ERROR',
  'BROKER_UNAVAILABLE',
]);

/** Return whether a relay error code is safe to retry with backoff rather than stopping permanently. */
export function isDeviceRelayRetryableCode(code: DeviceRelayErrorCode): boolean {
  return RETRYABLE_ERROR_CODES.has(code);
}

/** Structured error raised by `DeviceRelayHub` and `DeviceRelayAgent` with retryability and delivery state. */
export class DeviceRelayError extends Error {
  readonly code: DeviceRelayErrorCode;
  readonly retryable: boolean;
  readonly delivery: DeviceRelayDeliveryState;
  readonly deviceId?: string;

  constructor(
    code: DeviceRelayErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      delivery?: DeviceRelayDeliveryState;
      deviceId?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'DeviceRelayError';
    this.code = code;
    this.retryable = options.retryable ?? isDeviceRelayRetryableCode(code);
    this.delivery = options.delivery ?? (code === 'DELIVERY_UNKNOWN' ? 'unknown' : 'not-sent');
    if (options.deviceId !== undefined) this.deviceId = options.deviceId;
  }
}

/** Return `true` only when an unknown error is a retryable `DeviceRelayError`. */
export function isRetryableDeviceRelayError(error: unknown): boolean {
  return error instanceof DeviceRelayError && error.retryable;
}

/** Snapshot of one registered device's presence, capabilities and conservative lease expiry. */
export const DeviceRelayStateSchema = z.strictObject({
  accountId: z.string().min(1),
  deviceId: z.string().min(1),
  status: DeviceRelayStatusSchema,
  capabilities: z.array(z.string().min(1)),
  instanceId: z.string().min(1),
  connectedAt: z.int().nonnegative(),
  lastHeartbeatAt: z.int().nonnegative(),
  leaseExpiresAt: z.int().nonnegative(),
  offlineReason: DeviceRelayOfflineReasonSchema.optional(),
});
/** Registered device state inferred from `DeviceRelayStateSchema`. */
export type DeviceRelayState = z.infer<typeof DeviceRelayStateSchema>;

/** Desktop → Hub handshake declaring the device id, capabilities and optional desired lease TTL. */
export const DeviceRelayHelloSchema = z.strictObject({
  schemaVersion: z.literal(1),
  deviceId: z.string().min(1).max(128),
  capabilities: z.array(z.string().min(1).max(128)).max(128),
  leaseTtlMs: z.int().positive().max(MAX_TIMER_MS).optional(),
});
/** Desktop → Hub hello frame inferred from `DeviceRelayHelloSchema`. */
export type DeviceRelayHello = z.infer<typeof DeviceRelayHelloSchema>;

/** Hub → Desktop acknowledgement for `stitchkit.relay.hello`. */
export const DeviceRelayHelloAckSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    schemaVersion: z.literal(1),
    outcome: z.literal('ok'),
    leaseTtlMs: z.int().positive().max(MAX_TIMER_MS),
    leaseExpiresAtMs: z.int().nonnegative(),
    serverTimeMs: z.int().nonnegative(),
    instanceId: z.string().min(1),
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    outcome: z.literal('error'),
    code: DeviceRelayErrorCodeSchema,
    message: z.string().min(1),
    retryable: z.boolean(),
  }),
]);
/** Hello acknowledgement inferred from `DeviceRelayHelloAckSchema`. */
export type DeviceRelayHelloAck = z.infer<typeof DeviceRelayHelloAckSchema>;

/** Desktop → Hub lease renewal frame. */
export const DeviceRelayHeartbeatSchema = z.strictObject({
  schemaVersion: z.literal(1),
  deviceId: z.string().min(1).max(128),
  sentAtMs: z.int().nonnegative(),
});
/** Heartbeat frame inferred from `DeviceRelayHeartbeatSchema`. */
export type DeviceRelayHeartbeat = z.infer<typeof DeviceRelayHeartbeatSchema>;

/** Hub → Desktop acknowledgement for `stitchkit.relay.heartbeat`. */
export const DeviceRelayHeartbeatAckSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    schemaVersion: z.literal(1),
    outcome: z.literal('ok'),
    leaseExpiresAtMs: z.int().nonnegative(),
    serverTimeMs: z.int().nonnegative(),
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    outcome: z.literal('error'),
    code: DeviceRelayErrorCodeSchema,
    message: z.string().min(1),
    retryable: z.boolean(),
  }),
]);
/** Heartbeat acknowledgement inferred from `DeviceRelayHeartbeatAckSchema`. */
export type DeviceRelayHeartbeatAck = z.infer<typeof DeviceRelayHeartbeatAckSchema>;

/** Hub → Desktop unary HTTP-fetch request frame. */
export const DeviceRelayRpcRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  requestId: z.string().min(1).max(128),
  method: z.string().min(1).max(32),
  path: z.string().min(1),
  headers: z.array(DeviceRelayHeaderEntrySchema),
  body: z.string().optional(),
  bodyEncoding: DeviceRelayBodyEncodingSchema.optional(),
  maxResponseBodyBytes: z.int().positive().optional(),
});
/** Unary RPC request frame inferred from `DeviceRelayRpcRequestSchema`. */
export type DeviceRelayRpcRequest = z.infer<typeof DeviceRelayRpcRequestSchema>;

/** Hub → Desktop cancellation notice for an in-flight unary RPC. */
export const DeviceRelayRpcCancelSchema = z.strictObject({
  schemaVersion: z.literal(1),
  requestId: z.string().min(1).max(128),
  reason: z.string().min(1).max(256).optional(),
});
/** Unary RPC cancel frame inferred from `DeviceRelayRpcCancelSchema`. */
export type DeviceRelayRpcCancel = z.infer<typeof DeviceRelayRpcCancelSchema>;

/** Desktop → Hub reply carrying either a full HTTP response or a typed relay error. */
export const DeviceRelayRpcResponseSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    schemaVersion: z.literal(1),
    requestId: z.string().min(1).max(128),
    outcome: z.literal('response'),
    status: z.int().min(200).max(599),
    statusText: z.string(),
    headers: z.array(DeviceRelayHeaderEntrySchema),
    body: z.string().optional(),
    bodyEncoding: DeviceRelayBodyEncodingSchema.optional(),
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    requestId: z.string().min(1).max(128),
    outcome: z.literal('error'),
    code: DeviceRelayErrorCodeSchema,
    message: z.string().min(1),
    retryable: z.boolean(),
  }),
]);
/** Unary RPC reply frame inferred from `DeviceRelayRpcResponseSchema`. */
export type DeviceRelayRpcResponse = z.infer<typeof DeviceRelayRpcResponseSchema>;

/** Recursive JSON value schema for stream parameters and stream payloads. */
export const DeviceRelayJsonValueSchema = z.json();
/** Recursive JSON value inferred from `DeviceRelayJsonValueSchema`. */
export type DeviceRelayJsonValue = z.infer<typeof DeviceRelayJsonValueSchema>;

/** Hub → Desktop command opening a resumable cursor stream with an explicit initial credit budget. */
export const DeviceRelayStreamOpenSchema = z.strictObject({
  schemaVersion: z.literal(1),
  streamId: z.string().min(1).max(128),
  topic: z.string().min(1).max(256),
  cursor: z.string().min(1).max(512).optional(),
  params: z.record(z.string(), DeviceRelayJsonValueSchema).optional(),
  initialCredits: z.int().positive(),
  maxFrameBytes: z.int().positive(),
});
/** Stream-open frame inferred from `DeviceRelayStreamOpenSchema`. */
export type DeviceRelayStreamOpen = z.infer<typeof DeviceRelayStreamOpenSchema>;

/** Desktop → Hub confirmation or refusal for `stitchkit.relay.stream-open`. */
export const DeviceRelayStreamOpenAckSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    schemaVersion: z.literal(1),
    streamId: z.string().min(1).max(128),
    outcome: z.literal('ok'),
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    streamId: z.string().min(1).max(128),
    outcome: z.literal('error'),
    code: DeviceRelayErrorCodeSchema,
    message: z.string().min(1),
    retryable: z.boolean(),
  }),
]);
/** Stream-open acknowledgement inferred from `DeviceRelayStreamOpenAckSchema`. */
export type DeviceRelayStreamOpenAck = z.infer<typeof DeviceRelayStreamOpenAckSchema>;

/** Hub → Desktop flow-control replenishment granting additional frames to an open stream. */
export const DeviceRelayStreamCreditSchema = z.strictObject({
  schemaVersion: z.literal(1),
  streamId: z.string().min(1).max(128),
  credits: z.int().positive(),
});
/** Stream credit frame inferred from `DeviceRelayStreamCreditSchema`. */
export type DeviceRelayStreamCredit = z.infer<typeof DeviceRelayStreamCreditSchema>;

/** Hub → Desktop command closing an upstream stream once the last subscriber leaves. */
export const DeviceRelayStreamCloseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  streamId: z.string().min(1).max(128),
  reason: z.string().min(1).max(256).optional(),
});
/** Stream close frame inferred from `DeviceRelayStreamCloseSchema`. */
export type DeviceRelayStreamClose = z.infer<typeof DeviceRelayStreamCloseSchema>;

/** Desktop → Hub stream event carrying a cursor-tagged data frame, clean end, or typed failure. */
export const DeviceRelayStreamEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    schemaVersion: z.literal(1),
    streamId: z.string().min(1).max(128),
    kind: z.literal('data'),
    cursor: z.string().min(1).max(512).optional(),
    payload: DeviceRelayJsonValueSchema,
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    streamId: z.string().min(1).max(128),
    kind: z.literal('end'),
    cursor: z.string().min(1).max(512).optional(),
    reason: z.string().min(1).max(256).optional(),
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    streamId: z.string().min(1).max(128),
    kind: z.literal('error'),
    code: DeviceRelayErrorCodeSchema,
    message: z.string().min(1),
    retryable: z.boolean(),
  }),
]);
/** Stream event frame inferred from `DeviceRelayStreamEventSchema`. */
export type DeviceRelayStreamEvent = z.infer<typeof DeviceRelayStreamEventSchema>;

/** Namespaced bidirectional realtime contract for User Device Relay (Socket.IO / WS). */
export const deviceRelayRealtimeContract = defineRealtimeContract({
  serverToClient: {
    'stitchkit.relay.rpc-request': { args: z.tuple([DeviceRelayRpcRequestSchema]) },
    'stitchkit.relay.rpc-cancel': { args: z.tuple([DeviceRelayRpcCancelSchema]) },
    'stitchkit.relay.stream-open': { args: z.tuple([DeviceRelayStreamOpenSchema]) },
    'stitchkit.relay.stream-credit': { args: z.tuple([DeviceRelayStreamCreditSchema]) },
    'stitchkit.relay.stream-close': { args: z.tuple([DeviceRelayStreamCloseSchema]) },
  },
  clientToServer: {
    'stitchkit.relay.hello': {
      args: z.tuple([DeviceRelayHelloSchema]),
      ack: DeviceRelayHelloAckSchema,
    },
    'stitchkit.relay.heartbeat': {
      args: z.tuple([DeviceRelayHeartbeatSchema]),
      ack: DeviceRelayHeartbeatAckSchema,
    },
    'stitchkit.relay.rpc-response': { args: z.tuple([DeviceRelayRpcResponseSchema]) },
    'stitchkit.relay.stream-open-ack': { args: z.tuple([DeviceRelayStreamOpenAckSchema]) },
    'stitchkit.relay.stream-event': { args: z.tuple([DeviceRelayStreamEventSchema]) },
  },
});
