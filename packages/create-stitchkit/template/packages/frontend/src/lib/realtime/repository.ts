import type { ClientToServerEvents, ServerToClientEvents } from '@app/shared';
import { createSocketIOClient } from 'stitchkit';
import { createCacheBridge } from 'stitchkit/react';
import { env } from '@/env';
import { useRepository } from '@/lib/api/queries';
import { getQueryClient } from '@/lib/query-client';

export const repositorySocket = createSocketIOClient<
  ServerToClientEvents,
  ClientToServerEvents
>({ url: env.NEXT_PUBLIC_API_URL });

export const repositoryBridge = createCacheBridge({
  socket: repositorySocket,
  queryClient: getQueryClient,
  handlers: {
    'repository:refreshed': (snapshot, { queryClient }) => {
      queryClient.setQueryData(useRepository.getKey(), snapshot);
    },
  },
});
