import { env } from '@app/config';
import { createSocketIOServer } from 'stitchkit/server';
import { createSystemService } from './transport/system-service';

export async function createSurface() {
  // An EMPTY allow-list is same-origin: no origin is permitted to open a
  // cross-origin socket, and no browser on this app's own origin needs one.
  // `CORS_ORIGIN` is set only when the browser genuinely lives elsewhere.
  // (Once the workspace targets a Stitchkit release where `cors` itself is
  // optional, this becomes `undefined` and the empty array goes away.)
  const socket = await createSocketIOServer({ cors: { origin: env.CORS_ORIGIN ?? [] } });
  return { socket, services: [createSystemService()] };
}
