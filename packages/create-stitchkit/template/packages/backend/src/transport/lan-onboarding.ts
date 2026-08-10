import { env } from '@app/config';
import type { RawRoute } from 'stitchkit/server';

export function createLanOnboardingRoutes(): RawRoute[] {
  if (env.NODE_ENV !== 'development' || !env.DEV_HTTPS_CA) return [];
  const caPath = env.DEV_HTTPS_CA;
  return [
    {
      method: 'GET',
      path: '/__dev/lan-ca',
      handler: () =>
        new Response(Bun.file(caPath), {
          headers: {
            'Content-Disposition': 'attachment; filename="stitchkit-lan-root-ca.pem"',
            'Content-Type': 'application/x-pem-file',
          },
        }),
    },
    {
      method: 'GET',
      path: '/__dev/lan',
      handler: () =>
        new Response(
          `<!doctype html><meta name="viewport" content="width=device-width"><title>LAN HTTPS setup</title><main><h1>Trust this development CA</h1><p><a href="/__dev/lan-ca">Download the public root certificate</a>.</p><h2>iOS</h2><p>Install the downloaded profile, then enable full trust in Settings → General → About → Certificate Trust Settings.</p><h2>Android</h2><p>Install it as a CA certificate. Native development builds must explicitly allow user-installed roots.</p><p>No private key is exposed by this server.</p></main>`,
          { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
        ),
    },
  ];
}
