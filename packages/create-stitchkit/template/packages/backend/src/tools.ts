import { buildToolManifest, listToolNames, summarizeTransports } from 'stitchkit/tools';
import { createSurface } from './surface';

const { services, socket } = await createSurface();

try {
  const surface = { services };
  const toolNames = listToolNames(surface)
    .filter((tool) => tool.transports.some((transport) => transport !== 'HTTP'))
    .map((tool) => tool.name);
  console.log(
    JSON.stringify(
      {
        manifest: buildToolManifest({ services, transport: 'AGENT' }),
        names: toolNames,
        transports: summarizeTransports(surface),
      },
      null,
      2,
    ),
  );
} finally {
  await socket.io.close();
}
