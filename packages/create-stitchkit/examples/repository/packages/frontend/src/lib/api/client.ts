import { repositoryContract } from '@app/shared';
import { createClient, createHttpClient, createUrlBuilder } from 'stitchkit';

/**
 * The browser's API client — a module CONSTANT, because it needs no address.
 *
 * `/api` is complete when no machine exists: it names a path on whatever origin
 * served the page. That is the whole reason this file has no factory, no lazy
 * accessor and no parentheses at its call sites — see `queries.ts`. The web
 * role forwards these requests to the API role (`app/api/[...path]/route.ts`).
 *
 * A browser that genuinely must reach a DIFFERENT origin cannot do this, and
 * pays a real price for it. That variant lives in `cross-origin.ts`, named and
 * explained, rather than in the default path everybody copies.
 */
const browserHttp = createHttpClient({ baseUrl: '/api', credentials: 'same-origin' });

export const repositoryApi = createClient(repositoryContract, browserHttp);
export const repositoryUrls = createUrlBuilder(repositoryContract, browserHttp);

/** The server-side client needs an address, and reads it from the place. */
export function createRepositoryApi(baseUrl: string) {
  const http = createHttpClient({ baseUrl: `${baseUrl}/api`, credentials: 'omit' });
  return createClient(repositoryContract, http);
}
