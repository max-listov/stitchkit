import type { ClientToServerEvents, ServerToClientEvents } from '@app/shared';
import { createSocketIOServer } from 'stitchkit/server';
import { createRepositoryService } from './transport/repository-service';

export async function createSurface() {
  const socket = await createSocketIOServer<ServerToClientEvents, ClientToServerEvents>({
    cors: { origin: '*' },
  });
  const repositoryService = createRepositoryService((snapshot) =>
    socket.io.emit('repository:refreshed', snapshot),
  );
  return { socket, services: [repositoryService] };
}
