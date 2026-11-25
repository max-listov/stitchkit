/**
 * Window-side `ClientFetch` adapter over a string-only `postMessage` port or an
 * async `invoke(frame) => Promise<frame>` seam (Expo DOM).
 *
 * Hands `createClient(contract, { baseUrl: BRIDGE_ORIGIN, fetch })` a standard
 * Fetch function so the contract and typed client stay unchanged while calls
 * travel across a WebView bridge.
 */
import {
  BRIDGE_ORIGIN,
  type BridgeAbortFrame,
  type BridgeHeaderEntry,
  type BridgeRequestFrame,
  bridgeBodyKind,
  DEFAULT_BRIDGE_MAX_FRAME_BYTES,
  readBridgeBodyText,
} from '../contract/bridge-envelope';
import { abortReason, raceAbort, withLinkedAbortSignals } from '../internal/abort-race';
import { utf8ByteLength } from '../internal/bounded-body';
import { assertPositiveSafeInteger } from '../internal/positive-integer';
import { randomHex } from '../internal/random-hex';
import { isRecord } from '../internal/typed';
import {
  BridgeFailureError,
  createBridgeClosedError,
  createBridgeRestartError,
  createUnusableReplyError,
} from './bridge-errors';
import {
  type BridgeDropReason,
  buildResponseFromFrame,
  droppedReplyError,
  MAX_WINDOW_INSTANCE_LENGTH,
  readInboundFrame,
} from './bridge-inbound';
import type { ClientFetch } from './transport';

/** Bidirectional string-message port (wraps `window.ReactNativeWebView` / `MessagePort`). */
export interface BridgeClientPort {
  postMessage(frame: string): void;
  subscribe(listener: (frame: string) => void): () => void;
}

/** Single-call async transport (Expo DOM `use dom` action returning the serialized reply frame). */
export type BridgeInvoke = (frame: string) => Promise<string>;

/** Configuration options for `createBridgeFetch`. */
export interface BridgeFetchOptions {
  /** Maximum UTF-8 byte length for outbound and inbound serialized frames. Default 1 MiB. */
  maxFrameBytes?: number;
  /** Optional per-start host secret attached to every outbound request and abort frame. */
  secret?: string;
  /** Explicit unique identifier for this window instance, 1–128 characters (defaults to a generated id). */
  windowInstance?: string;
  /** Optional observer invoked when an inbound frame is discarded without breaking the channel. */
  onDroppedFrame?: (reason: BridgeDropReason) => void;
}

/** `ClientFetch` with an idempotent `close()` to unsubscribe the port and fail pending calls. */
export type BridgeFetch = ClientFetch & {
  close(): void;
};

interface PendingCall {
  resolve(response: Response): void;
  reject(error: unknown): void;
  cleanup(): void;
}

function createWindowInstanceId(): string {
  const cryptoGlobal: unknown = Reflect.get(globalThis, 'crypto');
  if (isRecord(cryptoGlobal) && typeof cryptoGlobal.getRandomValues === 'function') {
    return `${Date.now().toString(36)}-${randomHex(4)}`;
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeHeaders(input: HeadersInit | undefined): BridgeHeaderEntry[] {
  if (!input) return [];
  const entries: BridgeHeaderEntry[] = [];
  if (input instanceof Headers) {
    input.forEach((value, key) => {
      entries.push([key, value]);
    });
    return entries;
  }
  if (Array.isArray(input)) {
    for (const pair of input) {
      if (pair.length === 2) entries.push([String(pair[0]), String(pair[1])]);
    }
    return entries;
  }
  for (const [key, value] of Object.entries(input)) {
    entries.push([key, value]);
  }
  return entries;
}

function frameTooLargeError(maxFrameBytes: number): BridgeFailureError {
  return new BridgeFailureError(
    'frame-too-large',
    `Bridge request frame exceeds the ${maxFrameBytes}-byte limit`,
  );
}

const TEXTUAL_REQUESTS_ONLY = 'Bridge v1 supports textual request bodies only';

/**
 * How a request body of this type travels, or its refusal: the same for a `Request` and for a
 * string body handed in `init`.
 */
function textualRequestKind(contentType: string | null): 'text' | 'untyped' {
  const kind = bridgeBodyKind(contentType);
  if (kind === 'stream') {
    throw new BridgeFailureError(
      'unsupported',
      'Bridge v1 does not carry streaming request bodies',
    );
  }
  if (kind === 'binary') throw new BridgeFailureError('unsupported', TEXTUAL_REQUESTS_ONLY);
  return kind;
}

function headerValue(headers: readonly BridgeHeaderEntry[], name: string): string | null {
  return headers.find(([key]) => key.toLowerCase() === name)?.[1] ?? null;
}

async function readRequestBodyText(
  input: Request,
  maxFrameBytes: number,
  signal: AbortSignal | undefined,
  closeSignal: AbortSignal,
): Promise<string> {
  const kind = textualRequestKind(input.headers.get('content-type'));
  const result = await withLinkedAbortSignals(signal, closeSignal, (readSignal) =>
    readBridgeBodyText(input, kind, {
      maxBytes: maxFrameBytes,
      signal: readSignal,
      checkContentLength: true,
    }),
  );
  if (result.kind === 'over-limit') throw frameTooLargeError(maxFrameBytes);
  if (result.kind === 'not-utf8')
    throw new BridgeFailureError('unsupported', TEXTUAL_REQUESTS_ONLY);
  return result.text;
}

async function prepareRequestFrame(
  id: string,
  input: string | URL | Request,
  init: RequestInit | undefined,
  secret: string | undefined,
  maxFrameBytes: number,
  closeSignal: AbortSignal,
): Promise<{ serialized: string; signal: AbortSignal | undefined }> {
  const isRequest = input instanceof Request;
  const urlStr = isRequest ? input.url : String(input);
  const method = (init?.method ?? (isRequest ? input.method : 'GET')).toUpperCase();
  const headers = normalizeHeaders(init?.headers ?? (isRequest ? input.headers : undefined));
  const signal = init?.signal ?? (isRequest ? input.signal : undefined) ?? undefined;
  if (signal?.aborted) throw abortReason(signal);
  if (closeSignal.aborted) throw abortReason(closeSignal);

  let body: BodyInit | null | undefined = init?.body;
  if (isRequest && init?.body === undefined && method !== 'GET' && method !== 'HEAD') {
    const text = await readRequestBodyText(input, maxFrameBytes, signal, closeSignal);
    if (text.length > 0) body = text;
  }

  let bodyText: string | undefined;
  if (body !== undefined && body !== null) {
    if (typeof body !== 'string') {
      throw new BridgeFailureError(
        'unsupported',
        'Bridge v1 supports string request bodies only',
      );
    }
    textualRequestKind(headerValue(headers, 'content-type'));
    if (utf8ByteLength(body) > maxFrameBytes) throw frameTooLargeError(maxFrameBytes);
    bodyText = body;
  }

  const parsedUrl = new URL(urlStr, BRIDGE_ORIGIN);
  const path = `${parsedUrl.pathname}${parsedUrl.search}`;
  const frame: BridgeRequestFrame = {
    v: 1,
    kind: 'request',
    id,
    method,
    path,
    headers,
    ...(bodyText !== undefined && { body: bodyText }),
    ...(secret !== undefined && { secret }),
  };

  const serialized = JSON.stringify(frame);
  if (utf8ByteLength(serialized) > maxFrameBytes) throw frameTooLargeError(maxFrameBytes);
  return { serialized, signal };
}

function abortReasonText(reason: unknown): string | undefined {
  if (typeof reason === 'string' && reason.length > 0) return reason;
  if (reason instanceof Error && reason.message.length > 0) return reason.message;
  return undefined;
}

/**
 * Serialize an abort frame while guaranteeing an oversized `reason` never
 * pushes the abort control frame past `maxFrameBytes`.
 */
function serializeAbortFrame(
  id: string,
  reason: string | undefined,
  secret: string | undefined,
  maxFrameBytes: number,
): string {
  const base: BridgeAbortFrame = {
    v: 1,
    kind: 'abort',
    id,
    ...(secret !== undefined && { secret }),
  };
  if (reason !== undefined) {
    const withReason = JSON.stringify({ ...base, reason });
    if (utf8ByteLength(withReason) <= maxFrameBytes) return withReason;
  }
  return JSON.stringify(base);
}

function createInvokeBridgeFetch(
  target: BridgeInvoke,
  options: BridgeFetchOptions,
  maxFrameBytes: number,
  nextId: () => string,
): BridgeFetch {
  let closed = false;
  const closeController = new AbortController();

  return Object.assign(
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (closed) throw createBridgeClosedError('Bridge fetch is closed');
      const id = nextId();
      const { serialized, signal } = await prepareRequestFrame(
        id,
        input,
        init,
        options.secret,
        maxFrameBytes,
        closeController.signal,
      );
      if (closed) throw createBridgeClosedError('Bridge fetch is closed');

      const rawReply = await withLinkedAbortSignals(
        signal,
        closeController.signal,
        (combined) => raceAbort(target(serialized), combined),
      );
      if (closed) throw createBridgeClosedError('Bridge fetch is closed');

      const read = readInboundFrame(rawReply, maxFrameBytes);
      if ('dropped' in read) {
        options.onDroppedFrame?.(read.dropped);
        throw droppedReplyError(read.dropped, maxFrameBytes);
      }
      const { frame } = read;
      if (frame.kind !== 'response' && frame.kind !== 'failure') {
        throw createUnusableReplyError('Invalid bridge reply frame');
      }
      if (frame.id !== id) {
        options.onDroppedFrame?.('unknown-id');
        throw createUnusableReplyError('Bridge reply id did not match request');
      }
      if (frame.kind === 'failure') {
        throw new BridgeFailureError(frame.code, frame.message);
      }
      return buildResponseFromFrame(frame);
    },
    {
      close(): void {
        if (closed) return;
        closed = true;
        closeController.abort(createBridgeClosedError('Bridge fetch closed'));
      },
    },
  );
}

/**
 * Create a `ClientFetch` backed by either a string `postMessage` port or an
 * async `invoke(frame) => Promise<frame>` adapter (Expo DOM).
 */
export function createBridgeFetch(
  target: BridgeClientPort | BridgeInvoke,
  options: BridgeFetchOptions = {},
): BridgeFetch {
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_BRIDGE_MAX_FRAME_BYTES;
  assertPositiveSafeInteger('BridgeFetchOptions.maxFrameBytes', maxFrameBytes, TypeError);
  if (options.windowInstance !== undefined && options.windowInstance.length === 0) {
    throw new TypeError('[stitchkit] createBridgeFetch: windowInstance cannot be empty');
  }
  if ((options.windowInstance?.length ?? 0) > MAX_WINDOW_INSTANCE_LENGTH) {
    throw new TypeError(
      `[stitchkit] createBridgeFetch: windowInstance must be at most ${MAX_WINDOW_INSTANCE_LENGTH} characters`,
    );
  }
  const windowInstance = options.windowInstance ?? createWindowInstanceId();
  let counter = 0;
  const nextId = (): string => {
    counter += 1;
    return `${windowInstance}:${counter}`;
  };

  if (typeof target === 'function') {
    return createInvokeBridgeFetch(target, options, maxFrameBytes, nextId);
  }

  const inFlight = new Map<string, PendingCall>();
  let currentHostInstance: string | undefined;
  let closed = false;
  const closeController = new AbortController();

  const rejectAllPending = (error: Error): void => {
    const entries = [...inFlight.values()];
    inFlight.clear();
    for (const pending of entries) {
      pending.cleanup();
      pending.reject(error);
    }
  };

  const unsubscribe = target.subscribe((raw) => {
    if (closed) return;
    const read = readInboundFrame(raw, maxFrameBytes);
    if ('dropped' in read) {
      options.onDroppedFrame?.(read.dropped);
      // A reply this window cannot read still names its call: refuse it rather than wait.
      const pending = read.replyTo === undefined ? undefined : inFlight.get(read.replyTo);
      if (pending !== undefined && read.replyTo !== undefined) {
        inFlight.delete(read.replyTo);
        pending.cleanup();
        pending.reject(droppedReplyError(read.dropped, maxFrameBytes));
      }
      return;
    }
    const { frame } = read;

    if (frame.kind === 'hello') {
      const restarted =
        (currentHostInstance !== undefined && currentHostInstance !== frame.hostInstance) ||
        (currentHostInstance === undefined && inFlight.size > 0);
      currentHostInstance = frame.hostInstance;
      if (restarted && inFlight.size > 0) {
        rejectAllPending(createBridgeRestartError());
      }
      return;
    }

    if (frame.kind !== 'response' && frame.kind !== 'failure') {
      options.onDroppedFrame?.('invalid-frame');
      return;
    }

    if (frame.hostInstance !== undefined) {
      currentHostInstance = frame.hostInstance;
    }

    const pending = inFlight.get(frame.id);
    if (!pending) {
      options.onDroppedFrame?.('unknown-id');
      return;
    }
    inFlight.delete(frame.id);
    pending.cleanup();

    if (frame.kind === 'failure') {
      pending.reject(new BridgeFailureError(frame.code, frame.message));
      return;
    }
    // The call has left `inFlight`: it settles here, or nothing settles it.
    let response: Response;
    try {
      response = buildResponseFromFrame(frame);
    } catch (error) {
      pending.reject(error);
      return;
    }
    pending.resolve(response);
  });

  return Object.assign(
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (closed) throw createBridgeClosedError('Bridge fetch is closed');
      const id = nextId();
      const { serialized, signal } = await prepareRequestFrame(
        id,
        input,
        init,
        options.secret,
        maxFrameBytes,
        closeController.signal,
      );
      if (closed) throw createBridgeClosedError('Bridge fetch is closed');

      return new Promise<Response>((resolve, reject) => {
        const activeSignal = signal;
        const onAbort = (): void => {
          if (!activeSignal || !inFlight.delete(id)) return;
          const reason = abortReason(activeSignal);
          const payload = serializeAbortFrame(
            id,
            abortReasonText(reason),
            options.secret,
            maxFrameBytes,
          );
          try {
            target.postMessage(payload);
          } catch {
            // The port may already be torn down; the caller still receives AbortError.
          }
          reject(reason);
        };

        const cleanup = (): void => {
          activeSignal?.removeEventListener('abort', onAbort);
        };

        if (activeSignal?.aborted) {
          reject(abortReason(activeSignal));
          return;
        }
        activeSignal?.addEventListener('abort', onAbort, { once: true });
        inFlight.set(id, { resolve, reject, cleanup });

        try {
          target.postMessage(serialized);
        } catch (error) {
          inFlight.delete(id);
          cleanup();
          reject(error);
        }
      });
    },
    {
      close(): void {
        if (closed) return;
        closed = true;
        const closeError = createBridgeClosedError('Bridge fetch closed');
        closeController.abort(closeError);
        try {
          unsubscribe();
        } finally {
          rejectAllPending(closeError);
        }
      },
    },
  );
}
