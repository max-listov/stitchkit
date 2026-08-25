import { env } from '@app/config';
import { apiRole, appDeclaration } from '@app/config/declaration';
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
    serverInfo: {
      name: appDeclaration.identity.slug,
      version: appDeclaration.identity.version,
    },
    auth: () => ({ scope: 'public' }),
    services,
  });
  const openApi = generateOpenApiDocument({
    info: {
      title: `${appDeclaration.identity.name} API`,
      version: appDeclaration.identity.version,
    },
    groups: [{ pathPrefix: '/api', services }],
  });

  const server = createServer({
    groups: [{ pathPrefix: '/api', services }],
    port: env.API_PORT,
    hostname: env.BIND_HOST,
    cors: env.CORS_ORIGIN ? { origin: env.CORS_ORIGIN } : undefined,
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
    // The FLOOR comes from the declaration, which is where a supervisor reads
    // it too — one number, not two that can disagree. It is a property of the
    // code: whatever supervises this process must allow at least this much
    // before sending SIGKILL, or the drain never finishes.
    shutdown: { gracePeriodMs: apiRole.drainFloorMs },
    onComplete: async (result) => {
      await mcp.close();
      await prisma.$disconnect();
      // Say how the drain ended. Without this an operator sees a process that
      // vanished and an exit code, and cannot tell a clean drain from one the
      // deadline or a second signal cut short.
      console.log(
        `Shutdown ${result.outcome}${result.reason ? ` (${result.reason})` : ''} in ${result.durationMs}ms — ${result.completedRequests} requests completed, ${result.abortedRequests} aborted, ${result.forcedWebSockets} sockets forced`,
      );
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
