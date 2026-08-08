import { createContractFactory } from 'stitchkit';
import { RepositorySnapshotSchema } from '../schemas/repository';

export type AppScope = 'public';

const { defineContract } = createContractFactory<AppScope>();

export const repositoryContract = defineContract(
  { prefix: 'repository', scope: 'public' },
  {
    read: {
      method: 'GET',
      path: '/',
      desc: 'Read the server-cached repository snapshot',
      output: RepositorySnapshotSchema,
      expose: ['HTTP', 'MCP', 'AGENT', 'CLI'],
      toolName: 'repository_read',
    },
    refresh: {
      method: 'POST',
      path: '/refresh',
      desc: 'Refresh the repository snapshot from GitHub',
      output: RepositorySnapshotSchema,
      expose: ['HTTP', 'MCP', 'AGENT', 'CLI'],
      toolName: 'repository_refresh',
    },
  },
);
