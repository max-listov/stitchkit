import { repositoryRealtimeContract } from '@app/shared';
import { createRealtimeClient } from 'stitchkit';
import { createCacheBridge } from 'stitchkit/react';
import { optionalRealtimeOrigin } from '@/lib/api/cross-origin';
import { useRepository } from '@/lib/api/queries';
import { getQueryClient } from '@/lib/query-client';

/**
 * The one thing a route handler cannot proxy.
 *
 * A WebSocket upgrade does not survive a Next route handler, which is why this
 * has a variable of its own — `PUBLIC_REALTIME_ORIGIN` — rather than sharing
 * the HTTP one. A deployment can be same-origin for HTTP and still have to name
 * the socket's address: two roles on two ports with no routing layer in front
 * of them is exactly that. Unset picks the page's own origin, where a routing
 * layer forwards `/socket.io`.
 */
function buildSocket() {
  // `window.location.origin` is not a value baked in anywhere: it is what this
  // browser actually dialled, read at connect time, exactly like the server
  // reads the request's origin. This function only ever runs in an effect.
  const url = optionalRealtimeOrigin() ?? window.location.origin;
  // Keep this recipe source-compatible with the template's current published
  // Stitchkit target: structural typing lets the older additive API ignore
  // `peers`, while current Stitchkit consumes the literal loader.
  const options = {
    url,
    peers: { client: () => import('socket.io-client') },
  };
  return createRealtimeClient(repositoryRealtimeContract, options);
}

function buildBridge() {
  return createCacheBridge({
    socket: repositorySocket(),
    queryClient: getQueryClient,
    handlers: {
      'repository:refreshed': (snapshot, { queryClient }) => {
        queryClient.setQueryData(useRepository.getKey(), snapshot);
      },
    },
  });
}

// Built on FIRST USE: the socket needs whatever origin the server supplied,
// and that arrives at runtime rather than from the build. See
// `lib/api/cross-origin.ts`.
let socket: ReturnType<typeof buildSocket> | undefined;
let bridge: ReturnType<typeof buildBridge> | undefined;

export function repositorySocket(): ReturnType<typeof buildSocket> {
  socket ??= buildSocket();
  return socket;
}

export function repositoryBridge(): ReturnType<typeof buildBridge> {
  bridge ??= buildBridge();
  return bridge;
}
