import { env } from '@app/config';
import { appIdentity } from '@app/config/identity';
import { wrapInRequestContext } from 'stitchkit/observability';
import { createServer, generateOpenApiDocument, openApiRoute } from 'stitchkit/server';
import { createMcpHandler, createMcpHttpRoute } from 'stitchkit/tools';
import { prisma } from './lib/db';
import { createSurface } from './surface';
import { onError } from './transport/errors';
import { createLanOnboardingRoutes } from './transport/lan-onboarding';

async function main(): Promise<void> {
  const { services, socket } = await createSurface();
  const mcp = createMcpHandler({
    serverInfo: { name: appIdentity.slug, version: appIdentity.version },
    auth: () => ({ scope: 'public' }),
    services,
  });
  const openApi = generateOpenApiDocument({
    info: { title: `${appIdentity.name} API`, version: appIdentity.version },
    groups: [{ pathPrefix: '/api', services }],
  });

  const server = createServer({
    groups: [{ pathPrefix: '/api', services }],
    port: env.API_PORT,
    hostname: '0.0.0.0',
    cors: { origin: env.CORS_ORIGIN },
    hooks: { onError },
    logging: { format: env.LOG_FORMAT },
    websocket: socket.websocket,
    rawRoutes: [
      socket.route,
      openApiRoute('/openapi.json', openApi),
      createMcpHttpRoute({ path: '/mcp', handler: mcp }),
      ...createLanOnboardingRoutes(),
      {
        method: 'GET',
        path: '/health',
        handler: () => Response.json({ status: 'ok' }),
      },
    ],
    wrapFetch: (fetch) => wrapInRequestContext(fetch),
    bun:
      env.DEV_HTTPS_CERT && env.DEV_HTTPS_KEY
        ? {
            tls: {
              cert: Bun.file(env.DEV_HTTPS_CERT),
              key: Bun.file(env.DEV_HTTPS_KEY),
              ...(env.DEV_HTTPS_CA && { ca: Bun.file(env.DEV_HTTPS_CA) }),
            },
          }
        : undefined,
  });

  async function shutdown(): Promise<void> {
    server.stop();
    await mcp.close();
    await socket.io.close();
    await prisma.$disconnect();
  }

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  console.log(
    `API listening on ${env.DEV_HTTPS_CERT ? 'https' : 'http'}://127.0.0.1:${env.API_PORT}`,
  );
}

main().catch((error: unknown) => {
  console.error('API startup failed', error);
  process.exit(1);
});
