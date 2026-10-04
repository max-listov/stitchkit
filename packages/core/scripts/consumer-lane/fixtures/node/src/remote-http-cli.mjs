import { createHttpClient } from 'stitchkit';
import { createCli } from 'stitchkit/cli';
import { implementRemote } from 'stitchkit/remote';
import { contract } from './remote-http-contract.mjs';

const [baseUrl, ...argv] = process.argv.slice(2);
if (!baseUrl) throw new Error('Missing fixture origin');
const controller = new AbortController();
process.once('SIGTERM', () => controller.abort(new Error('private-caller-reason')));
await createCli({
  name: 'remote-probe',
  version: '1',
  argv,
  signal: controller.signal,
  services: [implementRemote(contract, createHttpClient({ baseUrl, retry: { limit: 0 } }))],
});
