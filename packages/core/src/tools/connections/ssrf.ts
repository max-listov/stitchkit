import { ConnectionUrlError } from './errors';

/**
 * The SSRF fence for a connection. A connection URL is application
 * configuration, so it is validated once at definition; every outbound request
 * then has to name a host the connection already declared.
 */

/** Parse and require an absolute `http(s)` URL. */
export function assertConnectionUrl(rawUrl: string, connectionName: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ConnectionUrlError(
      `Connection "${connectionName}" has an unparseable URL: ${rawUrl}`,
      rawUrl,
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConnectionUrlError(
      `Connection "${connectionName}" must use http(s), got "${url.protocol}"`,
      rawUrl,
    );
  }
  return url;
}

/**
 * The allowed-host set: the connection URL's own host, plus any explicitly
 * declared extras. A request to a host outside this set never reaches `fetch`.
 */
export function connectionAllowedHosts(
  connectionUrl: URL,
  extra?: readonly string[],
): Set<string> {
  const hosts = new Set<string>([connectionUrl.host.toLowerCase()]);
  for (const host of extra ?? []) hosts.add(host.toLowerCase());
  return hosts;
}

/** Refuse a request whose host is neither the connection host nor an allowed extra. */
export function assertAllowedHost(
  url: URL,
  allowedHosts: ReadonlySet<string>,
  connectionName: string,
): void {
  if (!allowedHosts.has(url.host.toLowerCase())) {
    throw new ConnectionUrlError(
      `Connection "${connectionName}" refused request to host "${url.host}": not the connection host or an allowed host`,
      url.toString(),
    );
  }
}
