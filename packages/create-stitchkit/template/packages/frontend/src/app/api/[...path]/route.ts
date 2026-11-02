import { env } from '@/env';
import { forwardToApi } from '@/lib/api-proxy';

/**
 * The default shape: the browser talks to its OWN origin, and the web role
 * forwards `/api/…` to the API role.
 *
 * This is what makes the board's client a plain module constant. A browser
 * that dials the API role directly needs that role's public address, which is a
 * property of the place — so the address has to arrive from the server at
 * runtime, the client cannot exist until it does, and every call site pays for
 * that with a lazy accessor. A same-origin request needs no address at all:
 * `/api/…` is complete before any machine exists.
 *
 * What it costs: one extra hop through the web role, and no WebSocket — a
 * route handler cannot proxy an upgrade. The realtime socket is therefore the
 * one place the browser still needs the API role's address
 * (`PUBLIC_REALTIME_ORIGIN`), or a routing layer in front of both roles that
 * serves them on one origin.
 */
export const dynamic = 'force-dynamic';

async function forward(request: Request): Promise<Response> {
  const apiUrl = env.INTERNAL_API_URL;
  if (!apiUrl) {
    // Said here, in words, rather than as a 404 from a route that is not there.
    return Response.json(
      { error: 'INTERNAL_API_URL is not set, so the web role cannot reach the API role' },
      { status: 503 },
    );
  }
  return await forwardToApi(request, apiUrl);
}

export const GET = forward;
export const POST = forward;
export const PUT = forward;
export const PATCH = forward;
export const DELETE = forward;
