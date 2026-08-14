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
