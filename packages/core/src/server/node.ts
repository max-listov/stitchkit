import type { Server as HttpServer, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { serve } from 'srvx/node';
import { isFetchBlockedPort } from '../internal/fetch-port';
import { createHandler } from './create';
import {
  createServerLifecycle,
  type ManagedServerHandle,
  type ShutdownAdapter,
} from './shutdown';
import type { FetchComposition, HandlerConfig } from './types';

export interface NodeSocketLifecycle {
  attach(server: HttpServer): void;
  beginShutdown(): void;
  close(): Promise<void>;
  connections(): number;
}

export interface NodeServerConfig extends HandlerConfig, FetchComposition {
  port?: number;
  hostname?: string;
  /** A full Socket.IO lifecycle from `createSocketIOServer`. */
  socket?: NodeSocketLifecycle;
}

export type NodeRuntimeServer = ReturnType<typeof serve>;
export type NodeServerHandle = ManagedServerHandle<NodeRuntimeServer>;

export async function serveNode(config: NodeServerConfig): Promise<NodeServerHandle> {
  const { port = 3000, hostname, socket, wrapFetch, ...handlerConfig } = config;
  const handler = createHandler(handlerConfig);

  let runtime: NodeRuntimeServer | undefined;
  let nodeServer: HttpServer | undefined;
  const sockets = new Set<Socket>();
  const upgradedSockets = new Set<Socket>();
  const responses = new Set<ServerResponse>();
  const socketDrainWaiters = new Set<() => void>();
  const resolveSocketDrain = () => {
    if (sockets.size !== 0) return;
    for (const resolve of socketDrainWaiters) resolve();
    socketDrainWaiters.clear();
  };
  const waitForSocketDrain = () => {
    if (sockets.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => socketDrainWaiters.add(resolve));
  };
  const waitForUpgradedSocketDrain = () => {
    if (upgradedSockets.size === 0) return Promise.resolve();
    return Promise.all(
      [...upgradedSockets].map(
        (activeSocket) =>
          new Promise<void>((resolve) => {
            if (activeSocket.closed) resolve();
            else activeSocket.once('close', () => resolve());
          }),
      ),
    ).then(() => undefined);
  };
  const requireRuntime = (): NodeRuntimeServer => {
    if (!runtime) throw new Error('[stitchkit] Node server lifecycle started before srvx');
    return runtime;
  };
  const requireNodeServer = (): HttpServer => {
    if (!nodeServer) throw new Error('[stitchkit] Node HTTP server is unavailable');
    return nodeServer;
  };

  const adapter: ShutdownAdapter = {
    beginShutdown: () => socket?.beginShutdown(),
    pendingRequests: () => responses.size,
    // Engine.IO drops clientsCount when it initiates close, before the upgraded
    // TCP socket has necessarily emitted `close`. The physical set is the
    // lifecycle truth on Node.
    pendingWebSockets: () => upgradedSockets.size,
    closeRealtime: () => socket?.close() ?? Promise.resolve(),
    async terminateRealtime() {
      const count = upgradedSockets.size;
      const physicalClose = waitForUpgradedSocketDrain();
      for (const activeSocket of [...upgradedSockets]) activeSocket.destroy();
      await physicalClose;
      return count;
    },
    async stopGracefully() {
      const runtimeClose = socket ? Promise.resolve() : requireRuntime().close(false);
      // Once listener close has begun, proactively close idle keep-alive
      // connections. They carry no response work and otherwise can outlive the
      // managed result even though all application work is complete.
      requireNodeServer().closeIdleConnections?.();
      await runtimeClose;
      // Socket.IO owns http.Server.close() when attached. Node's close callback
      // does not wait for upgraded connections, so always wait for the tracked
      // transport sockets as a separate physical completion barrier.
      await waitForSocketDrain();
    },
    async forceStop() {
      const activeServer = requireNodeServer();
      const logicalClose = socket?.close();
      const physicalClosures = [...sockets].map(
        (activeSocket) =>
          new Promise<void>((resolve) => {
            if (activeSocket.closed) resolve();
            else activeSocket.once('close', () => resolve());
          }),
      );
      activeServer.closeAllConnections?.();
      for (const activeSocket of sockets) activeSocket.destroy();
      if (logicalClose) await logicalClose;
      else await requireRuntime().close(true);
      await Promise.all(physicalClosures);
      // A force result is emitted only after every tracked transport socket is
      // closed. Some runtimes do not emit ServerResponse.close after destroy;
      // the at-force snapshot already preserves those aborted responses.
      responses.clear();
    },
  };
  const lifecycle = createServerLifecycle(() => adapter);
  const consumerFetch = wrapFetch ? wrapFetch(handler) : handler;
  const fetch = lifecycle.wrapFetch(consumerFetch);

  // The kernel may assign a WHATWG Fetch-blocked port (4045 is one real
  // example) even though it is a perfectly valid free TCP port. Reject only
  // those port-0 allocations before attaching provider lifecycles or exposing
  // the handle; explicit consumer ports remain consumer-owned configuration.
  for (;;) {
    runtime = serve({ port, hostname, fetch, gracefulShutdown: false });
    await runtime.ready();

    const candidate = runtime.node?.server;
    if (!candidate || !('maxRequestsPerSocket' in candidate)) {
      await runtime.close(true);
      throw new Error(
        '[stitchkit] serveNode: expected a node:http.Server for the managed lifecycle.',
      );
    }

    const candidateUrl = runtime.url ?? `http://${hostname ?? 'localhost'}:${port}`;
    const candidatePort = Number(new URL(candidateUrl).port) || port;
    if (port === 0 && isFetchBlockedPort(candidatePort)) {
      await runtime.close(true);
      continue;
    }

    nodeServer = candidate;
    break;
  }
  nodeServer.on('connection', (activeSocket) => {
    sockets.add(activeSocket);
    activeSocket.once('close', () => {
      sockets.delete(activeSocket);
      upgradedSockets.delete(activeSocket);
      resolveSocketDrain();
    });
  });
  nodeServer.on('upgrade', (request) => upgradedSockets.add(request.socket));
  nodeServer.prependListener('request', (_request, response) => {
    responses.add(response);
    const complete = () => responses.delete(response);
    response.once('finish', complete);
    response.once('close', complete);
  });

  socket?.attach(nodeServer);

  const listenUrl = runtime.url ?? `http://${hostname ?? 'localhost'}:${port}`;
  const resolvedPort = Number(new URL(listenUrl).port) || port;
  const resolvedHost = hostname ?? 'localhost';
  const server = runtime;

  return {
    url: `http://${resolvedHost}:${resolvedPort}`,
    port: resolvedPort,
    runtime: server,
    get status() {
      return lifecycle.status;
    },
    shutdown: lifecycle.shutdown,
  };
}
