import type { Server as HttpServer } from 'node:http';
import { serve } from 'srvx';
import { createHandler } from './create';
import type { HandlerConfig } from './types';

export interface NodeServerConfig extends HandlerConfig {
  port?: number;
  hostname?: string;
  /**
   * A Socket.IO handle from `createSocketIOServer` — attached to the underlying
   * `node:http.Server` (srvx `server.node.server`) once it is listening, so
   * Socket.IO owns the HTTP `upgrade` event on the same port.
   */
  socket?: { attach(server: HttpServer): void };
}

export interface NodeServerHandle {
  url: string;
  port: number;
  close(closeActive?: boolean): Promise<void>;
}

export async function serveNode(config: NodeServerConfig): Promise<NodeServerHandle> {
  const { port = 3000, hostname, socket, ...handlerConfig } = config;
  const handler = createHandler(handlerConfig);

  const server = serve({ port, hostname, fetch: handler });
  await server.ready();

  if (socket) {
    // srvx types the underlying server as `http.Server | http2.Server`; serveNode
    // never configures http2, so narrow to the `http.Server` Socket.IO attaches
    // to (`maxRequestsPerSocket` exists on http.Server, not http2.Server).
    const nodeServer = server.node?.server;
    if (!nodeServer || !('maxRequestsPerSocket' in nodeServer)) {
      throw new Error(
        '[stitchkit] serveNode: expected a node:http.Server for Socket.IO (none / http2).',
      );
    }
    socket.attach(nodeServer);
  }

  const listenUrl = server.url ?? `http://${hostname ?? 'localhost'}:${port}`;
  const resolvedPort = Number(new URL(listenUrl).port) || port;
  const resolvedHost = hostname ?? 'localhost';

  return {
    url: `http://${resolvedHost}:${resolvedPort}`,
    port: resolvedPort,
    close: (closeActive) => server.close(closeActive),
  };
}
