import { createCli } from '../../src/entrypoints/cli';
import {
  defineMcpClientConnection,
  mountConnections,
} from '../../src/entrypoints/tools/connections';

const [url, ...argv] = process.argv.slice(2);
if (!url) throw new Error('A synthetic MCP URL is required');
const runtimeTools = await mountConnections([
  defineMcpClientConnection({ name: 'fixture', transport: { url }, transports: ['CLI'] }),
]);
await createCli({
  name: 'fixture',
  version: '1',
  runtimeTools,
  argv,
  exitCodes: { ITEM_NOT_FOUND: 4 },
});
