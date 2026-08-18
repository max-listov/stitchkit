import { env } from '@app/config';
import { appIdentity } from '@app/config/identity';
import { wrapInRequestContext } from 'stitchkit/observability';
import {
  bindProcessSignals,
  createServer,
  generateOpenApiDocument,
  openApiRoute,
} from 'stitchkit/server';
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
    hostname: env.BIND_HOST,
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

  // The server owns HTTP and Socket.IO; MCP, Prisma and the exit code are the
  // application's and close after the drain. A second signal forces this same
  // shutdown, a third hands the signal back to its default disposition.
  bindProcessSignals(server, {
    shutdown: { gracePeriodMs: 30_000 },
    onComplete: async (result) => {
      await mcp.close();
      await prisma.$disconnect();
      process.exitCode = result.outcome === 'clean' ? 0 : 1;
    },
    onError: (phase, error) => {
      console.error(`Shutdown failed during ${phase}`, error);
      process.exitCode = 1;
    },
  });

  console.log(`API listening on http://${env.BIND_HOST}:${env.API_PORT}`);
}

main().catch((error: unknown) => {
  console.error('API startup failed', error);
  process.exit(1);
});
