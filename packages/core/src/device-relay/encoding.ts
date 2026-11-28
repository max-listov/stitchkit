import { base64ToBytes, bytesToBase64 } from '../internal/base64';
import { utf8ByteLength } from '../internal/bounded-body';
import {
  DEVICE_RELAY_ORIGIN,
  type DeviceRelayBodyEncoding,
  DeviceRelayError,
  type DeviceRelayHeaderEntry,
  type DeviceRelayRpcRequest,
  type DeviceRelayRpcResponse,
} from './contract';

const STRIPPED_REQUEST_HEADERS = new Set([
  'host',
  'origin',
  'x-forwarded-for',
  'x-real-ip',
  'forwarded',
  'connection',
  'transfer-encoding',
]);

// biome-ignore lint/suspicious/noControlCharactersInRegex: explicitly refusing ASCII control bytes in untrusted relay paths
const FORBIDDEN_RELAY_PATH_RE = /\\|\.\.|%2e|%2f|%5c|%00|[\u0000-\u001f\u007f]/i;

function decodeRelayBase64(encoded: string): Uint8Array<ArrayBuffer> {
  try {
    return base64ToBytes(encoded);
  } catch (cause) {
    throw new DeviceRelayError(
      'INVALID_REQUEST',
      cause instanceof Error ? cause.message : 'Invalid base64 payload',
      { cause },
    );
  }
}

export function normalizeRelayHeaders(
  input: HeadersInit | undefined,
  stripTrustHeaders: boolean,
): DeviceRelayHeaderEntry[] {
  if (!input) return [];
  const entries: DeviceRelayHeaderEntry[] = [];
  const push = (key: string, value: string): void => {
    if (stripTrustHeaders && STRIPPED_REQUEST_HEADERS.has(key.toLowerCase())) return;
    entries.push([key, value]);
  };
  if (input instanceof Headers) {
    input.forEach((value, key) => {
      push(key, value);
    });
    return entries;
  }
  if (Array.isArray(input)) {
    for (const pair of input) {
      if (pair.length === 2) push(String(pair[0]), String(pair[1]));
    }
    return entries;
  }
  for (const [key, value] of Object.entries(input)) {
    push(key, value);
  }
  return entries;
}

export interface CanonicalRelayPath {
  readonly pathname: string;
  readonly search: string;
  readonly path: string;
}

/**
 * Canonicalize an untrusted relay path once against `DEVICE_RELAY_ORIGIN`.
 * Refuses foreign origins, credentials, protocol-relative prefixes, backslashes,
 * dot-dot traversal and percent-encoded traversal delimiters both before and after
 * WHATWG URL canonicalization.
 */
export function canonicalizeRelayPath(
  input: string | URL,
  options: { readonly allowOrigin?: boolean } = {},
): CanonicalRelayPath {
  const raw = typeof input === 'string' ? input : input.toString();
  const allowOrigin = options.allowOrigin ?? false;
  let rawRelative = raw;
  if (allowOrigin) {
    if (raw.toLowerCase().startsWith(DEVICE_RELAY_ORIGIN)) {
      const rest = raw.slice(DEVICE_RELAY_ORIGIN.length);
      if (
        rest === '' ||
        rest.startsWith('/') ||
        rest.startsWith('?') ||
        rest.startsWith('#')
      ) {
        rawRelative = rest === '' ? '/' : rest;
      }
    }
  } else if (!raw.startsWith('/') || raw.startsWith('//')) {
    throw new DeviceRelayError('INVALID_REQUEST', `Invalid relay path: ${raw}`);
  }

  const rawPathPart = rawRelative.split(/[?#]/, 1)[0] ?? '';
  if (FORBIDDEN_RELAY_PATH_RE.test(rawPathPart)) {
    throw new DeviceRelayError('INVALID_REQUEST', `Forbidden relay path: ${raw}`);
  }

  let parsed: URL;
  try {
    parsed = new URL(raw, DEVICE_RELAY_ORIGIN);
  } catch (cause) {
    throw new DeviceRelayError('INVALID_REQUEST', `Invalid relay path: ${raw}`, { cause });
  }
  if (
    parsed.origin !== DEVICE_RELAY_ORIGIN ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    throw new DeviceRelayError(
      'INVALID_REQUEST',
      `Relay path must stay on relay origin: ${raw}`,
    );
  }
  if (
    !parsed.pathname.startsWith('/') ||
    parsed.pathname.startsWith('//') ||
    FORBIDDEN_RELAY_PATH_RE.test(parsed.pathname)
  ) {
    throw new DeviceRelayError('INVALID_REQUEST', `Invalid relay path: ${raw}`);
  }
  return {
    pathname: parsed.pathname,
    search: parsed.search,
    path: `${parsed.pathname}${parsed.search}`,
  };
}

export function normalizeRelativeRelayPath(input: string | URL): string {
  return canonicalizeRelayPath(input, { allowOrigin: true }).path;
}

async function readStreamBytesBounded(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  label: string,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new DeviceRelayError(
          'PAYLOAD_TOO_LARGE',
          `${label} exceeds the ${maxBytes}-byte limit`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

export async function encodeFetchRequestBody(
  input: string | URL | Request,
  init: RequestInit | undefined,
  method: string,
  maxRequestBodyBytes: number,
): Promise<{ body?: string; bodyEncoding?: DeviceRelayBodyEncoding }> {
  if (method === 'GET' || method === 'HEAD') return {};
  const rawBody = init?.body;
  if (rawBody === undefined || rawBody === null) {
    if (!(input instanceof Request) || !input.body) return {};
    const bytes = await readStreamBytesBounded(
      input.body,
      maxRequestBodyBytes,
      'Relay request body',
    );
    if (bytes.byteLength === 0) return {};
    return { body: bytesToBase64(bytes), bodyEncoding: 'base64' };
  }
  if (typeof rawBody === 'string') {
    if (utf8ByteLength(rawBody) > maxRequestBodyBytes) {
      throw new DeviceRelayError(
        'PAYLOAD_TOO_LARGE',
        `Relay request body exceeds the ${maxRequestBodyBytes}-byte limit`,
      );
    }
    return { body: rawBody, bodyEncoding: 'utf8' };
  }
  if (rawBody instanceof URLSearchParams) {
    const text = rawBody.toString();
    if (utf8ByteLength(text) > maxRequestBodyBytes) {
      throw new DeviceRelayError(
        'PAYLOAD_TOO_LARGE',
        `Relay request body exceeds the ${maxRequestBodyBytes}-byte limit`,
      );
    }
    return { body: text, bodyEncoding: 'utf8' };
  }
  if (rawBody instanceof ArrayBuffer || ArrayBuffer.isView(rawBody)) {
    const bytes =
      rawBody instanceof ArrayBuffer
        ? new Uint8Array(rawBody)
        : new Uint8Array(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength);
    if (bytes.byteLength > maxRequestBodyBytes) {
      throw new DeviceRelayError(
        'PAYLOAD_TOO_LARGE',
        `Relay request body exceeds the ${maxRequestBodyBytes}-byte limit`,
      );
    }
    return { body: bytesToBase64(bytes), bodyEncoding: 'base64' };
  }
  if (rawBody instanceof Blob) {
    if (rawBody.size > maxRequestBodyBytes) {
      throw new DeviceRelayError(
        'PAYLOAD_TOO_LARGE',
        `Relay request body exceeds the ${maxRequestBodyBytes}-byte limit`,
      );
    }
    const bytes = new Uint8Array(await rawBody.arrayBuffer());
    return { body: bytesToBase64(bytes), bodyEncoding: 'base64' };
  }
  if (rawBody instanceof ReadableStream) {
    const bytes = await readStreamBytesBounded(
      rawBody,
      maxRequestBodyBytes,
      'Relay request body',
    );
    return { body: bytesToBase64(bytes), bodyEncoding: 'base64' };
  }
  throw new DeviceRelayError('INVALID_REQUEST', 'Unsupported relay request body type');
}

export function decodedBodyByteLength(
  body: string | undefined,
  encoding: DeviceRelayBodyEncoding | undefined,
): number {
  if (body === undefined) return 0;
  if (encoding === 'base64') return decodeRelayBase64(body).byteLength;
  return utf8ByteLength(body);
}

export async function encodeFetchResponse(
  requestId: string,
  response: Response,
  maxResponseBodyBytes: number,
): Promise<Extract<DeviceRelayRpcResponse, { outcome: 'response' }>> {
  const nullBody =
    response.status === 204 || response.status === 205 || response.status === 304;
  let body: string | undefined;
  let bodyEncoding: DeviceRelayBodyEncoding | undefined;
  if (!nullBody) {
    const contentLengthHeader = response.headers.get('content-length');
    if (contentLengthHeader !== null) {
      const declared = Number(contentLengthHeader);
      if (Number.isFinite(declared) && declared > maxResponseBodyBytes) {
        void response.body?.cancel?.().catch(() => undefined);
        throw new DeviceRelayError(
          'PAYLOAD_TOO_LARGE',
          `Relay response body exceeds the ${maxResponseBodyBytes}-byte limit`,
        );
      }
    }
    const bytes = response.body
      ? await readStreamBytesBounded(
          response.body,
          maxResponseBodyBytes,
          'Relay response body',
        )
      : new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxResponseBodyBytes) {
      throw new DeviceRelayError(
        'PAYLOAD_TOO_LARGE',
        `Relay response body exceeds the ${maxResponseBodyBytes}-byte limit`,
      );
    }
    if (bytes.byteLength > 0) {
      const contentType = response.headers.get('content-type') ?? '';
      const textual =
        contentType === '' ||
        /^text\//i.test(contentType) ||
        /application\/(?:[\w.+-]+\+)?(?:json|xml|javascript|x-www-form-urlencoded)/i.test(
          contentType,
        );
      if (textual) {
        try {
          body = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          bodyEncoding = 'utf8';
        } catch {
          body = bytesToBase64(bytes);
          bodyEncoding = 'base64';
        }
      } else {
        body = bytesToBase64(bytes);
        bodyEncoding = 'base64';
      }
    }
  }
  return {
    schemaVersion: 1,
    requestId,
    outcome: 'response',
    status: response.status,
    statusText: response.statusText,
    headers: normalizeRelayHeaders(response.headers, false),
    ...(body !== undefined && { body }),
    ...(bodyEncoding !== undefined && { bodyEncoding }),
  };
}

export function buildFetchRequestFromRelay(
  request: DeviceRelayRpcRequest,
  signal: AbortSignal,
): Request {
  const canonical = canonicalizeRelayPath(request.path, { allowOrigin: false });
  const headers = new Headers();
  for (const [key, value] of request.headers) {
    if (STRIPPED_REQUEST_HEADERS.has(key.toLowerCase())) continue;
    headers.append(key, value);
  }
  const method = request.method.toUpperCase();
  let body: BodyInit | undefined;
  if (request.body !== undefined && method !== 'GET' && method !== 'HEAD') {
    body = request.bodyEncoding === 'base64' ? decodeRelayBase64(request.body) : request.body;
  }
  return new Request(`${DEVICE_RELAY_ORIGIN}${canonical.path}`, {
    method,
    headers,
    ...(body !== undefined && { body }),
    signal,
  });
}

export function buildFetchResponseFromRelay(
  frame: Extract<DeviceRelayRpcResponse, { outcome: 'response' }>,
): Response {
  const headers = new Headers();
  for (const [key, value] of frame.headers) {
    headers.append(key, value);
  }
  const nullBody = frame.status === 204 || frame.status === 205 || frame.status === 304;
  if (nullBody || frame.body === undefined) {
    return new Response(null, { status: frame.status, statusText: frame.statusText, headers });
  }
  const body: BodyInit =
    frame.bodyEncoding === 'base64' ? decodeRelayBase64(frame.body) : frame.body;
  return new Response(body, { status: frame.status, statusText: frame.statusText, headers });
}
