import { createApplication, managedServerResource } from '../../src/application';
import { bindProcessSignals, createServer, createSocketIOServer } from '../../src/server';

const socket = await createSocketIOServer({
  cors: { origin: '*' },
  transports: ['websocket'],
});
const server = createServer({ port: 0, socket });
const application = createApplication({
  id: 'socketio-clean-shutdown-fixture',
  resources: [managedServerResource({ id: 'http', server })],
  shutdown: { gracePeriodMs: 1_000, forceTimeoutMs: 1_000 },
});

const binding = bindProcessSignals(application, {
  onShutdown() {
    const diagnostic = setTimeout(() => {
      process.stderr.write(
        `ACTIVE_RESOURCES ${JSON.stringify(process.getActiveResourcesInfo())}\n`,
      );
    }, 2_000);
    diagnostic.unref();
  },
  onError(phase, error) {
    process.exitCode = 1;
    process.stderr.write(
      `SHUTDOWN_ERROR ${phase} ${error instanceof Error ? error.stack : String(error)}\n`,
    );
  },
});

await application.start();
process.stdout.write(`READY ${JSON.stringify({ url: server.url })}\n`);

const result = await binding.promise;
if (result === undefined) {
  throw new Error('Socket.IO shutdown fixture lost its signal binding');
}
process.stdout.write(`RESULT ${JSON.stringify(result)}\n`);
