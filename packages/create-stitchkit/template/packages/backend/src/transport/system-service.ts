import { type SystemStatus, systemContract } from '@app/shared';
import { implement } from 'stitchkit/server';

export function createSystemService() {
  return implement(systemContract, {
    status: (): SystemStatus => ({ status: 'ok' }),
  });
}
