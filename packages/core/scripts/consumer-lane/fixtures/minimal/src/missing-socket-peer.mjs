import { createSocketIOServer } from 'stitchkit/server';

await createSocketIOServer({ cors: { origin: '*' } });
