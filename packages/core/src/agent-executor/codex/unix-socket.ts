import { createHash, randomBytes } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import { abortReason } from '../../internal/abort-race';
import { assertTimerMs, withSignalDeadline } from '../../internal/deadline';
import { errnoOf } from '../../internal/errno';
import { assertPositiveSafeInteger } from '../../internal/positive-integer';
import {
  assertCodexUnixSocketClientTarget,
  CodexUnixSocketError,
  type CodexUnixSocketErrorKind,
  validateCodexUnixSocketPath,
} from './unix-socket-target';
import {
  createWsFrameDecoder,
  encodeMaskedWsFrame,
  maskedWsFrameByteLength,
} from './ws-frame';

export {
  assertCodexUnixSocketClientTarget,
  CodexUnixSocketError,
  type CodexUnixSocketErrorKind,
  validateCodexUnixSocketPath,
};

const WS_MAGIC_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_HANDSHAKE_HEADER_BYTES = 64 * 1024;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_PENDING_WRITE_BYTES = 16 * 1024 * 1024;
const CLOSE_GRACE_MS = 250;

/** Active RFC 6455 WebSocket-over-Unix-socket connection to a Codex app-server. */
export interface CodexUnixSocketClient {
  /** Send one masked UTF-8 text frame; throws `RangeError` if outbound queue limit would be exceeded. */
  send(text: string): void;
  /** Gracefully close the client socket (never terminates an external server). */
  close(): Promise<void>;
  /** Resolves once the client socket has fully closed. */
  readonly closed: Promise<void>;
}

function validateHandshakeResponse(
  headerText: string,
  expectedAccept: string,
  socketPath: string,
): void {
  const lines = headerText.split('\r\n');
  const statusLine = lines[0] ?? '';
  if (!/^HTTP\/1\.1 101(?:\s|$)/.test(statusLine)) {
    throw new CodexUnixSocketError(
      'upgrade-refused',
      socketPath,
      `Codex Unix socket WebSocket upgrade failed: ${statusLine || 'empty response'}`,
    );
  }
  const headers = new Map<string, string>();
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.length === 0) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) {
      throw new CodexUnixSocketError(
        'upgrade-refused',
        socketPath,
        'Codex Unix socket upgrade response contained a malformed HTTP header line',
      );
    }
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    const existing = headers.get(key);
    headers.set(key, existing === undefined ? value : `${existing}, ${value}`);
  }
  if ((headers.get('upgrade') ?? '').toLowerCase() !== 'websocket') {
    throw new CodexUnixSocketError(
      'upgrade-refused',
      socketPath,
      'Codex Unix socket upgrade response missing "Upgrade: websocket" header',
    );
  }
  const connectionTokens = (headers.get('connection') ?? '')
    .toLowerCase()
    .split(',')
    .map((token) => token.trim());
  if (!connectionTokens.includes('upgrade')) {
    throw new CodexUnixSocketError(
      'upgrade-refused',
      socketPath,
      'Codex Unix socket upgrade response missing "Connection: upgrade" header',
    );
  }
  if (headers.get('sec-websocket-accept') !== expectedAccept) {
    throw new CodexUnixSocketError(
      'upgrade-refused',
      socketPath,
      'Codex Unix socket upgrade response returned an invalid Sec-WebSocket-Accept header',
    );
  }
}

function classifyConnectError(error: unknown, socketPath: string): CodexUnixSocketError {
  const code = errnoOf(error);
  if (code === 'ENOENT') {
    return new CodexUnixSocketError(
      'endpoint-absent',
      socketPath,
      `Codex Unix socket "${socketPath}" does not exist`,
      { cause: error },
    );
  }
  if (code === 'ECONNREFUSED') {
    return new CodexUnixSocketError(
      'endpoint-not-listening',
      socketPath,
      `Codex Unix socket "${socketPath}" refused connection`,
      { cause: error },
    );
  }
  return new CodexUnixSocketError(
    'connection-lost',
    socketPath,
    `Failed to connect to Codex Unix socket "${socketPath}": ${error instanceof Error ? error.message : String(error)}`,
    { cause: error },
  );
}

function performWsUpgrade(input: {
  socketPath: string;
  signal: AbortSignal;
  handshakeTimeoutMs: number;
}): Promise<{ socket: Socket; trailing: Buffer }> {
  const wsKey = randomBytes(16).toString('base64');
  const expectedAccept = createHash('sha1')
    .update(`${wsKey}${WS_MAGIC_GUID}`)
    .digest('base64');

  return withSignalDeadline(
    input.handshakeTimeoutMs,
    input.signal,
    () =>
      new CodexUnixSocketError(
        'upgrade-refused',
        input.socketPath,
        `Codex Unix socket WebSocket handshake timed out after ${input.handshakeTimeoutMs} ms`,
      ),
    (handshakeSignal) =>
      new Promise<{ socket: Socket; trailing: Buffer }>((resolve, reject) => {
        let settled = false;
        let handshakeBuf: Buffer = Buffer.alloc(0);
        const sock = createConnection({ path: input.socketPath });
        const cleanup = () => {
          handshakeSignal.removeEventListener('abort', onAbort);
          sock.off('connect', onConnect);
          sock.off('data', onData);
          sock.off('error', onError);
          sock.off('close', onClose);
        };
        const fail = (error: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          sock.destroy();
          reject(error);
        };
        const onAbort = () => fail(abortReason(handshakeSignal));
        const onConnect = () => {
          sock.write(
            `GET /rpc HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${wsKey}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
          );
        };
        const onData = (chunk: Buffer) => {
          // Refuse oversized upgrade headers even before concatenating unbounded chunks.
          const combinedLen = handshakeBuf.byteLength + chunk.byteLength;
          if (handshakeBuf.byteLength > MAX_HANDSHAKE_HEADER_BYTES) {
            fail(
              new CodexUnixSocketError(
                'upgrade-refused',
                input.socketPath,
                `Codex Unix socket upgrade headers exceeded ${MAX_HANDSHAKE_HEADER_BYTES} bytes`,
              ),
            );
            return;
          }
          const nextBuf =
            handshakeBuf.byteLength === 0 ? chunk : Buffer.concat([handshakeBuf, chunk]);
          const boundary = nextBuf.indexOf('\r\n\r\n');
          if (boundary === -1) {
            if (combinedLen > MAX_HANDSHAKE_HEADER_BYTES) {
              fail(
                new CodexUnixSocketError(
                  'upgrade-refused',
                  input.socketPath,
                  `Codex Unix socket upgrade headers exceeded ${MAX_HANDSHAKE_HEADER_BYTES} bytes`,
                ),
              );
              return;
            }
            handshakeBuf = nextBuf;
            return;
          }
          if (boundary > MAX_HANDSHAKE_HEADER_BYTES) {
            fail(
              new CodexUnixSocketError(
                'upgrade-refused',
                input.socketPath,
                `Codex Unix socket upgrade headers exceeded ${MAX_HANDSHAKE_HEADER_BYTES} bytes`,
              ),
            );
            return;
          }
          const headerText = nextBuf.subarray(0, boundary).toString('latin1');
          const rest = Buffer.from(nextBuf.subarray(boundary + 4));
          try {
            validateHandshakeResponse(headerText, expectedAccept, input.socketPath);
          } catch (error) {
            fail(error);
            return;
          }
          settled = true;
          sock.pause();
          cleanup();
          resolve({ socket: sock, trailing: rest });
        };
        const onError = (error: Error) => fail(classifyConnectError(error, input.socketPath));
        const onClose = () =>
          fail(
            new CodexUnixSocketError(
              'upgrade-refused',
              input.socketPath,
              'Codex Unix socket closed before completing WebSocket upgrade',
            ),
          );
        handshakeSignal.addEventListener('abort', onAbort, { once: true });
        sock.once('connect', onConnect);
        sock.on('data', onData);
        sock.once('error', onError);
        sock.once('close', onClose);
      }),
  );
}

/** Dial a Codex app-server Unix domain socket and perform the RFC 6455 `/rpc` WebSocket handshake. */
export async function connectCodexUnixSocket(input: {
  socketPath: string;
  expectedOwnerUid?: number;
  /** Long-lived signal controlling the established WebSocket connection lifetime. */
  signal: AbortSignal;
  /** Optional shorter signal bounding only the connect + HTTP upgrade handshake. */
  connectSignal?: AbortSignal;
  handshakeTimeoutMs?: number;
  maxFrameBytes?: number;
  maxPendingWriteBytes?: number;
  onMessage(text: string): void;
  onClose(error: Error): void;
}): Promise<CodexUnixSocketClient> {
  validateCodexUnixSocketPath(input.socketPath, 'connectCodexUnixSocket');
  assertTimerMs('handshakeTimeoutMs', input.handshakeTimeoutMs);
  assertPositiveSafeInteger('maxFrameBytes', input.maxFrameBytes);
  assertPositiveSafeInteger('maxPendingWriteBytes', input.maxPendingWriteBytes);
  input.signal.throwIfAborted();
  input.connectSignal?.throwIfAborted();

  const targetState = assertCodexUnixSocketClientTarget(
    input.socketPath,
    'connectCodexUnixSocket',
    input.expectedOwnerUid,
  );
  if (targetState === 'absent') {
    throw new CodexUnixSocketError(
      'endpoint-absent',
      input.socketPath,
      `Codex Unix socket "${input.socketPath}" does not exist`,
    );
  }

  const maxFrameBytes = input.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const maxPendingWriteBytes = input.maxPendingWriteBytes ?? DEFAULT_MAX_PENDING_WRITE_BYTES;
  const { socket, trailing } = await performWsUpgrade({
    socketPath: input.socketPath,
    signal: input.connectSignal ?? input.signal,
    handshakeTimeoutMs: input.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
  });

  if (input.signal.aborted) {
    socket.destroy();
    throw abortReason(input.signal);
  }
  if (socket.destroyed) {
    throw new CodexUnixSocketError(
      'connection-lost',
      input.socketPath,
      `Codex Unix socket "${input.socketPath}" closed during WebSocket upgrade`,
    );
  }

  let closed = false;
  let closeSent = false;
  const closedDeferred = Promise.withResolvers<void>();

  const finishClosed = (error: Error) => {
    if (closed) return;
    closed = true;
    input.signal.removeEventListener('abort', onSignalAbort);
    closedDeferred.resolve();
    input.onClose(error);
  };

  const sendControlFrame = (opcode: number, payload: Uint8Array) => {
    if (closed || socket.destroyed || !socket.writable) return;
    const frameBytes = maskedWsFrameByteLength(payload.byteLength);
    if (socket.writableLength + frameBytes > maxPendingWriteBytes) return;
    socket.write(encodeMaskedWsFrame(opcode, payload));
  };

  const closeGracefully = async (): Promise<void> => {
    if (closed) return closedDeferred.promise;
    if (!closeSent && socket.writable && !socket.destroyed) {
      closeSent = true;
      const closeBody = Buffer.allocUnsafe(2);
      closeBody.writeUInt16BE(1000, 0);
      try {
        sendControlFrame(0x8, closeBody);
      } catch {
        // Ignore write error while closing.
      }
      socket.end();
    }
    const grace = setTimeout(() => {
      if (!socket.destroyed) socket.destroy();
    }, CLOSE_GRACE_MS);
    grace.unref?.();
    try {
      await closedDeferred.promise;
    } finally {
      clearTimeout(grace);
    }
  };

  const onSignalAbort = () => {
    const err = new CodexUnixSocketError(
      'connection-lost',
      input.socketPath,
      'Codex Unix socket connection aborted',
      { cause: abortReason(input.signal) },
    );
    socket.destroy();
    finishClosed(err);
  };
  input.signal.addEventListener('abort', onSignalAbort, { once: true });

  const decoder = createWsFrameDecoder({
    maxFrameBytes,
    onMessage: input.onMessage,
    onPing: (payload) => sendControlFrame(0xa, payload),
    onClose: (code, reason) => {
      if (!closeSent) {
        closeSent = true;
        sendControlFrame(0x8, Buffer.alloc(0));
      }
      socket.end();
      const suffix = reason.length > 0 ? `: ${reason}` : '';
      finishClosed(
        new CodexUnixSocketError(
          'connection-lost',
          input.socketPath,
          `Codex Unix socket closed by peer (${code ?? 'no-code'})${suffix}`,
        ),
      );
    },
    onProtocolError: (message) => {
      const err = new CodexUnixSocketError('connection-lost', input.socketPath, message);
      socket.destroy();
      finishClosed(err);
    },
  });

  socket.on('data', (chunk: Buffer) => decoder.push(chunk));
  socket.on('error', (error: Error) => {
    finishClosed(
      new CodexUnixSocketError(
        'connection-lost',
        input.socketPath,
        `Codex Unix socket error: ${error.message}`,
        { cause: error },
      ),
    );
  });
  socket.on('close', () => {
    finishClosed(
      new CodexUnixSocketError(
        'connection-lost',
        input.socketPath,
        `Codex Unix socket "${input.socketPath}" closed`,
      ),
    );
  });

  if (trailing.byteLength > 0) decoder.push(trailing);
  if (!closed && !socket.destroyed) socket.resume();

  return {
    send(text) {
      if (closed || socket.destroyed || !socket.writable) {
        throw new CodexUnixSocketError(
          'connection-lost',
          input.socketPath,
          'Codex Unix socket connection is closed',
        );
      }
      const payloadBytes = Buffer.byteLength(text, 'utf8');
      const frameBytes = maskedWsFrameByteLength(payloadBytes);
      if (socket.writableLength + frameBytes > maxPendingWriteBytes) {
        throw new RangeError(
          `Codex Unix socket outbound queue exceeded ${maxPendingWriteBytes} bytes (${frameBytes} bytes needed)`,
        );
      }
      socket.write(encodeMaskedWsFrame(0x1, Buffer.from(text, 'utf8')));
    },
    close: () => closeGracefully(),
    closed: closedDeferred.promise,
  };
}
