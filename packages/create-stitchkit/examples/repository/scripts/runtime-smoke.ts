import { RepositorySnapshotSchema } from '@app/shared';
import { io } from 'socket.io-client';
import { z } from 'zod';
import { defineSurfaceProbe, runSurfaceConformance } from './surface-conformance';
import { toolingEnv } from './tooling-env';

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
        const socket = io(apiOrigin, { transports: ['websocket'] });
        const refreshedEvent = new Promise<string>((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error('Socket.IO repository refresh event timed out')),
            5_000,
          );
          socket.once('repository:refreshed', (snapshot) => {
            clearTimeout(timeout);
            resolve(snapshot.fullName);
          });
        });
        try {
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
          return refreshed;
        } finally {
          socket.close();
        }
      },
    }),
  ],
});

{
  const corsResponse = await fetch(`${apiOrigin}/api/repository/`, {
    headers: { Origin: 'http://localhost:58302' },
  });
  if (corsResponse.headers.get('access-control-allow-origin') !== '*') {
    throw new Error('Public API does not allow a forwarded browser origin');
  }
  const openApi = z
    .object({ paths: z.record(z.string(), z.unknown()) })
    .parse(await json('/openapi.json'));
  if (!Object.keys(openApi.paths).some((path) => path.startsWith('/api/repository'))) {
    throw new Error('OpenAPI repository path is missing');
  }
}

console.log('Runtime HTTP, OpenAPI, Socket.IO and MCP smoke passed');
