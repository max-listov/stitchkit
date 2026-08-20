import { createStdioMcpServer } from '../../src/tools/mcp-stdio';
import { bindStdioProcessSignals } from '../../src/tools/mcp-stdio-signals';

const stdio = await createStdioMcpServer({
  serverInfo: { name: 'stitchkit-stdio-signal-test', version: '1' },
  auth: null,
  services: [],
});
const binding = bindStdioProcessSignals(stdio, {
  onError: (phase) => console.error(`ERROR ${phase}`),
  onComplete: () => console.error('CLOSED'),
});
console.error('READY');
await binding.promise;
