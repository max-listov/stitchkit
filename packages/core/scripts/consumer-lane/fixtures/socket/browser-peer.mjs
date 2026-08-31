import { createServer, createSocketIOServer } from 'stitchkit/server';

// Disposable manual-browser acceptance peer. Serve a browser bundle of observation.mjs.
const bundle = process.argv[2];
const hostname = process.argv[3] ?? '127.0.0.1';
if (!bundle) throw new Error('browser bundle path required');
const socket = await createSocketIOServer({ transports: ['websocket'] });
socket.io.on('connection', (peer) => {
  peer.on('ping', (data, acknowledge) => acknowledge({ n: data.n + 1 }));
  peer.on('diagnosticLate', (acknowledge) => setTimeout(() => acknowledge({ n: 7 }), 40));
  peer.on('diagnosticDrop', () => peer.disconnect(true));
});
const server = createServer({
  port: 0,
  hostname,
  socket,
  rawRoutes: [
    {
      method: 'GET',
      path: '/',
      handler: () =>
        new Response(
          '<!doctype html><title>Realtime diagnostic acceptance</title><link rel="icon" href="data:,">',
          {
            headers: { 'content-type': 'text/html' },
          },
        ),
    },
    {
      method: 'GET',
      path: '/observation.js',
      handler: () =>
        new Response(Bun.file(bundle), { headers: { 'content-type': 'text/javascript' } }),
    },
  ],
});
process.once('SIGTERM', async () => {
  await server.shutdown({ gracePeriodMs: 0 });
  process.exit(0);
});
console.log(`browser peer ready ${server.port}`);
