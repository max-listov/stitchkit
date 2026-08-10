import { createContractFactory } from 'stitchkit';
import { SystemStatusSchema } from '../schemas/system';

const { defineContract } = createContractFactory<'public'>({
  toolExposure: 'explicit',
});

export const systemContract = defineContract(
  { prefix: 'system', scope: 'public' },
  {
    status: {
      method: 'GET',
      path: '/status',
      desc: 'Read application readiness',
      output: SystemStatusSchema,
      expose: ['HTTP'],
    },
  },
);
