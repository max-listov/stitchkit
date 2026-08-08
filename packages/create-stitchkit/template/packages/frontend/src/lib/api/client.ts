import { repositoryContract } from '@app/shared';
import { createClient, createHttpClient, createUrlBuilder } from 'stitchkit';
import { env } from '@/env';

function apiOrigin(): string {
  return typeof window === 'undefined' ? env.INTERNAL_API_URL : env.NEXT_PUBLIC_API_URL;
}

export function createRepositoryApi(baseUrl: string) {
  const http = createHttpClient({ baseUrl: `${baseUrl}/api`, credentials: 'omit' });
  return createClient(repositoryContract, http);
}

const http = createHttpClient({ baseUrl: `${apiOrigin()}/api`, credentials: 'omit' });
export const repositoryApi = createRepositoryApi(apiOrigin());
export const repositoryUrls = createUrlBuilder(repositoryContract, http);

export function createServerRepositoryApi() {
  return createRepositoryApi(env.INTERNAL_API_URL);
}
