/**
 * Host-side `postMessage` bridge for `createHandler`.
 *
 * Receives string frames from a WebView / DOM window, enforces origin trust,
 * optional per-start secret, `maxFrameBytes` (before `JSON.parse`) and
 * `maxInFlight`, constructs a plain Fetch `Request` with a string body, runs
 * the handler, and posts back a `BridgeResponseFrame` or `BridgeFailureFrame`.
 */
import {
  BRIDGE_ORIGIN,
  type BridgeFailureCode,
  type BridgeFailureFrame,
  BridgeFrameSchema,
  type BridgeHeaderEntry,
  type BridgeHelloFrame,
  type BridgeRequestFrame,
  type BridgeResponseFrame,
  bridgeBodyKind,
  DEFAULT_BRIDGE_MAX_FRAME_BYTES,
  readBridgeBodyText,
} from '../contract/bridge-envelope';
import { abortError } from '../internal/abort-error';
import { utf8ByteLength } from '../internal/bounded-body';
import { assertPositiveSafeInteger } from '../internal/positive-integer';
import { randomHex } from '../internal/random-hex';
import { secretsEqual } from '../internal/secret-equal';
import { isTrustProxyHandler } from './handler-state';
import type { FetchHandler, StitchLogger } from './types';

const TEXTUAL_RESPONSES_ONLY = 'Bridge v1 supports textual responses only';
const ONE_FRAME_RESPONSES_ONLY = 'Bridge v1 does not carry streaming responses';

const DEFAULT_MAX_IN_FLIGHT = 64;

/** Trust-bearing HTTP headers stripped unconditionally from every bridge frame. */
const STRIPPED_REQUEST_HEADERS = new Set([
  'host',
  'origin',
  'x-forwarded-for',
  'x-real-ip',
  'forwarded',
]);

/** One frame delivered by the native container alongside the container-observed sender origin. */
export interface BridgeInboundMessage {
  data: string;
  origin: string;
}

/** Host-side string message port (wraps `webViewRef.postMessage` / `onMessage`). */
export interface BridgeHostPort {
  postMessage(frame: string): void;
  subscribe(listener: (message: BridgeInboundMessage) => void): () => void;
}

/** Configuration options for `serveBridge`. */
export interface BridgeHostConfig {
  /** Exact allowed sender origins (same shape as `LocalHostGuardConfig.origins`). Must be non-empty. */
  origins: readonly string[];
  /** Optional per-start secret (at least 16 characters), verified in constant time. */
  secret?: string;
  /** Maximum UTF-8 byte length for inbound and outbound frames, checked before `JSON.parse`. Default 1 MiB. */
  maxFrameBytes?: number;
  /** Maximum concurrent in-flight requests. Default 64. */
  maxInFlight?: number;
  /** Explicit host instance id announced on `hello` (defaults to a generated id). */
  hostInstance?: string;
  /** Optional host logger for internal refusal/error reasons (never exposed to the window). */
  logger?: StitchLogger;
}

/** Live counters exposed by `serveBridge` for diagnostics and tests. */
export interface BridgeHostStats {
  readonly inFlight: number;
  readonly rejectedOrigin: number;
  readonly rejectedSecret: number;
  readonly rejectedOversize: number;
  readonly rejectedInvalid: number;
  readonly rejectedBusy: number;
  readonly rejectedDuplicateId: number;
}

/** Handle returned by `serveBridge`. */
export interface BridgeHostHandle {
  /** Stop accepting frames and abort all in-flight handler calls. Idempotent. */
  close(): void;
  readonly stats: BridgeHostStats;
  readonly hostInstance: string;
}

interface HeadersWithSetCookie extends Headers {
  getSetCookie(): string[];
}

interface BridgeRuntime<TServer> {
  readonly port: BridgeHostPort;
  readonly handler: FetchHandler<TServer>;
  readonly hostInstance: string;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly secret: string | undefined;
  readonly maxFrameBytes: number;
  readonly maxInFlight: number;
  readonly logger: StitchLogger | undefined;
  readonly inFlight: Map<string, AbortController>;
  readonly counters: {
    rejectedOrigin: number;
    rejectedSecret: number;
    rejectedOversize: number;
    rejectedInvalid: number;
    rejectedBusy: number;
    rejectedDuplicateId: number;
  };
  closed: boolean;
}

function hasGetSetCookie(headers: Headers): headers is HeadersWithSetCookie {
  return 'getSetCookie' in headers && typeof headers.getSetCookie === 'function';
}

function collectResponseHeaders(headers: Headers): BridgeHeaderEntry[] {
  const entries: BridgeHeaderEntry[] = [];
  const preservesSetCookie = hasGetSetCookie(headers);
  headers.forEach((value, key) => {
    if (preservesSetCookie && key.toLowerCase() === 'set-cookie') return;
    entries.push([key, value]);
  });
  if (preservesSetCookie) {
    for (const cookie of headers.getSetCookie()) {
      entries.push(['set-cookie', cookie]);
    }
  }
  return entries;
}

function warnHost(logger: StitchLogger | undefined, message: string): void {
  try {
    if (logger) logger.warn(message);
    else console.warn(message);
  } catch {
    // Diagnostic logging must never break bridge dispatch.
  }
}

function cancelResponseBody(response: Response): void {
  void response.body?.cancel?.().catch(() => undefined);
}

function postFrame<TServer>(
  runtime: BridgeRuntime<TServer>,
  frame: BridgeResponseFrame | BridgeFailureFrame | BridgeHelloFrame,
): void {
  if (runtime.closed) return;
  try {
    runtime.port.postMessage(JSON.stringify(frame));
  } catch {
    // The window/webview may have closed between dispatch and reply.
  }
}

function sendFailure<TServer>(
  runtime: BridgeRuntime<TServer>,
  id: string,
  code: BridgeFailureCode,
  message?: string,
): void {
  postFrame(runtime, {
    v: 1,
    kind: 'failure',
    id,
    code,
    hostInstance: runtime.hostInstance,
    ...(message !== undefined && { message }),
  });
}

async function dispatchBridgeRequest<TServer>(
  runtime: BridgeRuntime<TServer>,
  frame: BridgeRequestFrame,
): Promise<void> {
  const controller = new AbortController();
  runtime.inFlight.set(frame.id, controller);
  try {
    const headers = new Headers();
    for (const [key, value] of frame.headers) {
      if (STRIPPED_REQUEST_HEADERS.has(key.toLowerCase())) continue;
      headers.append(key, value);
    }
    const method = frame.method.toUpperCase();
    const hasBody = frame.body !== undefined && method !== 'GET' && method !== 'HEAD';
    // Always pass a string body (never ArrayBuffer) so whatwg-fetch does not decode bytes as latin1.
    const req = new Request(`${BRIDGE_ORIGIN}${frame.path}`, {
      method,
      headers,
      ...(hasBody && { body: frame.body }),
      signal: controller.signal,
    });

    const response = await runtime.handler(req);
    if (runtime.closed || controller.signal.aborted) {
      cancelResponseBody(response);
      return;
    }

    if (response.status < 200 || response.status > 599) {
      cancelResponseBody(response);
      warnHost(
        runtime.logger,
        `[stitchkit] bridge handler returned out-of-range status ${response.status}`,
      );
      sendFailure(runtime, frame.id, 'host-error');
      return;
    }

    const bodyKind = bridgeBodyKind(response.headers.get('content-type'));
    if (bodyKind === 'binary' || bodyKind === 'stream') {
      cancelResponseBody(response);
      sendFailure(
        runtime,
        frame.id,
        'unsupported',
        bodyKind === 'stream' ? ONE_FRAME_RESPONSES_ONLY : TEXTUAL_RESPONSES_ONLY,
      );
      return;
    }

    const nullBodyStatus =
      response.status === 204 || response.status === 205 || response.status === 304;
    let bodyText: string | undefined;
    if (!nullBodyStatus) {
      const bodyResult = await readBridgeBodyText(response, bodyKind, {
        maxBytes: runtime.maxFrameBytes,
        signal: controller.signal,
        checkContentLength: true,
      });
      if (bodyResult.kind === 'not-utf8') {
        sendFailure(runtime, frame.id, 'unsupported', TEXTUAL_RESPONSES_ONLY);
        return;
      }
      if (bodyResult.kind === 'over-limit') {
        sendFailure(
          runtime,
          frame.id,
          'frame-too-large',
          `Bridge response frame exceeds the ${runtime.maxFrameBytes}-byte limit`,
        );
        return;
      }
      bodyText = bodyResult.text;
    }
    if (runtime.closed || controller.signal.aborted) return;

    const replyFrame: BridgeResponseFrame = {
      v: 1,
      kind: 'response',
      id: frame.id,
      status: response.status,
      statusText: response.statusText,
      headers: collectResponseHeaders(response.headers),
      hostInstance: runtime.hostInstance,
      ...(bodyText !== undefined && bodyText.length > 0 && { body: bodyText }),
    };

    const serialized = JSON.stringify(replyFrame);
    if (utf8ByteLength(serialized) > runtime.maxFrameBytes) {
      sendFailure(
        runtime,
        frame.id,
        'frame-too-large',
        `Bridge response frame exceeds the ${runtime.maxFrameBytes}-byte limit`,
      );
      return;
    }
    if (!runtime.closed) {
      try {
        runtime.port.postMessage(serialized);
      } catch {
        // Port closed before reply could be written.
      }
    }
  } catch (error) {
    if (runtime.closed || controller.signal.aborted) return;
    warnHost(
      runtime.logger,
      `[stitchkit] bridge handler threw unexpectedly: ${error instanceof Error ? error.message : String(error)}`,
    );
    sendFailure(runtime, frame.id, 'host-error');
  } finally {
    runtime.inFlight.delete(frame.id);
  }
}

function handleInboundMessage<TServer>(
  runtime: BridgeRuntime<TServer>,
  message: BridgeInboundMessage,
): void {
  if (runtime.closed) return;
  if (!runtime.allowedOrigins.has(message.origin)) {
    runtime.counters.rejectedOrigin += 1;
    warnHost(
      runtime.logger,
      `[stitchkit] bridge refused frame from disallowed origin "${message.origin}"`,
    );
    return;
  }
  if (typeof message.data !== 'string') {
    runtime.counters.rejectedInvalid += 1;
    warnHost(runtime.logger, '[stitchkit] bridge ignored non-string frame');
    return;
  }
  if (utf8ByteLength(message.data) > runtime.maxFrameBytes) {
    runtime.counters.rejectedOversize += 1;
    warnHost(
      runtime.logger,
      `[stitchkit] bridge dropped frame exceeding ${runtime.maxFrameBytes} bytes before JSON.parse`,
    );
    return;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(message.data);
  } catch {
    runtime.counters.rejectedInvalid += 1;
    warnHost(runtime.logger, '[stitchkit] bridge dropped malformed JSON frame');
    return;
  }

  const parsed = BridgeFrameSchema.safeParse(parsedJson);
  if (!parsed.success) {
    runtime.counters.rejectedInvalid += 1;
    warnHost(runtime.logger, '[stitchkit] bridge dropped frame failing schema validation');
    return;
  }

  const frame = parsed.data;
  if (frame.kind !== 'request' && frame.kind !== 'abort') {
    runtime.counters.rejectedInvalid += 1;
    return;
  }

  // Verify the launch secret BEFORE acting on `abort` or `request`, and never
  // emit a `failure` frame for an id already in flight (an attacker must not be
  // able to cancel or poison a legitimate call by guessing its id).
  if (runtime.secret !== undefined) {
    const presented = frame.secret ?? '';
    if (!secretsEqual(presented, runtime.secret)) {
      runtime.counters.rejectedSecret += 1;
      warnHost(
        runtime.logger,
        `[stitchkit] bridge refused ${frame.kind} "${frame.id}" from "${message.origin}": secret mismatch`,
      );
      if (frame.kind === 'request' && !runtime.inFlight.has(frame.id)) {
        sendFailure(runtime, frame.id, 'refused');
      }
      return;
    }
  }

  if (frame.kind === 'abort') {
    const controller = runtime.inFlight.get(frame.id);
    if (controller && !controller.signal.aborted) {
      controller.abort(abortError(frame.reason ?? 'The operation was aborted'));
    }
    return;
  }

  if (!frame.path.startsWith('/') || frame.path.startsWith('//')) {
    runtime.counters.rejectedInvalid += 1;
    warnHost(
      runtime.logger,
      `[stitchkit] bridge refused request "${frame.id}" with non-relative path`,
    );
    if (!runtime.inFlight.has(frame.id)) {
      sendFailure(runtime, frame.id, 'refused');
    }
    return;
  }

  if (runtime.inFlight.has(frame.id)) {
    runtime.counters.rejectedDuplicateId += 1;
    sendFailure(runtime, frame.id, 'duplicate-id', 'Request id is already in flight');
    return;
  }

  if (runtime.inFlight.size >= runtime.maxInFlight) {
    runtime.counters.rejectedBusy += 1;
    sendFailure(runtime, frame.id, 'host-busy', 'Host in-flight request limit reached');
    return;
  }

  void dispatchBridgeRequest(runtime, frame);
}

/**
 * Serve a Stitchkit `FetchHandler` over a string-only `postMessage` bridge.
 *
 * Announces a `hello` frame on startup so a reconnecting window drops stale
 * in-flight calls and applies normal idempotency replay rules.
 */
export function serveBridge<TServer = unknown>(
  port: BridgeHostPort,
  handler: FetchHandler<TServer>,
  config: BridgeHostConfig,
): BridgeHostHandle {
  if (isTrustProxyHandler(handler)) {
    throw new Error(
      '[stitchkit] serveBridge cannot wrap a handler configured with trustProxy: true',
    );
  }
  if (config.origins.length === 0) {
    throw new TypeError('[stitchkit] serveBridge requires at least one allowed origin');
  }
  if (config.secret !== undefined && config.secret.length < 16) {
    throw new TypeError('[stitchkit] serveBridge requires a secret of at least 16 characters');
  }
  if (config.hostInstance !== undefined && config.hostInstance.length === 0) {
    throw new TypeError('[stitchkit] serveBridge: hostInstance cannot be empty');
  }
  const maxFrameBytes = config.maxFrameBytes ?? DEFAULT_BRIDGE_MAX_FRAME_BYTES;
  const maxInFlight = config.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
  assertPositiveSafeInteger('BridgeHostConfig.maxFrameBytes', maxFrameBytes, TypeError);
  assertPositiveSafeInteger('BridgeHostConfig.maxInFlight', maxInFlight, TypeError);

  const hostInstance = config.hostInstance ?? `${Date.now().toString(36)}-${randomHex(4)}`;
  const runtime: BridgeRuntime<TServer> = {
    port,
    handler,
    hostInstance,
    allowedOrigins: new Set(config.origins),
    secret: config.secret,
    maxFrameBytes,
    maxInFlight,
    logger: config.logger,
    inFlight: new Map(),
    counters: {
      rejectedOrigin: 0,
      rejectedSecret: 0,
      rejectedOversize: 0,
      rejectedInvalid: 0,
      rejectedBusy: 0,
      rejectedDuplicateId: 0,
    },
    closed: false,
  };

  const unsubscribe = port.subscribe((message) => handleInboundMessage(runtime, message));
  postFrame(runtime, { v: 1, kind: 'hello', hostInstance });

  return {
    close(): void {
      if (runtime.closed) return;
      runtime.closed = true;
      const pending = [...runtime.inFlight.values()];
      runtime.inFlight.clear();
      const closed = abortError('Bridge host closed');
      try {
        unsubscribe();
      } finally {
        for (const controller of pending) {
          if (!controller.signal.aborted) controller.abort(closed);
        }
      }
    },
    get stats(): BridgeHostStats {
      return {
        inFlight: runtime.inFlight.size,
        ...runtime.counters,
      };
    },
    hostInstance,
  };
}
