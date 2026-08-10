import { defineRealtimeContract } from 'stitchkit';
import { z } from 'zod';
import { RepositorySnapshotSchema } from '../schemas/repository';

export const repositoryRealtimeContract = defineRealtimeContract({
  serverToClient: {
    'repository:refreshed': { args: z.tuple([RepositorySnapshotSchema]) },
  },
  clientToServer: {},
});
