import { repositoryRealtimeContract } from '@app/shared';
import { createRealtimeClient } from 'stitchkit';
import { createCacheBridge } from 'stitchkit/react';
import { env } from '@/env';
import { useRepository } from '@/lib/api/queries';
import { getQueryClient } from '@/lib/query-client';

export const repositorySocket = createRealtimeClient(repositoryRealtimeContract, {
  url: env.NEXT_PUBLIC_API_URL,
});

export const repositoryBridge = createCacheBridge({
  socket: repositorySocket,
  queryClient: getQueryClient,
  handlers: {
    'repository:refreshed': (snapshot, { queryClient }) => {
      queryClient.setQueryData(useRepository.getKey(), snapshot);
    },
  },
});
