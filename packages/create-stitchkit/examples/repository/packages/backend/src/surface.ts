import { env } from '@app/config';
import { repositoryRealtimeContract } from '@app/shared';
import type { TrustFence } from 'stitchkit/server';
import { bindRealtimeServer, createSocketIOServer, createTrustFence } from 'stitchkit/server';
import { type BoardRuntime, openBoard } from './lib/board';
import { bindLive } from './lib/live';
import { createBoardService } from './transport/board-service';
import { createRepositoryService } from './transport/repository-service';
import { createSystemService } from './transport/system-service';

/**
 * The fence this deployment answers behind, or nothing.
 *
 * `trustedHosts` has no default and cannot have one: a fence compares the
 * authority a request addressed against a list, and it cannot invent the list.
 * Unset means no fence — honest for a checkout on a laptop, wrong for anything
 * a network can reach.
 */
function createFence(): TrustFence | undefined {
  if (!env.TRUSTED_HOSTS) return undefined;
  const browserOrigin = env.CORS_ORIGIN ? [new URL(env.CORS_ORIGIN).host] : [];
  return createTrustFence({
    trustedHosts: env.TRUSTED_HOSTS.split(',').map((entry) => entry.trim()),
    ...(browserOrigin.length > 0 && { trustedOrigins: browserOrigin }),
    onRefused: (refusal) => {
      console.warn(
        `Refused a ${refusal.lane} request: ${refusal.reason} (host ${refusal.host ?? 'absent'})`,
      );
    },
  });
}

export async function createSurface() {
  const board: BoardRuntime = await openBoard();
  const fence = createFence();

  const socket = await createSocketIOServer({
    cors: { origin: env.CORS_ORIGIN ?? [] },
    // The socket's own admission point. `/socket.io/*` never reaches a lifecycle
    // hook on either runtime, so a fence installed only in `hooks` would leave
    // open the lane this app pushes its live data over.
    ...(fence && { allowRequest: fence.allowRequest }),
  });

  // Two bindings over one socket, deliberately. This example's own contract and
  // the live one are separate declarations with separate event names, and
  // merging them into a single registry here would mean editing the merge every
  // time either side gains a topic.
  const realtime = bindRealtimeServer(repositoryRealtimeContract, socket);
  const live = bindLive(board, socket);

  const repositoryService = createRepositoryService((snapshot) =>
    realtime.emit('repository:refreshed', snapshot),
  );

  return {
    socket,
    fence,
    board,
    hub: live.hub,
    services: [createSystemService(), createBoardService(board), repositoryService],
  };
}
