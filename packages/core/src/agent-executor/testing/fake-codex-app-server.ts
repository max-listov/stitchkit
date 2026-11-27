import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { assertPositiveSafeInteger } from '../../internal/positive-integer';
import { isRecord } from '../../internal/typed';
import {
  assertPrivateUnixSocketDirectory,
  bindUnixSocket,
  type UnixSocketInode,
  unlinkUnixSocketIfMatching,
} from '../../internal/unix-socket';
import { validateCodexUnixSocketPath } from '../codex/unix-socket-target';
import { createWsFrameDecoder, encodeUnmaskedWsFrame } from '../codex/ws-frame';
import {
  JSON_RPC_METHOD_NOT_FOUND,
  JsonRpcError,
  type JsonRpcValue,
  JsonRpcValueSchema,
} from '../json-rpc-peer';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_UPGRADE_HEADER_BYTES = 64 * 1024;
const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;
const DEFAULT_USER_AGENT = 'codex/0.171.0';
const JSON_RPC_INTERNAL_ERROR = -32603;

/** One JSON-RPC request recorded in arrival order by {@link FakeCodexAppServer}. */
export interface RecordedJsonRpcRequest {
  /** Wire JSON-RPC request identifier. */
  readonly id: string | number;
  /** JSON-RPC method name requested by the client. */
  readonly method: string;
  /** Optional request params payload. */
  readonly params?: JsonRpcValue | undefined;
}

/** Explicit JSON-RPC error object returned by a {@link FakeCodexRpcHandler}. */
export interface FakeCodexRpcErrorOutcome {
  readonly error: {
    readonly code: number;
    readonly message: string;
    readonly data?: JsonRpcValue | undefined;
  };
}

/** Return value accepted from a {@link FakeCodexRpcHandler}: JSON/DTO payload, explicit RPC error, or `'hang'` to omit any reply. */
export type FakeCodexRpcHandlerOutcome =
  | JsonRpcValue
  | Readonly<Record<string, unknown>>
  | FakeCodexRpcErrorOutcome
  | 'hang';

/** Handler for one client JSON-RPC method on {@link FakeCodexAppServer}. */
export type FakeCodexRpcHandler = (
  params: JsonRpcValue | undefined,
  request: RecordedJsonRpcRequest,
) => Promise<FakeCodexRpcHandlerOutcome> | FakeCodexRpcHandlerOutcome;

/** Configuration for {@link createFakeCodexAppServer}. */
export interface FakeCodexAppServerConfig {
  /** Absolute Unix domain socket path inside a private (`0o700`) directory. */
  readonly socketPath: string;
  /** `userAgent` returned by the default `initialize` handler. Defaults to `'codex/0.171.0'`; pass explicit `undefined` to omit. */
  readonly userAgent?: string | undefined;
  /** Per-method JSON-RPC handlers overriding or extending the default `initialize` handshake. */
  readonly handlers?: Readonly<Record<string, FakeCodexRpcHandler>> | undefined;
  /** Maximum incoming WebSocket frame size in bytes. Default 16 MiB. */
  readonly maxFrameBytes?: number | undefined;
}

/** Running Unix-socket WebSocket JSON-RPC fake Codex app-server handle. */
export interface FakeCodexAppServer {
  /** Bound Unix domain socket path accepted by `createCodexDriver({ transport: { kind: 'unix-connect', socketPath } })`. */
  readonly socketPath: string;
  /** All JSON-RPC requests (with `id`) received from clients in order. */
  readonly requests: readonly RecordedJsonRpcRequest[];
  /** Push a JSON-RPC notification frame to the active client; throws if no client is connected. */
  sendNotification(
    method: string,
    params?: JsonRpcValue | Readonly<Record<string, unknown>>,
  ): void;
  /** Push a JSON-RPC server request to the active client and resolve with its reply; rejects on error or disconnect. */
  sendRequest(
    id: string | number,
    method: string,
    params?: JsonRpcValue | Readonly<Record<string, unknown>>,
  ): Promise<JsonRpcValue>;
  /** Push an arbitrary UTF-8 WebSocket text frame to the active client (for malformed JSON or oversize-frame tests). */
  sendRaw(text: string): void;
  /**
   * Drop all active client sockets without stopping the listening server (for `onDisconnect` and
   * reconnect tests). A server `error` after startup does the same and makes every later send
   * throw with that error as `cause`.
   */
  disconnect(): void;
  /** Stop the server, drop active sockets, and remove the bound socket file (idempotent). */
  close(): Promise<void>;
}

function isRpcErrorOutcome(value: unknown): value is FakeCodexRpcErrorOutcome {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== 'error') return false;
  const err = value.error;
  return isRecord(err) && typeof err.code === 'number' && typeof err.message === 'string';
}

function requestKey(id: string | number): string {
  return `${typeof id}:${String(id)}`;
}

function writeTextFrame(socket: Socket, text: string): void {
  socket.write(encodeUnmaskedWsFrame(0x1, Buffer.from(text, 'utf8')));
}

function extractUpgradeKey(headerBlock: string): string | undefined {
  for (const line of headerBlock.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    if (line.slice(0, colon).trim().toLowerCase() === 'sec-websocket-key') {
      const value = line.slice(colon + 1).trim();
      return value.length > 0 ? value : undefined;
    }
  }
  return undefined;
}

interface PendingServerRequest {
  readonly socket: Socket;
  readonly resolve: (value: JsonRpcValue) => void;
  readonly reject: (error: unknown) => void;
}

interface FakeCodexServerState {
  readonly config: FakeCodexAppServerConfig;
  readonly maxFrameBytes: number;
  readonly userAgent: string | undefined;
  readonly requests: RecordedJsonRpcRequest[];
  readonly activeSockets: Set<Socket>;
  readonly upgradedSockets: Set<Socket>;
  readonly pendingServerRequests: Map<string, PendingServerRequest>;
  latestClient: Socket | undefined;
}

function rejectPendingForSocket(
  state: FakeCodexServerState,
  socket: Socket,
  error: Error,
): void {
  for (const [key, entry] of [...state.pendingServerRequests]) {
    if (entry.socket !== socket) continue;
    state.pendingServerRequests.delete(key);
    entry.reject(error);
  }
}

function handleClientMessage(state: FakeCodexServerState, socket: Socket, text: string): void {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return;
  }
  if (!isRecord(raw)) return;
  const rawId = raw.id;
  const hasId = typeof rawId === 'string' || typeof rawId === 'number';
  const rawMethod = raw.method;
  const hasMethod = typeof rawMethod === 'string';

  if (hasId && !hasMethod) {
    const key = requestKey(rawId);
    const pending = state.pendingServerRequests.get(key);
    if (pending === undefined || pending.socket !== socket) return;
    state.pendingServerRequests.delete(key);
    if (isRecord(raw.error) && typeof raw.error.code === 'number') {
      const message = typeof raw.error.message === 'string' ? raw.error.message : 'RPC error';
      pending.reject(new JsonRpcError(raw.error.code, message, raw.error.data));
    } else {
      const parsedResult = JsonRpcValueSchema.safeParse(raw.result ?? null);
      pending.resolve(parsedResult.success ? parsedResult.data : null);
    }
    return;
  }

  if (!hasMethod || !hasId) return;

  const paramsParsed =
    raw.params === undefined ? undefined : JsonRpcValueSchema.safeParse(raw.params);
  const params = paramsParsed?.success ? paramsParsed.data : undefined;
  const recorded: RecordedJsonRpcRequest = {
    id: rawId,
    method: rawMethod,
    ...(params !== undefined && { params }),
  };
  state.requests.push(recorded);

  const handler = state.config.handlers?.[rawMethod];
  if (handler === undefined) {
    if (rawMethod === 'initialize') {
      const result = state.userAgent !== undefined ? { userAgent: state.userAgent } : {};
      writeTextFrame(socket, JSON.stringify({ id: rawId, result }));
      return;
    }
    writeTextFrame(
      socket,
      JSON.stringify({
        id: rawId,
        error: {
          code: JSON_RPC_METHOD_NOT_FOUND,
          message: `Fake Codex app-server has no handler for ${rawMethod}`,
        },
      }),
    );
    return;
  }

  void Promise.resolve()
    .then(() => handler(params, recorded))
    .then(
      (outcome) => {
        if (outcome === 'hang' || socket.destroyed || !state.upgradedSockets.has(socket))
          return;
        if (isRpcErrorOutcome(outcome)) {
          writeTextFrame(socket, JSON.stringify({ id: rawId, error: outcome.error }));
          return;
        }
        writeTextFrame(socket, JSON.stringify({ id: rawId, result: outcome }));
      },
      (error: unknown) => {
        if (socket.destroyed || !state.upgradedSockets.has(socket)) return;
        if (error instanceof JsonRpcError) {
          writeTextFrame(
            socket,
            JSON.stringify({
              id: rawId,
              error: {
                code: error.code,
                message: error.message,
                ...(error.data !== undefined && { data: error.data }),
              },
            }),
          );
          return;
        }
        writeTextFrame(
          socket,
          JSON.stringify({
            id: rawId,
            error: {
              code: JSON_RPC_INTERNAL_ERROR,
              message: error instanceof Error ? error.message : String(error),
            },
          }),
        );
      },
    );
}

function attachClientSocket(state: FakeCodexServerState, socket: Socket): void {
  state.activeSockets.add(socket);
  let upgradeBuffer: Buffer = Buffer.alloc(0);
  let decoder: ReturnType<typeof createWsFrameDecoder> | undefined;

  const detach = () => {
    state.activeSockets.delete(socket);
    state.upgradedSockets.delete(socket);
    if (state.latestClient === socket) {
      state.latestClient = [...state.upgradedSockets].at(-1);
    }
    rejectPendingForSocket(
      state,
      socket,
      new Error('Fake Codex app-server client disconnected'),
    );
  };
  socket.once('close', detach);
  socket.on('error', () => {
    socket.destroy();
  });
  socket.on('data', (chunk) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (decoder !== undefined) {
      decoder.push(buf);
      return;
    }
    upgradeBuffer = Buffer.concat([upgradeBuffer, buf]);
    const headerEnd = upgradeBuffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) {
      if (upgradeBuffer.byteLength > MAX_UPGRADE_HEADER_BYTES) socket.destroy();
      return;
    }
    if (headerEnd > MAX_UPGRADE_HEADER_BYTES) {
      socket.destroy();
      return;
    }
    const headerBlock = upgradeBuffer.subarray(0, headerEnd).toString('utf8');
    const trailing = upgradeBuffer.subarray(headerEnd + 4);
    upgradeBuffer = Buffer.alloc(0);
    const wsKey = extractUpgradeKey(headerBlock);
    if (wsKey === undefined) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    const accept = createHash('sha1').update(`${wsKey}${WS_GUID}`).digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    state.upgradedSockets.add(socket);
    state.latestClient = socket;
    decoder = createWsFrameDecoder({
      maxFrameBytes: state.maxFrameBytes,
      expectMasked: true,
      onMessage: (text) => handleClientMessage(state, socket, text),
      onPing: (payload) => {
        if (!socket.destroyed) socket.write(encodeUnmaskedWsFrame(0xa, payload));
      },
      onClose: () => {
        if (!socket.destroyed) {
          try {
            socket.write(encodeUnmaskedWsFrame(0x8, Buffer.alloc(0)));
          } catch {
            // Ignore write error while closing.
          }
          socket.destroy();
        }
      },
      onProtocolError: () => {
        socket.destroy();
      },
    });
    if (trailing.byteLength > 0) decoder.push(trailing);
  });
}

/**
 * Start a portable (Bun and Node.js) Unix-socket WebSocket JSON-RPC fake Codex app-server for
 * consumer integration tests with `createCodexDriver({ transport: { kind: 'unix-connect' } })`.
 */
export async function createFakeCodexAppServer(
  config: FakeCodexAppServerConfig,
): Promise<FakeCodexAppServer> {
  validateCodexUnixSocketPath(config.socketPath, 'createFakeCodexAppServer');
  assertPrivateUnixSocketDirectory(config.socketPath, 'createFakeCodexAppServer');
  assertPositiveSafeInteger('maxFrameBytes', config.maxFrameBytes);

  const state: FakeCodexServerState = {
    config,
    maxFrameBytes: config.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
    userAgent: 'userAgent' in config ? config.userAgent : DEFAULT_USER_AGENT,
    requests: [],
    activeSockets: new Set<Socket>(),
    upgradedSockets: new Set<Socket>(),
    pendingServerRequests: new Map<string, PendingServerRequest>(),
    latestClient: undefined,
  };
  let closePromise: Promise<void> | undefined;

  const server = createServer((socket) => attachClientSocket(state, socket));
  let failed: Error | undefined;
  let startupFailed: ((error: Error) => void) | undefined;
  const listening = new Promise<void>((resolve, reject) => {
    startupFailed = reject;
    server.once('listening', resolve);
  });
  // One listener for the server's whole life: an `error` event nobody listens to is thrown.
  server.on('error', (error) => {
    if (startupFailed !== undefined) {
      startupFailed(error);
      return;
    }
    failed ??= error;
    for (const socket of [...state.activeSockets]) socket.destroy();
  });
  try {
    bindUnixSocket({ path: config.socketPath, mode: 0o600 }, (boundPath) =>
      server.listen(boundPath),
    );
  } catch (error) {
    listening.catch(() => undefined);
    server.close();
    throw error;
  }
  await listening;
  startupFailed = undefined;
  const boundStats = lstatSync(config.socketPath);
  const boundInode: UnixSocketInode = { dev: boundStats.dev, ino: boundStats.ino };

  const requireActiveClient = (caller: string): Socket => {
    if (failed !== undefined) {
      throw new Error(
        `[stitchkit] FakeCodexAppServer.${caller}: the server failed: ${failed.message}`,
        { cause: failed },
      );
    }
    if (state.latestClient === undefined || state.latestClient.destroyed) {
      throw new Error(`[stitchkit] FakeCodexAppServer.${caller}: no client is connected`);
    }
    return state.latestClient;
  };

  return {
    socketPath: config.socketPath,
    requests: state.requests,
    sendNotification(method, params) {
      const client = requireActiveClient('sendNotification');
      writeTextFrame(
        client,
        JSON.stringify({ method, ...(params !== undefined && { params }) }),
      );
    },
    async sendRequest(id, method, params) {
      const client = requireActiveClient('sendRequest');
      const key = requestKey(id);
      if (state.pendingServerRequests.has(key)) {
        throw new Error(
          `[stitchkit] FakeCodexAppServer.sendRequest: duplicate pending request id ${JSON.stringify(id)}`,
        );
      }
      return new Promise<JsonRpcValue>((resolve, reject) => {
        state.pendingServerRequests.set(key, { socket: client, resolve, reject });
        try {
          writeTextFrame(
            client,
            JSON.stringify({ id, method, ...(params !== undefined && { params }) }),
          );
        } catch (error) {
          state.pendingServerRequests.delete(key);
          reject(error);
        }
      });
    },
    sendRaw(text) {
      const client = requireActiveClient('sendRaw');
      writeTextFrame(client, text);
    },
    disconnect() {
      for (const socket of [...state.activeSockets]) {
        socket.destroy();
      }
    },
    close() {
      if (closePromise === undefined) {
        closePromise = (async () => {
          for (const socket of [...state.activeSockets]) {
            socket.destroy();
          }
          await new Promise<void>((resolve) => {
            server.close(() => resolve());
          });
          unlinkUnixSocketIfMatching(config.socketPath, boundInode);
        })();
      }
      return closePromise;
    },
  };
}
