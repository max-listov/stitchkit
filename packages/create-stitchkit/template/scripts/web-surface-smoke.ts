const OG_IMAGE_PATH = '/api/og/en/themes';
const SITEMAP_PATH = '/sitemap.xml';

function publicUrl(origin: string, path: string): URL {
  return new URL(path, new URL(origin).origin);
}

export async function assertPublicWebSurface(webOrigin: string): Promise<void> {
  const image = await fetch(publicUrl(webOrigin, OG_IMAGE_PATH));
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

  const sitemap = await fetch(publicUrl(webOrigin, SITEMAP_PATH));
  if (sitemap.status !== 200) {
    throw new Error(`GET ${SITEMAP_PATH} returned ${sitemap.status}`);
  }
  if (!(await sitemap.text()).includes('/ru/ui/themes')) {
    throw new Error(`GET ${SITEMAP_PATH} omitted the localized theme-system URL`);
  }
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
export async function assertArtifactIsPlacementFree(webOrigin: string): Promise<void> {
  const addresses = [
    { host: 'alpha.example', proto: 'https' },
    { host: 'beta.example:8443', proto: 'http' },
  ];

  for (const { host, proto } of addresses) {
    const expected = `${proto}://${host}`;
    const headers = { 'x-forwarded-host': host, 'x-forwarded-proto': proto };

    const sitemap = await fetch(publicUrl(webOrigin, SITEMAP_PATH), { headers });
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

    const robots = await fetch(publicUrl(webOrigin, '/robots.txt'), { headers });
    if (!(await robots.text()).includes(`Sitemap: ${expected}/sitemap.xml`)) {
      throw new Error(`GET /robots.txt as ${expected} did not answer with that address`);
    }
  }

  // Portable is not the same as forgeable. A host the deployment never claimed
  // must be refused, or the same mechanism that lets one artifact serve many
  // addresses lets a caller choose the canonical URL, the sitemap and the OG
  // metadata for everyone else.
  const forged = await fetch(publicUrl(webOrigin, SITEMAP_PATH), {
    headers: { 'x-forwarded-host': 'attacker.example', 'x-forwarded-proto': 'https' },
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
  for (const proto of ['ftp', 'javascript', 'HTTPS://', '']) {
    const answered = await fetch(publicUrl(webOrigin, SITEMAP_PATH), {
      headers: { 'x-forwarded-host': 'alpha.example', 'x-forwarded-proto': proto },
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
