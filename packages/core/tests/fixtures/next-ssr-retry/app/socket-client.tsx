'use client';

import { createSocketIOClient } from 'stitchkit';

// Construction stays lazy: this proves Webpack can compile the supported
// literal peer loader without evaluating or connecting it during the build.
const client = createSocketIOClient({
  url: 'http://127.0.0.1:1',
  peers: { client: () => import('socket.io-client') },
});

export function SocketClientCompileProof() {
  return <span data-socket-client={String(client.connected)} />;
}
