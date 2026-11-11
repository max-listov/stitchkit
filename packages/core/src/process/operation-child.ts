/**
 * The child side of an operation executed in a process of its own: read one
 * call, run it against the application's services, write the answer.
 */
import type { z } from 'zod';
import { AppError } from '../contract/errors';
import { normalizeError } from '../contract/normalize';
import { safeJsonParse } from '../internal/safe-json';
import { isAsyncIterable } from '../internal/typed';
import {
  MAX_CALL_BYTES,
  OperationCallSchema,
  type OperationErrorSchema,
} from './operation-wire';

/**
 * What `runOperationProcess` reads of a service: `implement(contract, handlers)` fits. Stated
 * structurally because this part stands below the server part and cannot name its `ServiceDef`.
 */
export interface OperationProcessService {
  methods: Record<
    string,
    {
      serviceName: string;
      key: string;
      handler(context: {
        params: unknown;
        input: unknown;
        source: string;
        signal: AbortSignal;
      }): unknown;
    }
  >;
}

/** Where `runOperationProcess` reads its call, writes its answer and learns it must stop. */
export interface OperationProcessIo {
  /** The call. Default: all of `process.stdin`. */
  readCall?: () => Promise<string>;
  /** Default: `process.stdout`, awaited so a slow reader slows the handler. */
  write?: (text: string) => Promise<void>;
  /** Aborted when the server stops this process. Default: `SIGTERM` and `SIGINT`. */
  signal?: AbortSignal;
}

function childError(error: unknown): z.input<typeof OperationErrorSchema> {
  const normalized = normalizeError(error);
  return { ...normalized.toJSON().error, status: normalized.status };
}

function writeStdout(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(text, (error) => (error ? reject(error) : resolve()));
  });
}

async function readStdin(): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes: Uint8Array =
      typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk;
    size += bytes.byteLength;
    if (size > MAX_CALL_BYTES)
      throw new Error(`Operation call exceeds ${MAX_CALL_BYTES} bytes`);
    text += decoder.decode(bytes, { stream: true });
  }
  return text;
}

function stopSignal(): AbortSignal {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.once('SIGTERM', abort);
  process.once('SIGINT', abort);
  return controller.signal;
}

/**
 * The child side: read one call from stdin, run it against `services`, write
 * the answer. Returns the process exit code — `0` whenever an answer was
 * written, a refusal included, because a refusal is an answer.
 *
 * The call arrives already validated: the server parsed `params` and `input`
 * through the operation's schemas before it started this process, and it
 * validates the answer against the output schema after. Both cross the process
 * boundary as JSON, so a schema whose parsed value JSON cannot carry — a
 * `Date`, a `Map`, a `bigint` — cannot be an input or an output here.
 */
export async function runOperationProcess(
  services: readonly OperationProcessService[],
  io: OperationProcessIo = {},
): Promise<number> {
  const write = io.write ?? writeStdout;
  const signal = io.signal ?? stopSignal();
  const call = OperationCallSchema.parse(safeJsonParse(await (io.readCall ?? readStdin)()));
  const method = services
    .flatMap((service) => Object.values(service.methods))
    .find((candidate) => `${candidate.serviceName}.${candidate.key}` === call.operation);
  const context = () => {
    if (!method) {
      throw new AppError('UNKNOWN_OPERATION', {
        message: `No operation "${call.operation}" in this process`,
        status: 404,
        details: { operation: call.operation },
      });
    }
    return {
      method,
      context: {
        // Already parsed by the server that admitted the call. Parsing again
        // would run every transform twice and refuse its own earlier output.
        params: call.params,
        input: call.input,
        source: 'process',
        signal,
      },
    };
  };
  if (call.kind === 'unary') {
    try {
      const resolved = context();
      const data: unknown = await resolved.method.handler(resolved.context);
      await write(`${JSON.stringify({ ok: true, data })}\n`);
    } catch (error) {
      await write(`${JSON.stringify({ ok: false, error: childError(error) })}\n`);
    }
    return 0;
  }
  try {
    const resolved = context();
    const source: unknown = await resolved.method.handler(resolved.context);
    if (!isAsyncIterable(source)) {
      throw new Error(`Operation "${call.operation}" did not return an async iterable`);
    }
    for await (const item of source) {
      if (signal.aborted) return 0;
      await write(`${JSON.stringify({ type: 'data', data: item })}\n`);
    }
    // A stream that was stopped did not complete: it writes no end frame.
    if (signal.aborted) return 0;
    await write(`${JSON.stringify({ type: 'end' })}\n`);
  } catch (error) {
    if (signal.aborted) return 0;
    await write(`${JSON.stringify({ type: 'error', error: childError(error) })}\n`);
  }
  return 0;
}
