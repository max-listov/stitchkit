import { buildToolManifest, listToolNames, summarizeTransports } from 'stitchkit/tools';
import { createSurface } from './surface';

const { services, socket } = await createSurface();

try {
  const surface = { services };
  console.log(
    JSON.stringify(
      {
        manifest: buildToolManifest({ services, transport: 'AGENT' }),
        names: listToolNames(surface),
        transports: summarizeTransports(surface),
      },
      null,
      2,
    ),
  );
} finally {
  await socket.io.close();
}
