import { z } from 'zod';

export const featureServerSchema = {
  // The web role dereferences this on every proxied request and on every server
  // render, so it TIGHTENS from optional to required. Declared optional, a
  // deployment reading project.json would supply nothing and every request would
  // throw — the declaration would be derived and still wrong, which is the one
  // failure the derivation exists to prevent.
  INTERNAL_API_URL: z.url(),
  // Deliberately NOT tightened. The browser talks to its own origin by default
  // (`frontend/src/lib/api/client.ts`), so a single-origin deployment supplies
  // none of these. They are the price of a browser that leaves that origin, and
  // only a deployment that has that case should be made to pay it.
  //   PUBLIC_REALTIME_ORIGIN — where the socket connects, when no routing layer
  //     forwards `/socket.io`. A WebSocket upgrade cannot be proxied by the
  //     route handler that forwards `/api`, so this one is separate on purpose.
  //   PUBLIC_API_ORIGIN — where the browser dials the API role over HTTP, for
  //     the cross-origin variant. Inert until the import in `queries.ts` moves.
  //   CORS_ORIGIN — the API role's allow-list, needed once the browser is
  //     genuinely cross-origin for either of the two.
  GITHUB_API_URL: z.url().default('https://api.github.com'),
  GITHUB_REPOSITORY: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  GITHUB_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  GITHUB_TOKEN: z.string().min(1).optional(),
};
