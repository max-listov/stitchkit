/** Node-only public declarations: no ambient Bun types are installed. */
import {
  createHandler,
  createSocketIOServer,
  type HandlerConfig,
  type RawRoute,
  serveNode,
} from 'stitchkit/node';

const route: RawRoute = {
  method: 'GET',
  path: '/health',
  handler: () => Response.json({ ok: true }),
};
const config: HandlerConfig = { rawRoutes: [route] };
const handler = createHandler(config);

void createSocketIOServer;
void serveNode;
void handler;
console.log('node consumer: ok');
