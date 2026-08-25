import { createRepositoryApi } from './client';
import { internalApiUrl } from './place';

/**
 * Server-side API client. Separate module on purpose: it reads the SERVER
 * environment, and importing that from a module the browser bundle also pulls
 * in would drag server configuration into the client graph.
 */
export function createServerRepositoryApi() {
  return createRepositoryApi(internalApiUrl());
}
