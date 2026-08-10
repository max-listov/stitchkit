import { env } from '@app/config';
import { wrapInRequestContext } from 'stitchkit/observability';
import { createServer, generateOpenApiDocument, openApiRoute } from 'stitchkit/server';
import { createMcpHandler, createMcpHttpRoute } from 'stitchkit/tools';
import { prisma } from './lib/db';
import { createSurface } from './surface';
import { onError } from './transport/errors';

async function main(): Promise<void> {
  const { services, socket } = await createSurface();
  const mcp = createMcpHandler({
    serverInfo: { name: 'stitchkit-starter', version: '0.1.0' },
    auth: () => ({ scope: 'public' }),
    services,
  });
  const openApi = generateOpenApiDocument({
    info: { title: 'Stitchkit Starter API', version: '0.1.0' },
    groups: [{ pathPrefix: '/api', services }],
  });

  const server = createServer({
    groups: [{ pathPrefix: '/api', services }],
    port: env.API_PORT,
    hostname: '0.0.0.0',
    cors: { origin: '*' },
    hooks: { onError },
    logging: { format: env.LOG_FORMAT },
    websocket: socket.websocket,
    rawRoutes: [
      socket.route,
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

  async function shutdown(): Promise<void> {
    server.stop();
    await mcp.close();
    await socket.io.close();
    await prisma.$disconnect();
  }

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  console.log(`API listening on http://127.0.0.1:${env.API_PORT}`);
}

main().catch((error: unknown) => {
  console.error('API startup failed', error);
  process.exit(1);
});
