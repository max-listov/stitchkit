import { RepositorySnapshotSchema, repositoryRealtimeContract } from '@app/shared';
import { createRealtimeClient, defineRealtimeContract } from 'stitchkit';
import { z } from 'zod';
import { defineSurfaceProbe, runSurfaceConformance } from './surface-conformance';
import { loadToolingEnv } from './tooling-env';

const toolingEnv = loadToolingEnv();
const apiOrigin = toolingEnv.NEXT_PUBLIC_API_URL;

async function json(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${apiOrigin}${path}`, init);
  if (!response.ok)
    throw new Error(`${init?.method ?? 'GET'} ${path} returned ${response.status}`);
  return response.json();
}

z.object({ status: z.literal('ok') }).parse(await json('/health'));

await runSurfaceConformance({
  apiOrigin,
  probes: [
    defineSurfaceProbe({
      name: 'repository refresh lifecycle',
      input: z.object({ path: z.literal('/api/repository/refresh') }),
      fixture: { path: '/api/repository/refresh' },
      output: RepositorySnapshotSchema,
      run: async ({ path }) => {
        const rejected: string[] = [];
        const socket = createRealtimeClient(repositoryRealtimeContract, {
          url: apiOrigin,
          transports: ['websocket'],
          onRejected: ({ event, direction, phase }) => {
            rejected.push(`${event}:${direction}:${phase}`);
          },
        });
        try {
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(
              () => reject(new Error('Socket.IO connection timed out')),
              5_000,
            );
            const unsubscribe = socket.onConnectionChange((connected, reason) => {
              if (!connected) {
                if (reason) reject(new Error(`Socket.IO disconnected: ${reason}`));
                return;
              }
              clearTimeout(timeout);
              unsubscribe();
              resolve();
            });
            socket.connect();
          });
          const refreshedEvent = new Promise<string>((resolve, reject) => {
            const timeout = setTimeout(
              () => reject(new Error('Socket.IO repository refresh event timed out')),
              5_000,
            );
            const unsubscribe = socket.on('repository:refreshed', (snapshot) => {
              clearTimeout(timeout);
              unsubscribe();
              resolve(snapshot.fullName);
            });
          });
          const refreshed = RepositorySnapshotSchema.parse(
            await json(path, { method: 'POST' }),
          );
          if ((await refreshedEvent) !== refreshed.fullName) {
            throw new Error('Socket.IO repository identity differs');
          }
          const cached = RepositorySnapshotSchema.parse(await json('/api/repository/'));
          if (cached.fullName !== refreshed.fullName) {
            throw new Error('Repository cache read differs');
          }
          if (rejected.length > 0) {
            throw new Error(`Realtime contract rejected ${rejected.join(', ')}`);
          }
          return refreshed;
        } finally {
          socket.disconnect();
        }
      },
    }),
    defineSurfaceProbe({
      name: 'realtime rejection path fires on a contract mismatch',
      input: z.object({ path: z.literal('/api/repository/refresh') }),
      fixture: { path: '/api/repository/refresh' },
      run: async ({ path }) => {
        // NEGATIVE probe: a client whose local contract disagrees with the
        // server must see the real payload REJECTED — this executes the
        // rejection path instead of merely asserting its absence. Matched by
        // event/direction/phase, never by message text.
        const divergentContract = defineRealtimeContract({
          serverToClient: {
            'repository:refreshed': { args: z.tuple([z.object({ bogus: z.string() })]) },
          },
          clientToServer: {},
        });
        const rejections: Array<{ event: string; direction: string; phase: string }> = [];
        const socket = createRealtimeClient(divergentContract, {
          url: apiOrigin,
          transports: ['websocket'],
          onRejected: ({ event, direction, phase }) => {
            rejections.push({ event, direction, phase });
          },
        });
        try {
          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(
              () => reject(new Error('Socket.IO connection timed out')),
              5_000,
            );
            const unsubscribe = socket.onConnectionChange((connected) => {
              if (!connected) return;
              clearTimeout(timeout);
              unsubscribe();
              resolve();
            });
            socket.connect();
          });
          // A handler must be attached for the inbound frame to be validated.
          const unsubscribe = socket.on('repository:refreshed', () => {
            throw new Error('a payload outside the local contract reached the handler');
          });
          await json(path, { method: 'POST' });
          const deadline = Date.now() + 5_000;
          while (rejections.length === 0 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          unsubscribe();
          const rejection = rejections[0];
          if (!rejection) {
            throw new Error('the contract mismatch was never rejected');
          }
          if (
            rejection.event !== 'repository:refreshed' ||
            rejection.direction !== 'client-inbound' ||
            rejection.phase !== 'arguments'
          ) {
            throw new Error(
              `unexpected rejection identity: ${rejection.event}:${rejection.direction}:${rejection.phase}`,
            );
          }
        } finally {
          socket.disconnect();
        }
      },
    }),
  ],
});

{
  const corsResponse = await fetch(`${apiOrigin}/api/repository/`, {
    headers: { Origin: 'http://localhost:58302' },
  });
  if (
    corsResponse.headers.get('access-control-allow-origin') !==
    new URL(toolingEnv.NEXT_PUBLIC_WEB_URL).origin
  ) {
    throw new Error('API CORS origin differs from the configured web origin');
  }
  const openApi = z
    .object({ paths: z.record(z.string(), z.unknown()) })
    .parse(await json('/openapi.json'));
  if (!Object.keys(openApi.paths).some((path) => path.startsWith('/api/repository'))) {
    throw new Error('OpenAPI repository path is missing');
  }
}

console.log('Runtime HTTP, OpenAPI, Socket.IO and MCP smoke passed');
