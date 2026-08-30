/** Node-only public declarations: no ambient Bun types are installed. */

import { type ApplicationShutdownResult, createApplication } from 'stitchkit/application';
import {
  createHandler,
  createSocketIOServer,
  type HandlerConfig,
  type RawRoute,
  ShutdownOptionsSchema,
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
const shutdownDefaults = ShutdownOptionsSchema.parse({});
if (shutdownDefaults.realtimeCloseTimeoutMs !== 1_000) {
  throw new Error('node consumer: missing realtime close bound');
}
void handler;
const application = createApplication({ id: 'node-types' });
const result: Promise<ApplicationShutdownResult> = application.shutdown();
void result;
console.log('node consumer: ok');
