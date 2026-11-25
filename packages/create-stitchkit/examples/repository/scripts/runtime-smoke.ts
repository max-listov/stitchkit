import { RepositorySnapshotSchema, repositoryRealtimeContract } from '@app/shared';
import { createRealtimeClient, defineRealtimeContract } from 'stitchkit';
import {
  type RealtimeRejectionObservation,
  runSurfaceProbes,
  type TransportObservation,
} from 'stitchkit/testing';
import { z } from 'zod';
import { assertDeploymentIsAnswering } from './deployment-preflight';
import { assertLiveSurface } from './surface-snapshot';
import { loadToolingEnv } from './tooling-env';
import { assertArtifactIsPlacementFree, assertPublicWebSurface } from './web-surface-smoke';

const toolingEnv = loadToolingEnv();
const apiOrigin = toolingEnv.SMOKE_API_ORIGIN;

await assertDeploymentIsAnswering({
  'the API role': apiOrigin,
  'the web role': toolingEnv.SMOKE_WEB_ORIGIN,
});

async function json(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${apiOrigin}${path}`, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(`${init?.method ?? 'GET'} ${path} returned ${response.status}`);
  return response.json();
}

z.object({ status: z.literal('ok') }).parse(await json('/health'));

await assertLiveSurface(apiOrigin);

interface RepositoryProbeFixture {
  path: '/api/repository/refresh';
  mode: 'refresh' | 'divergent-contract';
}

async function runRefreshProbe(
  path: string,
  signal: AbortSignal,
): Promise<TransportObservation> {
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
      await json(path, { method: 'POST', signal }),
    );
    if ((await refreshedEvent) !== refreshed.fullName) {
      throw new Error('Socket.IO repository identity differs');
    }
    const cached = RepositorySnapshotSchema.parse(await json('/api/repository/', { signal }));
    if (cached.fullName !== refreshed.fullName) {
      throw new Error('Repository cache read differs');
    }
    if (rejected.length > 0) {
      throw new Error(`Realtime contract rejected ${rejected.join(', ')}`);
    }
    return { outcome: 'success' };
  } finally {
    socket.disconnect();
  }
}

async function runDivergentContractProbe(
  path: string,
  signal: AbortSignal,
): Promise<TransportObservation> {
  // NEGATIVE probe: a client whose local contract disagrees with the
  // server must see the real payload REJECTED — this executes the
  // rejection path instead of merely asserting its absence. Matched by
  // structured rejection observation, never by message text.
  const divergentContract = defineRealtimeContract({
    serverToClient: {
      'repository:refreshed': { args: z.tuple([z.object({ bogus: z.string() })]) },
    },
    clientToServer: {},
  });
  const rejections: RealtimeRejectionObservation[] = [];
  const socket = createRealtimeClient(divergentContract, {
    url: apiOrigin,
    transports: ['websocket'],
    onRejected: ({ direction, phase, reason, fault }) => {
      rejections.push({ direction, phase, reason, fault });
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
    await json(path, { method: 'POST', signal });
    const deadline = Date.now() + 5_000;
    while (rejections.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    unsubscribe();
    const rejection = rejections[0];
    if (!rejection) {
      throw new Error('the contract mismatch was never rejected');
    }
    return { outcome: 'realtime_rejected', rejection };
  } finally {
    socket.disconnect();
  }
}

await runSurfaceProbes<RepositoryProbeFixture>({
  probes: [
    {
      name: 'repository refresh lifecycle',
      fixture: { path: '/api/repository/refresh', mode: 'refresh' },
      transports: ['REALTIME'],
      expected: { REALTIME: { outcome: 'success' } },
    },
    {
      name: 'realtime rejection path fires on a contract mismatch',
      fixture: { path: '/api/repository/refresh', mode: 'divergent-contract' },
      transports: ['REALTIME'],
      expected: {
        REALTIME: {
          outcome: 'realtime_rejected',
          rejection: {
            direction: 'client-inbound',
            phase: 'arguments',
            reason: 'invalid-arguments',
            fault: 'peer',
          },
        },
      },
    },
  ],
  drivers: {
    REALTIME: {
      invoke: (fixture, signal) =>
        fixture.mode === 'refresh'
          ? runRefreshProbe(fixture.path, signal)
          : runDivergentContractProbe(fixture.path, signal),
    },
  },
});

{
  const corsResponse = await fetch(`${apiOrigin}/api/repository/`, {
    headers: { Origin: 'http://localhost:58302' },
  });
  if (
    corsResponse.headers.get('access-control-allow-origin') !==
    new URL(toolingEnv.SMOKE_WEB_ORIGIN).origin
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

{
  // THE DEFAULT PATH, end to end: the browser's own origin answers `/api/…`
  // because the web role forwards it. This is what makes the example's client a
  // module constant, so it is checked rather than described.
  const proxied = await fetch(`${toolingEnv.SMOKE_WEB_ORIGIN}/api/repository`);
  if (!proxied.ok) {
    throw new Error(
      `The web role did not forward /api/repository (${proxied.status}) — the same-origin default is broken`,
    );
  }
  const sameOrigin = RepositorySnapshotSchema.parse(await proxied.json());
  const direct = RepositorySnapshotSchema.parse(await json('/api/repository/'));
  if (sameOrigin.fullName !== direct.fullName) {
    throw new Error("the forwarded answer differs from the API role's own");
  }
}

await assertPublicWebSurface(toolingEnv.SMOKE_WEB_ORIGIN);
await assertArtifactIsPlacementFree(toolingEnv.SMOKE_WEB_ORIGIN, {
  origin: toolingEnv.PUBLIC_WEB_ORIGIN,
  hosts: toolingEnv.PUBLIC_WEB_HOSTS,
});

console.log(
  'Runtime HTTP (same-origin and direct), OpenAPI, Socket.IO, MCP and public web smoke passed',
);
