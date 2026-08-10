import { env } from '@app/config';
import { createSocketIOServer } from 'stitchkit/server';

export async function createSurface() {
  const socket = await createSocketIOServer({ cors: { origin: env.CORS_ORIGIN } });
  return { socket, services: [] };
}
