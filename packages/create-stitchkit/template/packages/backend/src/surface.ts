import { env } from '@app/config';
import { createSocketIOServer, createTrustFence, type TrustFence } from 'stitchkit/server';
import { type BoardRuntime, openBoard } from './lib/board';
import { bindLive } from './lib/live';
import { createBoardService } from './transport/board-service';
import { createSystemService } from './transport/system-service';

/**
 * The fence this deployment answers behind, or nothing.
 *
 * `trustedHosts` has no default and cannot have one: a fence can compare the
 * authority a request addressed against a list, and it cannot invent the list.
 * Unset means no fence, which is honest for a checkout on a laptop and wrong for
 * anything a network can reach.
 *
 * The browser origin is the one already declared for CORS. They answer different
 * questions — CORS says what a page may *read*, the fence says which authority
 * this server agreed to *answer on* — but a deployment that names a cross-origin
 * browser has named it once, and asking twice is asking for two answers that
 * disagree.
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

  // An EMPTY allow-list is same-origin: no origin is permitted to open a
  // cross-origin socket, and no browser on this app's own origin needs one.
  // `CORS_ORIGIN` is set only when the browser genuinely lives elsewhere.
  // (Once the workspace targets a Stitchkit release where `cors` itself is
  // optional, this becomes `undefined` and the empty array goes away.)
  const socket = await createSocketIOServer({
    cors: { origin: env.CORS_ORIGIN ?? [] },
    // The socket's own admission point, and the reason the fence has two halves:
    // `/socket.io/*` never reaches a lifecycle hook on either runtime, so a
    // fence installed only in `hooks` would leave open the lane this app pushes
    // its live data over.
    ...(fence && { allowRequest: fence.allowRequest }),
  });

  const live = bindLive(board, socket);

  return {
    socket,
    fence,
    board,
    hub: live.hub,
    services: [createSystemService(), createBoardService(board)],
  };
}
