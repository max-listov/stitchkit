import { createCli, defineCliCommand } from 'stitchkit/cli';
import { defineMcpClientConnection, mountConnections } from 'stitchkit/tools/connections';
import { z } from 'zod';

const [url, policy, command, ...flags] = process.argv.slice(2);
if (!url || !policy || !command) throw new Error('Missing fixture arguments');
const marker = 'packed-private-url-token-body-stack-marker';
if (command === 'unknown') {
  await createCli({
    name: 'packed',
    version: '1',
    argv: ['unknown', ...flags],
    commands: [
      defineCliCommand({
        name: 'unknown',
        description: 'Unknown failure control',
        input: z.object({}),
        output: z.unknown(),
        handler: () => {
          throw new Error(marker);
        },
      }),
    ],
  });
} else {
  const runtimeTools = await mountConnections([
    defineMcpClientConnection({
      name: marker,
      transport: { url: `${url}?token=${marker}` },
      token: () => marker,
      transports: ['CLI'],
      limits: JSON.parse(policy),
    }),
  ]);
  await createCli({ name: 'packed', version: '1', runtimeTools, argv: [command, ...flags] });
}
