import { z } from 'zod';
import { abortReason } from '../internal/abort-race';
import { assertTimerMs } from '../internal/deadline';

/**
 * Whether the dialect writes `"jsonrpc": "2.0"`. ACP requires it; Codex's
 * app-server omits it. Reading accepts either, writing follows the dialect.
 */
export type JsonRpcHeader = 'jsonrpc-2.0' | 'omitted';

/** Zod schema accepting any valid JSON value carried over JSON-RPC. */
export const JsonRpcValueSchema = z.json();

/** Zod schema accepting a plain JSON object whose values are valid JSON-RPC values. */
export const JsonRpcRecordSchema = z.record(z.string(), JsonRpcValueSchema);

/** A JSON value as a request, a notification or an answer carries it. */
export type JsonRpcValue = z.infer<typeof JsonRpcValueSchema>;

const IdSchema = z.union([z.string(), z.int()]);
const MessageSchema = z.looseObject({
  jsonrpc: z.literal('2.0').optional(),
  id: IdSchema.optional(),
  method: z.string().optional(),
  params: JsonRpcValueSchema.optional(),
  result: JsonRpcValueSchema.optional(),
  error: z
    .looseObject({ code: z.int(), message: z.string(), data: JsonRpcValueSchema.optional() })
    .optional(),
});

/** An error the peer answered a request with, by its code. */
export class JsonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'JsonRpcError';
  }
}

/** Standard JSON-RPC 2.0 error code (`-32601`) returned for unhandled methods. */
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
/** Local client-side timeout code, distinct from ACP `-32000` (`AUTH_REQUIRED`). */
export const JSON_RPC_LOCAL_TIMEOUT = -32099;
const JSON_RPC_INTERNAL_ERROR = -32603;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return 'Internal error';
  }
}

function parseJsonValue(
  value: unknown,
): { ok: true; value: JsonRpcValue } | { ok: false; message: string } {
  try {
    const parsed = z.json().safeParse(value);
    if (!parsed.success) {
      return { ok: false, message: 'JSON-RPC payload is not valid JSON' };
    }
    // `z.json()` accepts cyclic plain objects, so verify serialization before transport.
    JSON.stringify(parsed.data);
    return { ok: true, value: parsed.data };
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
}

function buildAnswerPayload(
  id: string | number,
  outcome: { result: unknown } | { error: JsonRpcError },
): Record<string, JsonRpcValue> {
  if ('result' in outcome) {
    const checked = parseJsonValue(outcome.result);
    if (!checked.ok) {
      return { id, error: { code: JSON_RPC_INTERNAL_ERROR, message: checked.message } };
    }
    return { id, result: checked.value };
  }
  const code = Number.isSafeInteger(outcome.error.code)
    ? outcome.error.code
    : JSON_RPC_INTERNAL_ERROR;
  const message =
    typeof outcome.error.message === 'string' ? outcome.error.message : 'Internal error';
  if (outcome.error.data === undefined) {
    return { id, error: { code, message } };
  }
  const checked = parseJsonValue(outcome.error.data);
  if (!checked.ok) {
    return { id, error: { code: JSON_RPC_INTERNAL_ERROR, message: checked.message } };
  }
  return { id, error: { code, message, data: checked.value } };
}

/** Configuration options for `createJsonRpcPeer`. */
export interface JsonRpcPeerConfig {
  header: JsonRpcHeader;
  /** Write one line to the other side. */
  send(line: string): void;
  /** How long a request waits for its answer before it fails. */
  requestTimeoutMs: number;
  /** A request from the other side. Throw a `JsonRpcError` to answer with its code; no handler answers `-32601`. */
  onRequest?:
    | ((
        method: string,
        params: JsonRpcValue | undefined,
        id: string | number,
      ) => Promise<JsonRpcValue> | JsonRpcValue)
    | undefined;
  onNotification?: ((method: string, params: JsonRpcValue | undefined) => void) | undefined;
}

/**
 * A bidirectional JSON-RPC peer over a line stream: requests both ways,
 * notifications both ways, each request answered or timed out, and a request
 * it has no handler for answered `-32601` at once — an unanswered server
 * request is what leaves an engine's turn hanging.
 */
export function createJsonRpcPeer(config: JsonRpcPeerConfig) {
  assertTimerMs('requestTimeoutMs', config.requestTimeoutMs, { absent: 'refused' });
  let nextId = 1;
  let closedBy: unknown;
  let closed = false;
  const pending = new Map<
    string | number,
    {
      resolve(value: JsonRpcValue): void;
      reject(error: unknown): void;
      cleanup(): void;
    }
  >();
  const header = config.header === 'jsonrpc-2.0' ? { jsonrpc: '2.0' } : {};
  const write = (message: Record<string, JsonRpcValue>) =>
    config.send(JSON.stringify({ ...header, ...message }));
  const sendResponse = (message: Record<string, JsonRpcValue>): void => {
    if (closed) return;
    const line = JSON.stringify({ ...header, ...message });
    try {
      config.send(line);
    } catch {
      // Transport failure on a reply must not recurse or emit an unhandled rejection.
    }
  };
  const answer = (
    id: string | number,
    outcome: { result: unknown } | { error: JsonRpcError },
  ): void => {
    if (closed) return;
    sendResponse(buildAnswerPayload(id, outcome));
  };

  return {
    request(
      method: string,
      params?: JsonRpcValue,
      options?: {
        readonly timeoutMs?: number | null | undefined;
        readonly signal?: AbortSignal | undefined;
      },
    ): Promise<JsonRpcValue> {
      const timeoutMs =
        options?.timeoutMs === undefined ? config.requestTimeoutMs : options.timeoutMs;
      if (timeoutMs !== null) {
        try {
          assertTimerMs('timeoutMs', timeoutMs);
        } catch (error) {
          return Promise.reject(error);
        }
      }
      const signal = options?.signal;
      if (signal?.aborted) return Promise.reject(abortReason(signal));
      // Nothing reads the stream any more: a request would wait for an answer that cannot come.
      if (closed) return Promise.reject(closedBy);
      const id = nextId++;
      return new Promise<JsonRpcValue>((resolve, reject) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onAbort = (): void => {
          if (settled) return;
          settled = true;
          cleanup();
          pending.delete(id);
          if (signal !== undefined) reject(abortReason(signal));
        };
        const cleanup = (): void => {
          if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
          }
          signal?.removeEventListener('abort', onAbort);
        };
        if (timeoutMs !== null) {
          timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            cleanup();
            pending.delete(id);
            reject(
              new JsonRpcError(
                JSON_RPC_LOCAL_TIMEOUT,
                `${method} had no answer within ${timeoutMs} ms`,
              ),
            );
          }, timeoutMs);
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        pending.set(id, {
          resolve: (value) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(value);
          },
          reject: (error) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
          },
          cleanup,
        });
        try {
          write({ id, method, ...(params !== undefined && { params }) });
        } catch (error) {
          if (!settled) {
            settled = true;
            cleanup();
            pending.delete(id);
            reject(error);
          }
        }
      });
    },
    notify(method: string, params?: JsonRpcValue): void {
      if (closed) return;
      write({ method, ...(params !== undefined && { params }) });
    },
    /** Feed one line from the other side. A line that is not JSON-RPC is an error the caller reports. */
    receive(line: string): void {
      if (closed) return;
      const message = MessageSchema.parse(JSON.parse(line));
      if (message.method !== undefined && message.id !== undefined) {
        const id = message.id;
        const method = message.method;
        const onRequest = config.onRequest;
        if (onRequest === undefined) {
          answer(id, {
            error: new JsonRpcError(JSON_RPC_METHOD_NOT_FOUND, `${method} is not handled`),
          });
          return;
        }
        // Dispatch in wire order. A later resolution or terminal notification may arrive
        // in the same batch while the host is still deciding how to answer this request.
        void new Promise<JsonRpcValue>((resolve) =>
          resolve(onRequest(method, message.params, id)),
        ).then(
          (result) => answer(id, { result }),
          (error: unknown) =>
            answer(id, {
              error:
                error instanceof JsonRpcError
                  ? error
                  : new JsonRpcError(JSON_RPC_INTERNAL_ERROR, errorMessage(error)),
            }),
        );
        return;
      }
      if (message.method !== undefined) {
        config.onNotification?.(message.method, message.params);
        return;
      }
      if (message.id === undefined)
        throw new TypeError('A JSON-RPC message without id or method');
      const waiter = pending.get(message.id);
      if (waiter === undefined) return;
      pending.delete(message.id);
      if (message.error !== undefined) {
        waiter.reject(
          new JsonRpcError(message.error.code, message.error.message, message.error.data),
        );
      } else {
        waiter.resolve(message.result ?? null);
      }
    },
    /** Fail every request still waiting: the stream ended. */
    close(reason?: unknown): void {
      if (closed) return;
      closed = true;
      closedBy = reason;
      for (const [id, waiter] of pending) {
        pending.delete(id);
        waiter.reject(reason);
      }
    },
  };
}

/** Bidirectional JSON-RPC peer handle returned by `createJsonRpcPeer`. */
export type JsonRpcPeer = ReturnType<typeof createJsonRpcPeer>;
