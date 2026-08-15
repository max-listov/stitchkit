import { env } from '@app/config';
import { appIdentity } from '@app/config/identity';
import { wrapInRequestContext } from 'stitchkit/observability';
import { createServer, generateOpenApiDocument, openApiRoute } from 'stitchkit/server';
import { createMcpHandler, createMcpHttpRoute } from 'stitchkit/tools';
import { prisma } from './lib/db';
import { createSurface } from './surface';
import { onError } from './transport/errors';

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
    socket,
    rawRoutes: [
      openApiRoute('/openapi.json', openApi),
      createMcpHttpRoute({ path: '/mcp', handler: mcp }),
      {
        method: 'GET',
        path: '/health',
        handler: () => Response.json({ status: 'ok' }),
      },
    ],
    wrapFetch: (fetch) => wrapInRequestContext(fetch),
  });

  const shutdownController = new AbortController();
  let shutdownPromise: Promise<void> | undefined;

  function shutdown(): Promise<void> {
    if (shutdownPromise) {
      shutdownController.abort();
      return shutdownPromise;
    }

    shutdownPromise = (async () => {
      await server.shutdown({
        gracePeriodMs: 30_000,
        signal: shutdownController.signal,
      });
      await mcp.close();
      await prisma.$disconnect();
    })();
    return shutdownPromise;
  }

  const onSignal = () =>
    void shutdown().catch((error: unknown) => {
      console.error('Shutdown failed', error);
    });

  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  console.log(`API listening on http://127.0.0.1:${env.API_PORT}`);
}

main().catch((error: unknown) => {
  console.error('API startup failed', error);
  process.exit(1);
});
