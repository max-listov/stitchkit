const OG_IMAGE_PATH = '/api/og/en/themes';
const SITEMAP_PATH = '/sitemap.xml';
const DIAL_TIMEOUT_MS = 30_000;

function publicUrl(origin: string, path: string): URL {
  return new URL(path, new URL(origin).origin);
}

/**
 * Every dial is bounded.
 *
 * A gate that hangs is worse than one that fails: it reports nothing, ever. An
 * endpoint that accepts the connection and never answers used to stop the whole
 * run with no output and no deadline.
 */
function dial(url: URL, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(DIAL_TIMEOUT_MS) });
}

export async function assertPublicWebSurface(webOrigin: string): Promise<void> {
  const image = await dial(publicUrl(webOrigin, OG_IMAGE_PATH));
  if (image.status !== 200) {
    throw new Error(`GET ${OG_IMAGE_PATH} returned ${image.status}`);
  }
  const imageType = image.headers.get('content-type');
  if (!imageType?.toLowerCase().startsWith('image/png')) {
    throw new Error(`GET ${OG_IMAGE_PATH} returned ${imageType ?? 'no content type'}`);
  }
  if ((await image.arrayBuffer()).byteLength === 0) {
    throw new Error(`GET ${OG_IMAGE_PATH} returned an empty image`);
  }

  const sitemap = await dial(publicUrl(webOrigin, SITEMAP_PATH));
  if (sitemap.status !== 200) {
    throw new Error(`GET ${SITEMAP_PATH} returned ${sitemap.status}`);
  }
  if (!(await sitemap.text()).includes('/ru/ui/themes')) {
    throw new Error(`GET ${SITEMAP_PATH} omitted the localized theme-system URL`);
  }
}

/** What the deployment has been told about the addresses it serves. */
export interface PublicHostPolicy {
  /** `PUBLIC_WEB_ORIGIN` — a single public address, stated outright. */
  origin?: string | undefined;
  /** `PUBLIC_WEB_HOSTS` — the comma-separated hosts this deployment claims. */
  hosts?: string | undefined;
}

interface ForwardedAddress {
  host: string;
  proto: 'http' | 'https';
}

export type PortabilityPlan =
  | {
      kind: 'check';
      addresses: readonly [ForwardedAddress, ForwardedAddress];
      forgedHost: string;
    }
  | { kind: 'skip'; reason: string }
  | { kind: 'refuse'; reason: string };

function claimedHosts(hosts: string | undefined): string[] {
  // Deduplicated, because the count is load-bearing: the check needs two
  // DIFFERENT addresses to ask this deployment on, and one host written twice
  // would pass as two and make it compare an address with itself.
  return [
    ...new Set(
      (hosts ?? '')
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0),
    ),
  ];
}

/**
 * Which addresses to ask this deployment on — ITS OWN, not the check's.
 *
 * The check can only dial an address the deployment claims: a forwarded host
 * outside `PUBLIC_WEB_HOSTS` is refused on purpose, and rightly so. Naming two
 * fixture hosts here therefore meant the deployment had to have been told about
 * those exact two names by somebody else — which only the packed lane ever was.
 * Everyone running the same command against their own deployment got a bare
 * 500 from a policy working exactly as designed.
 *
 * So the deployment declares and the check reads, instead of two copies of the
 * same fixture that must agree across two repositories.
 */
export function planPortabilityCheck(
  webOrigin: string,
  policy: PublicHostPolicy,
): PortabilityPlan {
  if (policy.origin) {
    return {
      kind: 'skip',
      reason: `PUBLIC_WEB_ORIGIN pins this deployment to ${policy.origin}, so it answers with that one address whatever it is asked on. Portability by request is observable only where PUBLIC_WEB_HOSTS names the addresses instead.`,
    };
  }

  const claimed = claimedHosts(policy.hosts);
  const dialled = new URL(webOrigin).host.toLowerCase();
  const others = claimed.filter((host) => host !== dialled);
  const [first, second] = others;
  if (!first || !second) {
    const suggestion = [dialled, 'alpha.example', 'beta.example:8443'].join(',');
    return {
      kind: 'refuse',
      reason: `This deployment claims ${claimed.length === 0 ? 'no host at all' : claimed.join(', ')}, which leaves ${others.length} address besides ${dialled} to ask it on. Proving that one artifact serves many needs at least two. Set PUBLIC_WEB_HOSTS=${suggestion} in .env, restart the web role (\`bun run dev\`), then rerun.`,
    };
  }

  // The forged host must be one the deployment never claimed — otherwise the
  // refusal it is supposed to provoke never happens and the check is vacuous.
  let forgedHost = 'attacker.example';
  for (let attempt = 1; claimed.includes(forgedHost); attempt += 1) {
    forgedHost = `attacker-${attempt}.invalid`;
  }

  return {
    kind: 'check',
    // Both protocols on purpose: the answer has to follow the forwarded scheme,
    // not a default the artifact was built with.
    addresses: [
      { host: first, proto: 'https' },
      { host: second, proto: 'http' },
    ],
    forgedHost,
  };
}

/**
 * One artifact, many external addresses.
 *
 * The single check that catches a regression back into a build-time address: if
 * anything is baked in again — a `NEXT_PUBLIC_` variable, a prerendered
 * `sitemap.xml` — the two answers below stop differing, because the build would
 * be answering with the address it was built with instead of the one it was
 * asked on.
 */
export async function assertArtifactIsPlacementFree(
  webOrigin: string,
  policy: PublicHostPolicy,
): Promise<void> {
  const plan = planPortabilityCheck(webOrigin, policy);
  if (plan.kind === 'refuse') throw new Error(plan.reason);
  if (plan.kind === 'skip') {
    // Named, not silent: a gate whose strongest check quietly did not run reads
    // exactly like one that ran and passed.
    console.log(`Placement-free check not run — ${plan.reason}`);
    return;
  }

  for (const { host, proto } of plan.addresses) {
    const expected = `${proto}://${host}`;
    const headers = { 'x-forwarded-host': host, 'x-forwarded-proto': proto };

    const sitemap = await dial(publicUrl(webOrigin, SITEMAP_PATH), { headers });
    if (sitemap.status !== 200) {
      throw new Error(`GET ${SITEMAP_PATH} as ${expected} returned ${sitemap.status}`);
    }
    const body = await sitemap.text();
    if (!body.includes(`${expected}/en`)) {
      throw new Error(`GET ${SITEMAP_PATH} as ${expected} did not answer with that address`);
    }
    if (body.includes(new URL(webOrigin).host)) {
      throw new Error(
        `GET ${SITEMAP_PATH} as ${expected} leaked the address the build was made on — something is baked into the artifact`,
      );
    }

    const robots = await dial(publicUrl(webOrigin, '/robots.txt'), { headers });
    if (!(await robots.text()).includes(`Sitemap: ${expected}/sitemap.xml`)) {
      throw new Error(`GET /robots.txt as ${expected} did not answer with that address`);
    }
  }

  // Portable is not the same as forgeable. A host the deployment never claimed
  // must be refused, or the same mechanism that lets one artifact serve many
  // addresses lets a caller choose the canonical URL, the sitemap and the OG
  // metadata for everyone else.
  const forged = await dial(publicUrl(webOrigin, SITEMAP_PATH), {
    headers: { 'x-forwarded-host': plan.forgedHost, 'x-forwarded-proto': 'https' },
  });
  if (forged.status < 400) {
    throw new Error(
      `GET ${SITEMAP_PATH} answered for an unclaimed host with ${forged.status} — the forwarded host is trusted without a policy`,
    );
  }

  // Same rule, one layer down. A forwarded protocol outside `http | https` is a
  // misconfigured proxy or a forgery, and both have to be visible: mapping
  // every unknown value to `http` produced a plausible canonical origin from
  // `ftp`, `javascript` and a truncated header alike.
  const [claimedAddress] = plan.addresses;
  for (const proto of ['ftp', 'javascript', 'HTTPS://', '']) {
    const answered = await dial(publicUrl(webOrigin, SITEMAP_PATH), {
      headers: { 'x-forwarded-host': claimedAddress.host, 'x-forwarded-proto': proto },
    });
    // An empty header carries no claim at all and is treated as absent.
    const acceptable = proto === '' ? answered.status === 200 : answered.status >= 400;
    if (!acceptable) {
      throw new Error(
        `GET ${SITEMAP_PATH} with x-forwarded-proto "${proto}" returned ${answered.status} — an unknown protocol is normalised instead of refused`,
      );
    }
  }
}
