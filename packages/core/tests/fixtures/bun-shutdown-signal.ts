import { io as ioClient } from 'socket.io-client';
import { createServer, createSocketIOServer } from '../../src/server';

const requestStarted = Promise.withResolvers<void>();
const socket = await createSocketIOServer({ cors: { origin: '*' } });
const server = createServer({
  port: 0,
  socket,
  rawRoutes: [
    {
      method: 'GET',
      path: '/slow',
      async handler() {
        requestStarted.resolve();
        await new Promise(() => undefined);
        return Response.json({ ok: true });
      },
    },
  ],
});
const client = ioClient(server.url, { transports: ['websocket'], reconnection: false });
await new Promise<void>((resolve, reject) => {
  client.once('connect', () => resolve());
  client.once('connect_error', reject);
});
const request = fetch(`${server.url}/slow`).catch(() => undefined);
await requestStarted.promise;

let signalCount = 0;
const shutdownController = new AbortController();
let shutdownPromise: Promise<void> | undefined;
const onSignal = () => {
  signalCount += 1;
  if (shutdownPromise) {
    shutdownController.abort();
    return;
  }
  shutdownPromise = (async () => {
    const result = await server.shutdown({
      gracePeriodMs: 1_000,
      signal: shutdownController.signal,
    });
    await request;
    client.close();
    process.stdout.write(`RESULT ${JSON.stringify({ ...result, signalCount })}\n`);
  })();
  process.stdout.write('SHUTTING_DOWN\n');
};
process.on('SIGTERM', onSignal);
process.stdout.write('READY\n');
