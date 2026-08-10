import { env } from '@app/config';
import { createSocketIOServer } from 'stitchkit/server';
import { createSystemService } from './transport/system-service';

export async function createSurface() {
  const socket = await createSocketIOServer({ cors: { origin: env.CORS_ORIGIN } });
  return { socket, services: [createSystemService()] };
}
