import { env } from '@/env';

/**
 * The addresses this example reads from the place.
 *
 * `INTERNAL_API_URL` is REQUIRED — see `packages/config/src/features.ts` — and
 * the declaration a deployment reads says so, because the web role dereferences
 * it on every proxied request and on every server render.
 *
 * The two public ones are optional and independent, because the questions they
 * answer are independent: HTTP can be forwarded by the web role, and a
 * WebSocket upgrade cannot. A deployment behind one routing layer sets neither.
 */
export function internalApiUrl(): string {
  return env.INTERNAL_API_URL;
}

/** Where the browser dials the API role over HTTP — the cross-origin variant. */
export function publicApiOrigin(): string | undefined {
  return env.PUBLIC_API_ORIGIN;
}

/** Where the browser opens the realtime socket, when it is not this origin. */
export function publicRealtimeOrigin(): string | undefined {
  return env.PUBLIC_REALTIME_ORIGIN;
}
