import { headers } from 'next/headers';
import { env } from '@/env';

/**
 * The public origin this response is being served on.
 *
 * Derived from the REQUEST, never from the build. An absolute address read at
 * build time is frozen into the artifact — `robots.txt` and `sitemap.xml` were
 * prerendered with one origin inside their bytes, so a single build could not
 * serve a second address. Reading the request instead makes one artifact
 * correct at every address it is ever routed to.
 *
 * **The request is not trusted on its own.** `x-forwarded-host` is set by
 * whoever is in front of this process, and a request that reaches the role
 * directly can set it too. An unchecked value would put an attacker's host into
 * canonical URLs, the sitemap and OG metadata — the artifact would be portable
 * and also forgeable. So a forwarded host is honoured only when the deployment
 * has said which hosts it serves, and `PUBLIC_WEB_ORIGIN` remains the way to
 * state a single one.
 *
 * Both are read at RUNTIME (no `NEXT_PUBLIC_` prefix, so nothing is substituted
 * at build time).
 */
export async function requestOrigin(): Promise<string> {
  const configured = env.PUBLIC_WEB_ORIGIN;
  if (configured) return new URL(configured).origin;

  const incoming = await headers();
  const host = firstValue(incoming.get('x-forwarded-host') ?? incoming.get('host'));
  if (!host) {
    throw new Error(
      'Cannot determine the public origin: the request carried no Host header. Set PUBLIC_WEB_ORIGIN.',
    );
  }
  if (!isAllowedHost(host)) {
    throw new Error(
      `Refusing to answer for host "${host}": it is not in PUBLIC_WEB_HOSTS. Set PUBLIC_WEB_ORIGIN for a single address, or PUBLIC_WEB_HOSTS for several.`,
    );
  }
  return new URL(`${protocolOf(incoming.get('x-forwarded-proto'))}://${host}`).origin;
}

/**
 * Which hosts this deployment serves.
 *
 * Empty means "only what `PUBLIC_WEB_ORIGIN` says", and since that short-circuits
 * above, an empty list with no origin set is a deployment that has not been told
 * where it lives — which is an error, not a licence to believe the caller.
 *
 * There is deliberately no wildcard: serving any host is the same as having no
 * canonical origin, and every answer this module gives is a canonical origin.
 */
function isAllowedHost(host: string): boolean {
  const allowed = env.PUBLIC_WEB_HOSTS?.split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  if (!allowed || allowed.length === 0) return false;
  // No wildcard. `*` read as "serve any host" — which is the same as having no
  // canonical origin at all, and therefore no meaningful answer to give for a
  // canonical URL, a sitemap or an OG card. A deployment that genuinely serves
  // many addresses lists them; one that does not know which it serves has a
  // configuration problem, not a licence to believe the caller.
  return allowed.includes(host.toLowerCase());
}

/**
 * The scheme this response is being served over.
 *
 * Only two are possible, and anything else is a misconfigured proxy or a
 * forgery — both of which must be seen, not normalised. Mapping every unknown
 * value to `http` meant `ftp`, `javascript` and a truncated header all produced
 * a plausible-looking origin, and the answer went into canonical URLs.
 *
 * A missing header is not a failure: a deployment reached directly has no
 * forwarding layer, and `http` is then the truth.
 */
function protocolOf(header: string | null): 'http' | 'https' {
  const forwarded = firstValue(header)?.toLowerCase();
  if (forwarded === undefined) return 'http';
  if (forwarded === 'http' || forwarded === 'https') return forwarded;
  throw new Error(
    `Refusing to answer for forwarded protocol "${forwarded}": x-forwarded-proto must be http or https. Fix the proxy, or set PUBLIC_WEB_ORIGIN to state the public origin outright.`,
  );
}

/** A forwarded header may carry the whole proxy chain — the first hop is ours. */
function firstValue(header: string | null): string | undefined {
  return header?.split(',')[0]?.trim() || undefined;
}
