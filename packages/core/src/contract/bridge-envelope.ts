/**
 * Wire envelope for the `postMessage` bridge carrying Fetch `Request` and
 * `Response` frames between a WebView / DOM window and a Stitchkit handler host.
 *
 * Textual payloads in one frame only in v1: binary bodies, streaming responses
 * and bytes that are not UTF-8 — under a text type or none — are refused
 * explicitly with `failure: 'unsupported'` rather than silently corrupted across
 * polyfilled Fetch implementations or buffered until a stream ends.
 */
import { z } from 'zod';
import {
  type BoundedTextOptions,
  type BoundedUtf8Result,
  readBoundedText,
  readBoundedUtf8,
} from '../internal/bounded-body';
import { mediaTypeEssence } from '../internal/media-type';

/** Synthetic HTTP origin used by the bridge host so RN's URL polyfill parses `pathname` and `search`. */
export const BRIDGE_ORIGIN = 'http://bridge.invalid';

/** Default maximum UTF-8 byte size for a single serialized bridge frame (1 MiB). */
export const DEFAULT_BRIDGE_MAX_FRAME_BYTES = 1024 * 1024;

/** One header pair `[name, value]`, preserving repeated headers such as `Set-Cookie`. */
export const BridgeHeaderEntrySchema = z.tuple([z.string(), z.string()]);
/** Header `[name, value]` tuple inferred from `BridgeHeaderEntrySchema`. */
export type BridgeHeaderEntry = z.infer<typeof BridgeHeaderEntrySchema>;

/** Transport-level failure codes when no HTTP `Response` can be delivered. */
export const BridgeFailureCodeSchema = z.enum([
  'host-busy',
  'duplicate-id',
  'unsupported',
  'frame-too-large',
  'refused',
  'host-error',
]);
/** Transport-level bridge failure code inferred from `BridgeFailureCodeSchema`. */
export type BridgeFailureCode = z.infer<typeof BridgeFailureCodeSchema>;

/** Window → Host: execute one Fetch request against the handler. */
export const BridgeRequestFrameSchema = z.strictObject({
  v: z.literal(1),
  kind: z.literal('request'),
  id: z.string().min(1),
  method: z.string().min(1),
  path: z.string().min(1),
  headers: z.array(BridgeHeaderEntrySchema),
  body: z.string().optional(),
  secret: z.string().optional(),
});
/** Serialized window-to-host request frame inferred from `BridgeRequestFrameSchema`. */
export type BridgeRequestFrame = z.infer<typeof BridgeRequestFrameSchema>;

/** Window → Host: cancel an in-flight request by id. */
export const BridgeAbortFrameSchema = z.strictObject({
  v: z.literal(1),
  kind: z.literal('abort'),
  id: z.string().min(1),
  reason: z.string().optional(),
  secret: z.string().optional(),
});
/** Window-to-host abort frame inferred from `BridgeAbortFrameSchema`. */
export type BridgeAbortFrame = z.infer<typeof BridgeAbortFrameSchema>;

/** Host → Window: the HTTP response produced by the handler (including 4xx/5xx envelopes). */
export const BridgeResponseFrameSchema = z.strictObject({
  v: z.literal(1),
  kind: z.literal('response'),
  id: z.string().min(1),
  status: z.number().int().min(200).max(599),
  statusText: z.string(),
  headers: z.array(BridgeHeaderEntrySchema),
  body: z.string().optional(),
  hostInstance: z.string().min(1).optional(),
});
/** Host-to-window HTTP response frame inferred from `BridgeResponseFrameSchema`. */
export type BridgeResponseFrame = z.infer<typeof BridgeResponseFrameSchema>;

/** Host → Window: transport-level refusal when no HTTP response exists. */
export const BridgeFailureFrameSchema = z.strictObject({
  v: z.literal(1),
  kind: z.literal('failure'),
  id: z.string().min(1),
  code: BridgeFailureCodeSchema,
  message: z.string().optional(),
  hostInstance: z.string().min(1).optional(),
});
/** Host-to-window transport failure frame inferred from `BridgeFailureFrameSchema`. */
export type BridgeFailureFrame = z.infer<typeof BridgeFailureFrameSchema>;

/** Host → Window: host lifecycle announcement; a new `hostInstance` invalidates prior in-flight calls. */
export const BridgeHelloFrameSchema = z.strictObject({
  v: z.literal(1),
  kind: z.literal('hello'),
  hostInstance: z.string().min(1),
});
/** Host-to-window lifecycle hello frame inferred from `BridgeHelloFrameSchema`. */
export type BridgeHelloFrame = z.infer<typeof BridgeHelloFrameSchema>;

/** Any valid v1 bridge frame. */
export const BridgeFrameSchema = z.discriminatedUnion('kind', [
  BridgeRequestFrameSchema,
  BridgeAbortFrameSchema,
  BridgeResponseFrameSchema,
  BridgeFailureFrameSchema,
  BridgeHelloFrameSchema,
]);
/** Discriminated union of all v1 bridge frames inferred from `BridgeFrameSchema`. */
export type BridgeFrame = z.infer<typeof BridgeFrameSchema>;

const TEXTUAL_APPLICATION_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/x-www-form-urlencoded',
  'application/javascript',
  'application/ecmascript',
  'image/svg+xml',
]);

/** The framings a streaming response is written in (`sse`, `ndjson`): one frame cannot hold them. */
const STREAMING_TYPES = new Set(['text/event-stream', 'application/x-ndjson']);

/** How a body travels in bridge v1, by its `Content-Type`. */
export type BridgeBodyKind = 'text' | 'untyped' | 'binary' | 'stream';

/**
 * How a body travels in bridge v1, by its `Content-Type`: `text` and `untyped` as a UTF-8
 * string when its bytes are UTF-8, `binary` and `stream` never. Fetch gives a string body
 * `text/plain`, so a body without a type was built from bytes, a stream or an untyped `Blob`.
 */
export function bridgeBodyKind(contentType: string | null): BridgeBodyKind {
  const essence = mediaTypeEssence(contentType);
  if (essence === '') return 'untyped';
  if (STREAMING_TYPES.has(essence)) return 'stream';
  if (essence.startsWith('text/')) return 'text';
  if (TEXTUAL_APPLICATION_TYPES.has(essence)) return 'text';
  if (
    essence.startsWith('application/') &&
    (essence.endsWith('+json') || essence.endsWith('+xml'))
  ) {
    return 'text';
  }
  return 'binary';
}

/**
 * Read a body that travels as text. Its bytes must be UTF-8 whatever its type says, so a declared
 * charset never turns other bytes into U+FFFD: wherever this runtime shows the bytes and decodes
 * strictly, they end `not-utf8`. A runtime without a body stream or `TextDecoder` (`whatwg-fetch`
 * in React Native) reads a typed body with its own `text()`, and refuses an untyped one unless
 * it is ASCII, since nothing there shows it is text.
 */
export function readBridgeBodyText(
  source: Request | Response,
  kind: 'text' | 'untyped',
  options: BoundedTextOptions,
): Promise<BoundedUtf8Result> {
  const strict =
    kind === 'untyped' || (source.body !== undefined && typeof TextDecoder === 'function');
  return strict ? readBoundedUtf8(source, options) : readBoundedText(source, options);
}
