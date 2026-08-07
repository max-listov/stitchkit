import type { ResponseMetadata } from '../contract';

const RESERVED_HEADERS = new Set(['content-type', 'content-length', 'x-request-id']);

interface HeadersWithSetCookie extends Headers {
  getSetCookie(): string[];
}

function hasGetSetCookie(headers: Headers): headers is HeadersWithSetCookie {
  return 'getSetCookie' in headers && typeof headers.getSetCookie === 'function';
}

function isReservedHeader(name: string): boolean {
  const normalized = name.toLowerCase();
  return RESERVED_HEADERS.has(normalized) || normalized.startsWith('access-control-');
}

/** Create one isolated outbound collector for a response-metadata handler. */
export function createResponseMetadata(): ResponseMetadata {
  return { headers: new Headers() };
}

/**
 * Merge handler-owned metadata only after the complete data pipeline succeeds.
 * Framework-owned framing, CORS and request identity can never be replaced.
 */
export function applyResponseMetadata(
  target: Headers,
  metadata: ResponseMetadata | undefined,
  endpointIdentity: string,
): void {
  if (!metadata) return;

  for (const [name] of metadata.headers) {
    if (isReservedHeader(name)) {
      throw new Error(
        `${endpointIdentity} cannot set framework-owned response header "${name}"`,
      );
    }
  }

  const preservesSetCookie = hasGetSetCookie(metadata.headers);
  for (const [name, value] of metadata.headers) {
    if (name.toLowerCase() === 'set-cookie' && preservesSetCookie) continue;
    target.append(name, value);
  }
  if (preservesSetCookie) {
    for (const cookie of metadata.headers.getSetCookie()) {
      target.append('Set-Cookie', cookie);
    }
  }
}
