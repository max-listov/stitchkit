import { concatChunks, readBoundedChunks, readBoundedText } from '../internal/bounded-body';
import { isRecord } from '../internal/typed';
import { AgentProviderError, type AgentProviderFailureReason } from './provider-failure';

export const DEFAULT_MAX_ERROR_BODY_BYTES = 64 * 1024;
export const DEFAULT_MAX_JSON_BODY_BYTES = 16 * 1024 * 1024;
const MAX_ERROR_MESSAGE_CHARS = 1024;

const REDACTED_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'x-provider-api-keys',
  'cookie',
  'set-cookie',
]);

const bodyAbortCleanup = new WeakMap<ReadableStream<Uint8Array>, () => void>();

/** Remove the pre-iteration abort guard once a stream consumer acquires the reader. */
export function detachProviderBodyAbortGuard(body: ReadableStream<Uint8Array>): void {
  const cleanup = bodyAbortCleanup.get(body);
  if (cleanup) {
    cleanup();
    bodyAbortCleanup.delete(body);
  }
}

/** Truncate a UTF-16 string without splitting a surrogate pair on the boundary. */
export function truncateSurrogateSafe(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 0) return '';
  let end = maxChars;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

function stripControlChars(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const isDisallowed =
      code <= 0x08 ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f) ||
      code === 0x7f;
    out += isDisallowed ? ' ' : raw[i];
  }
  return out;
}

/**
 * Redact bearer tokens, API keys, URL query strings/credentials, and control
 * characters before storing or returning provider error text (I12/I13).
 */
export function redactProviderFailureText(
  raw: string,
  maxChars = MAX_ERROR_MESSAGE_CHARS,
): string {
  const cleaned = stripControlChars(raw)
    // Redact Bearer/Basic authorization values
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/giu, '$1 [REDACTED]')
    // Redact common API key prefixes (sk-*, sk-ant-*, sk-or-*)
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, '[REDACTED_KEY]')
    // Redact key/token/secret assignments
    .replace(
      /\b(api[_-]?key|access[_-]?token|auth[_-]?token|authorization|secret)\s*[:=]\s*["']?[^\s"',}]+/giu,
      '$1=[REDACTED]',
    )
    // Strip credentials, query strings, and fragments from URLs
    .replace(
      /(https?:\/\/)([^/\s@]+@)?([^\s/?#]+)([^\s]*)/giu,
      (_m, proto: string, _creds, host: string, rest: string) => {
        const pathOnly = rest.split(/[?#]/u)[0] ?? '';
        return `${proto}${host}${pathOnly}`;
      },
    )
    .trim();
  return truncateSurrogateSafe(cleaned, maxChars);
}

/** Parse `retry-after-ms` or standard `Retry-After` (delta-seconds or HTTP-date) into ms. */
export function parseRetryAfterMs(headers: Headers, nowMs = Date.now()): number | undefined {
  const rawMs = headers.get('retry-after-ms')?.trim();
  if (rawMs !== undefined && /^\d+(?:\.\d+)?$/u.test(rawMs)) {
    const parsed = Number(rawMs);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.ceil(parsed);
  }
  const raw = headers.get('retry-after')?.trim();
  if (!raw) return undefined;
  if (/^\d+(?:\.\d+)?$/u.test(raw)) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  }
  const timestamp = Date.parse(raw);
  if (!Number.isNaN(timestamp)) {
    return Math.max(0, timestamp - nowMs);
  }
  return undefined;
}

/** Convert `Headers` into a plain lowercase record while dropping sensitive authorization headers. */
export function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (REDACTED_HEADERS.has(lower)) return;
    record[lower] = value;
  });
  return record;
}

/** Join a validated HTTP(S) base URL with a fixed endpoint suffix while preserving query parameters. */
export function joinProviderUrl(baseUrl: string, suffix: string): string {
  if (!URL.canParse(baseUrl)) {
    throw new TypeError(`Invalid provider baseUrl "${baseUrl}"`);
  }
  const url = new URL(baseUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError(
      `Provider baseUrl must use http: or https: protocol (received "${url.protocol}")`,
    );
  }
  const normalizedSuffix = suffix.startsWith('/') ? suffix : `/${suffix}`;
  const trimmedPath = url.pathname.replace(/\/+$/u, '');
  url.pathname = trimmedPath.endsWith(normalizedSuffix)
    ? trimmedPath
    : `${trimmedPath}${normalizedSuffix}`;
  return url.toString();
}

/** Fail fast when `extraBody` tries to overwrite keys owned by the driver's policy or protocol. */
export function assertNoExtraBodyClash(
  providerName: string,
  extraBody: Readonly<Record<string, unknown>> | undefined,
  ownedKeys: readonly string[],
): void {
  if (!extraBody) return;
  const clash = ownedKeys.filter((key) => extraBody[key] !== undefined);
  if (clash.length > 0) {
    throw new TypeError(
      `${providerName}: extraBody sets ${clash.join(', ')}, which the request policy or protocol owns`,
    );
  }
}

export interface ParsedProviderError {
  readonly message: string;
  readonly code?: string | number;
  readonly errorType?: string;
  readonly failureReason?: AgentProviderFailureReason;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type ProviderStreamResponse =
  | {
      readonly kind: 'sse';
      readonly body: ReadableStream<Uint8Array>;
      readonly headers: Headers;
    }
  | { readonly kind: 'json'; readonly json: unknown; readonly headers: Headers };

/** Static API key string or per-call sync/async resolver for rotating credentials. */
export type ProviderApiKey = string | (() => string | Promise<string>);

/** Resolve a static or dynamic provider API key freshly per stream call. */
export async function resolveProviderApiKey(apiKey: ProviderApiKey): Promise<string> {
  const resolved = typeof apiKey === 'function' ? await apiKey() : apiKey;
  const trimmed = typeof resolved === 'string' ? resolved.trim() : '';
  if (trimmed.length === 0) {
    throw new TypeError('Provider apiKey must resolve to a non-empty string');
  }
  return trimmed;
}

/** Parse a server-reported HTTP `Date` response header into a `Date`, when valid. */
export function parseHttpDateHeader(headers: Headers): Date | undefined {
  const raw = headers.get('date')?.trim();
  if (!raw) return undefined;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed) : undefined;
}

export interface PostProviderStreamInput {
  readonly provider: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly extraHeaders?: Readonly<Record<string, string>>;
  readonly requestHeaders?: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly signal: AbortSignal;
  readonly fetcher?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly parseError: (
    payload: unknown,
    rawText: string,
    status: number,
  ) => ParsedProviderError;
  readonly maxErrorBytes?: number;
  readonly maxJsonBytes?: number;
}

async function readErrorBodyPrefix(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ readonly text: string; readonly truncated: boolean }> {
  signal.throwIfAborted();
  const body = response.body;
  if (body === null) return { text: '', truncated: false };
  if (body === undefined || typeof TextDecoder !== 'function') {
    const res = await readBoundedText(response, { maxBytes, signal });
    if (res.kind === 'complete') return { text: res.text, truncated: false };
    return { text: '', truncated: true };
  }
  const kept: Uint8Array[] = [];
  let keptBytes = 0;
  const result = await readBoundedChunks(body, {
    maxBytes,
    signal,
    onChunk(chunk) {
      if (keptBytes >= maxBytes) return;
      const remaining = maxBytes - keptBytes;
      const slice = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
      kept.push(slice);
      keptBytes += slice.byteLength;
    },
  });
  const text = keptBytes === 0 ? '' : new TextDecoder().decode(concatChunks(kept, keptBytes));
  return { text, truncated: result.kind === 'over-limit' };
}

/**
 * Issue one streaming POST request to a model provider with strict security and memory bounds:
 * - `redirect: 'error'` so API keys are never forwarded across origins,
 * - case-insensitive `Headers` assembly without duplicate Authorization headers,
 * - bounded error-body prefix preservation and JSON-body reading (I10, Web Fetch-clean),
 * - automatic `Retry-After` / `x-request-id` extraction, secret redaction, and abort body cleanup.
 */
export async function postProviderStream(
  input: PostProviderStreamInput,
): Promise<ProviderStreamResponse> {
  const headers = new Headers();
  headers.set('content-type', 'application/json');
  headers.set('accept', 'text/event-stream');
  for (const [k, v] of Object.entries(input.headers)) headers.set(k, v);
  if (input.extraHeaders) {
    for (const [k, v] of Object.entries(input.extraHeaders)) headers.set(k, v);
  }
  if (input.requestHeaders) {
    for (const [k, v] of Object.entries(input.requestHeaders)) {
      if (k.toLowerCase() === 'content-type') continue;
      headers.set(k, v);
    }
  }

  const fetcher = input.fetcher ?? fetch;
  const response = await fetcher(input.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(input.body),
    redirect: 'error',
    signal: input.signal,
  });

  if (input.signal.aborted) {
    await response.body?.cancel(input.signal.reason).catch(() => undefined);
    input.signal.throwIfAborted();
  }

  const requestId =
    response.headers.get('x-request-id') ?? response.headers.get('request-id') ?? undefined;
  const retryAfterMs = parseRetryAfterMs(response.headers);
  const responseHeaders = headersToRecord(response.headers);

  if (!response.ok) {
    const maxErrorBytes = input.maxErrorBytes ?? DEFAULT_MAX_ERROR_BODY_BYTES;
    const prefix = await readErrorBodyPrefix(response, maxErrorBytes, input.signal);
    const truncationNote = prefix.truncated ? ` [truncated after ${maxErrorBytes} bytes]` : '';
    const rawText = prefix.truncated ? `${prefix.text}${truncationNote}` : prefix.text;
    let parsed: unknown;
    if (!prefix.truncated && prefix.text.length > 0) {
      try {
        parsed = JSON.parse(prefix.text);
      } catch {
        parsed = undefined;
      }
    }
    const details = input.parseError(parsed, rawText, response.status);
    const redactedMessage = redactProviderFailureText(
      details.message || `${input.provider} HTTP ${response.status}`,
    );
    const redactedBody =
      rawText.length > 0
        ? prefix.truncated
          ? `${redactProviderFailureText(prefix.text, Math.max(64, 4096 - truncationNote.length))}${truncationNote}`
          : redactProviderFailureText(rawText, 4096)
        : undefined;
    throw new AgentProviderError(redactedMessage, {
      provider: input.provider,
      statusCode: response.status,
      ...(details.code !== undefined && { code: details.code }),
      ...(details.errorType !== undefined && { errorType: details.errorType }),
      ...(details.failureReason !== undefined && { failureReason: details.failureReason }),
      ...(details.metadata !== undefined && { metadata: details.metadata }),
      ...(requestId !== undefined && { requestId }),
      ...(retryAfterMs !== undefined && { retryAfterMs }),
      responseHeaders,
      ...(redactedBody !== undefined && { responseBody: redactedBody }),
    });
  }

  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType.includes('application/json')) {
    const maxJsonBytes = input.maxJsonBytes ?? DEFAULT_MAX_JSON_BODY_BYTES;
    const jsonText = await readBoundedText(response, {
      maxBytes: maxJsonBytes,
      signal: input.signal,
      checkContentLength: true,
    });
    if (jsonText.kind === 'over-limit') {
      throw new AgentProviderError(
        `${input.provider} JSON response exceeded ${maxJsonBytes} byte limit`,
        {
          provider: input.provider,
          statusCode: response.status,
          ...(requestId !== undefined && { requestId }),
          responseHeaders,
        },
      );
    }
    try {
      return { kind: 'json', json: JSON.parse(jsonText.text), headers: response.headers };
    } catch (error) {
      throw new AgentProviderError(`${input.provider} returned invalid JSON body`, {
        provider: input.provider,
        statusCode: response.status,
        ...(requestId !== undefined && { requestId }),
        responseHeaders,
        cause: error,
      });
    }
  }

  if (
    contentType.length > 0 &&
    !contentType.includes('text/event-stream') &&
    !contentType.includes('application/octet-stream')
  ) {
    const preview = await readBoundedText(response, {
      maxBytes: 4096,
      signal: input.signal,
    }).catch(() => ({ kind: 'complete' as const, text: '' }));
    if (input.signal.aborted) input.signal.throwIfAborted();
    const snippet =
      preview.kind === 'complete' && preview.text.length > 0
        ? `: ${redactProviderFailureText(preview.text, 256)}`
        : '';
    throw new AgentProviderError(
      `${input.provider} returned unexpected content-type "${contentType}"${snippet}`,
      {
        provider: input.provider,
        statusCode: response.status,
        ...(requestId !== undefined && { requestId }),
        responseHeaders,
      },
    );
  }

  if (!response.body) {
    throw new AgentProviderError(`${input.provider} returned an empty response body`, {
      provider: input.provider,
      statusCode: response.status,
      ...(requestId !== undefined && { requestId }),
      responseHeaders,
    });
  }

  const sseBody = response.body;
  if (input.signal.aborted) {
    await sseBody.cancel(input.signal.reason).catch(() => undefined);
    input.signal.throwIfAborted();
  }
  const onPreReadAbort = (): void => {
    bodyAbortCleanup.delete(sseBody);
    if (!sseBody.locked) {
      void sseBody.cancel(input.signal.reason).catch(() => undefined);
    }
  };
  input.signal.addEventListener('abort', onPreReadAbort, { once: true });
  bodyAbortCleanup.set(sseBody, () => {
    input.signal.removeEventListener('abort', onPreReadAbort);
  });

  return { kind: 'sse', body: sseBody, headers: response.headers };
}

/** Narrow helper to read an optional string field from an untyped error payload. */
export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Narrow helper to read a nested record cleanly without casts. */
export function recordField(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const nested = value[key];
  return isRecord(nested) ? nested : undefined;
}
