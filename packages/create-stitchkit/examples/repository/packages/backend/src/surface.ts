import { env } from '@app/config';
import { repositoryRealtimeContract } from '@app/shared';
import { bindRealtimeServer, createSocketIOServer } from 'stitchkit/server';
import { createRepositoryService } from './transport/repository-service';
import { createSystemService } from './transport/system-service';

export async function createSurface() {
  const socket = await createSocketIOServer({
    cors: { origin: env.CORS_ORIGIN ?? [] },
  });
  const realtime = bindRealtimeServer(repositoryRealtimeContract, socket);
  const repositoryService = createRepositoryService((snapshot) =>
    realtime.emit('repository:refreshed', snapshot),
  );
  return { socket, services: [createSystemService(), repositoryService] };
}
