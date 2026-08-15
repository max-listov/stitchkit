import { io as ioClient } from 'socket.io-client';
import { createSocketIOServer, serveNode } from 'stitchkit/node';

let resolveRequestStarted;
const requestStarted = new Promise((resolve) => {
  resolveRequestStarted = resolve;
});
let releaseRequest;
const requestRelease = new Promise((resolve) => {
  releaseRequest = resolve;
});
const socket = await createSocketIOServer({ cors: { origin: '*' } });
const server = await serveNode({
  port: 0,
  socket,
  rawRoutes: [
    {
      method: 'GET',
      path: '/slow',
      async handler() {
        resolveRequestStarted();
        await requestRelease;
        return Response.json({ ok: true });
      },
    },
  ],
});
const client = ioClient(server.url, { transports: ['websocket'], reconnection: false });
await new Promise((resolve, reject) => {
  client.once('connect', resolve);
  client.once('connect_error', reject);
});
const request = fetch(`${server.url}/slow`);
await requestStarted;

let signalCount = 0;
const controller = new AbortController();
let shutdownPromise;
process.on('SIGTERM', () => {
  signalCount += 1;
  if (shutdownPromise) {
    controller.abort();
    return;
  }
  shutdownPromise = (async () => {
    setTimeout(releaseRequest, 20);
    const result = await server.shutdown({ gracePeriodMs: 1_000, signal: controller.signal });
    await request;
    client.close();
    process.stdout.write(`RESULT ${JSON.stringify({ ...result, signalCount })}\n`);
  })();
});
process.stdout.write('READY\n');
