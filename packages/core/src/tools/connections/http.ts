import { ConnectionUrlError } from './errors';
import { assertAllowedHost, assertConnectionUrl } from './ssrf';

/** Redirects require a new host-owned connection declaration. */
export async function fetchConnection(
  target: URL | string,
  init: RequestInit,
  allowedHosts: ReadonlySet<string>,
  connectionName: string,
): Promise<Response> {
  const url = assertConnectionUrl(target.toString(), connectionName);
  assertAllowedHost(url, allowedHosts, connectionName);
  const response = await fetch(url, { ...init, redirect: 'manual' });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new ConnectionUrlError(
      `Connection "${connectionName}" refused a redirect`,
      url.toString(),
    );
  }
  return response;
}
