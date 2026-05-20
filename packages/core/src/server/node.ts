import { serve } from 'srvx';
import { createHandler } from './create';
import type { HandlerConfig } from './types';

export interface NodeServerConfig extends HandlerConfig {
  port?: number;
  hostname?: string;
}

export interface NodeServerHandle {
  url: string;
  port: number;
  close(closeActive?: boolean): Promise<void>;
}

export async function serveNode(config: NodeServerConfig): Promise<NodeServerHandle> {
  const { port = 3000, hostname, ...handlerConfig } = config;
  const handler = createHandler(handlerConfig);

  const server = serve({ port, hostname, fetch: handler });
  await server.ready();

  const listenUrl = server.url ?? `http://${hostname ?? 'localhost'}:${port}`;
  const resolvedPort = Number(new URL(listenUrl).port) || port;
  const resolvedHost = hostname ?? 'localhost';

  return {
    url: `http://${resolvedHost}:${resolvedPort}`,
    port: resolvedPort,
    close: (closeActive) => server.close(closeActive),
  };
}
