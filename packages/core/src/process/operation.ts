/**
 * A contract operation executed in a process of its own.
 *
 * A handler that reads gigabytes holds the server's event loop for as long as
 * it reads, and every cheap operation on that server waits behind it. Moving
 * the work to a child process keeps the loop free, and the mechanics around the
 * child are the same for every application: hand the validated call over, bound
 * what comes back, end the process when the caller leaves or the deadline
 * passes, and refuse — not queue — a call the machine has no room for.
 *
 * The server side is `createOperationProcesses`: its `unary` and `stream`
 * return ordinary contract handlers, so the operation is implemented, routed,
 * gated and validated exactly like one that runs in process. The child side is
 * `runOperationProcess`, fed the same `implement(contract, handlers)` services.
 */
import type { z } from 'zod';
import type { ContractDef, EndpointDef } from '../contract/define';
import { AppError } from '../contract/errors';
import { readBoundedUtf8Lines, StreamLineLimitError } from '../internal/bounded-lines';
import { assertPositiveSafeInteger } from '../internal/positive-integer';
import { safeJsonParse } from '../internal/safe-json';
import { isRecord, transportResult } from '../internal/typed';
import { runNativeCommand } from './command';
import { NativeCommandError, type NativeCommandOptions } from './contract';
import {
  MAX_CALL_BYTES,
  OperationAnswerSchema,
  type OperationCallSchema,
  type OperationErrorSchema,
  OperationFrameSchema,
} from './operation-wire';
import { type NativeCommandStream, streamNativeCommand } from './stream';

/** The child command of `createOperationProcesses` and the three bounds every call runs under. */
export interface OperationProcessesConfig {
  /**
   * The command that runs `runOperationProcess` — typically this application's
   * own executable with a private argument. One process is started per call.
   */
  command: Pick<
    NativeCommandOptions,
    'executable' | 'args' | 'cwd' | 'env' | 'envPolicy' | 'ownerLoss' | 'stop'
  >;
  /** Calls running at once. A call beyond it is refused with `OPERATION_BUSY`, never queued. */
  maxConcurrent: number;
  /**
   * Bytes one answer may take: the whole answer of a unary operation, one item
   * of a stream. More is refused with `OPERATION_RESPONSE_TOO_LARGE`.
   */
  maxResponseBytes: number;
  /** Deadline of one unary call, from process start. A stream lives until it ends or is cancelled. */
  timeoutMs: number;
}

/** What a handler built by `createOperationProcesses` reads of its call. */
export interface OperationCallContext {
  params?: unknown;
  input?: unknown;
  signal?: AbortSignal;
}

type OperationOutput<E> = E extends { output: z.ZodType<infer O> } ? O : undefined;
type OperationItem<E> = E extends { stream: { item: z.ZodType<infer I> } } ? I : never;
type StreamOperationKeys<T> = {
  [K in keyof T]: T[K] extends { stream: object } ? K : never;
}[keyof T];
type UnaryOperationKeys<T> = Exclude<keyof T, StreamOperationKeys<T>>;

/** The handlers `createOperationProcesses` builds, and how many calls run now. */
export interface OperationProcesses {
  /** The handler of one unary operation, executed in a process of its own. */
  unary<T extends Record<string, EndpointDef>, K extends UnaryOperationKeys<T> & string>(
    contract: ContractDef<T, string>,
    key: K,
  ): (context: OperationCallContext) => Promise<OperationOutput<T[K]>>;
  /** The handler of one streaming operation: items arrive as the process produces them. */
  stream<T extends Record<string, EndpointDef>, K extends StreamOperationKeys<T> & string>(
    contract: ContractDef<T, string>,
    key: K,
  ): (context: OperationCallContext) => AsyncIterable<OperationItem<T[K]>>;
  /** Calls running now. */
  readonly active: number;
}

function positive(name: string, value: number): number {
  assertPositiveSafeInteger(`createOperationProcesses: ${name}`, value);
  return value;
}

function tooLarge(operation: string, maxResponseBytes: number, cause: unknown): AppError {
  return new AppError('OPERATION_RESPONSE_TOO_LARGE', {
    message: `Operation "${operation}" answered more than its ${maxResponseBytes} byte limit`,
    status: 500,
    details: { operation, maxResponseBytes },
    retryable: false,
    cause,
  });
}

/** A failure of the process itself; the child's stderr stays in the cause, never in the answer. */
function processFailed(operation: string, cause: unknown): AppError {
  return new AppError('OPERATION_PROCESS_FAILED', {
    message: `Operation "${operation}" process failed`,
    status: 500,
    details: { operation },
    cause,
  });
}

function limitRefusal(operation: string, config: OperationProcessesConfig, error: unknown) {
  if (!(error instanceof NativeCommandError) || error.code !== 'COMMAND_LIMIT')
    return undefined;
  if (error.reason === 'output-budget') {
    return tooLarge(operation, config.maxResponseBytes, error);
  }
  if (error.reason === 'deadline') {
    return new AppError('REQUEST_TIMEOUT', {
      message: `Operation "${operation}" exceeded its ${config.timeoutMs} ms deadline`,
      status: 408,
      details: { operation },
      cause: error,
    });
  }
  return undefined;
}

function refusalFromChild(error: z.output<typeof OperationErrorSchema>): AppError {
  return new AppError(error.code, {
    message: error.message,
    status: error.status,
    details: isRecord(error.details) ? error.details : undefined,
    hint: error.hint,
    retryable: error.retryable,
  });
}

function encodeCall(call: z.input<typeof OperationCallSchema>): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(call));
  if (bytes.byteLength > MAX_CALL_BYTES) {
    throw new AppError('BAD_REQUEST', {
      message: `Operation "${call.operation}" call exceeds ${MAX_CALL_BYTES} bytes`,
      status: 413,
      details: { operation: call.operation, maxCallBytes: MAX_CALL_BYTES },
    });
  }
  return bytes;
}

function parseJson(text: string): unknown {
  try {
    return safeJsonParse(text);
  } catch (error) {
    throw new Error('Operation process wrote a line that is not JSON', { cause: error });
  }
}

/**
 * A pool of one-call processes for contract operations.
 *
 * It holds no process between calls: a call starts one, and the call's end —
 * its answer, its failure, the caller's abort, the deadline — ends that
 * process and its group. The pool is the count that bounds them.
 */
export function createOperationProcesses(
  config: OperationProcessesConfig,
): OperationProcesses {
  const maxConcurrent = positive('maxConcurrent', config.maxConcurrent);
  const maxResponseBytes = positive('maxResponseBytes', config.maxResponseBytes);
  const timeoutMs = positive('timeoutMs', config.timeoutMs);
  let active = 0;

  const acquire = (operation: string): (() => void) => {
    if (active >= maxConcurrent) {
      throw new AppError('OPERATION_BUSY', {
        message: `Operation "${operation}" has no free process (${maxConcurrent} running)`,
        status: 503,
        details: { operation, maxConcurrent },
        retryable: true,
      });
    }
    active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active -= 1;
    };
  };

  const runUnary = async (
    operation: string,
    context: OperationCallContext,
  ): Promise<unknown> => {
    const stdin = encodeCall({
      operation,
      kind: 'unary',
      params: context.params,
      input: context.input,
    });
    const release = acquire(operation);
    const answerBytes: Uint8Array[] = [];
    let answerSize = 0;
    const stderr = stderrTail();
    try {
      const result = await runNativeCommand({
        ...config.command,
        stdin,
        // The call was already admitted by the server's own body limit.
        maxStdinBytes: Math.max(stdin.byteLength, 1),
        // The answer is bounded on its own: a child that logs to stderr must
        // not spend the answer's budget.
        onOutput: (bytes, channel) => {
          if (channel === 'stderr') return stderr.push(bytes);
          answerSize += bytes.byteLength;
          if (answerSize > maxResponseBytes)
            throw tooLarge(operation, maxResponseBytes, undefined);
          answerBytes.push(Uint8Array.from(bytes));
        },
        timeoutMs,
        signal: context.signal,
      });
      const text = new TextDecoder().decode(Buffer.concat(answerBytes)).trim();
      if (result.exitCode !== 0 || text === '') {
        throw processFailed(
          operation,
          new Error(`exit ${result.exitCode ?? result.signal}: ${stderr.text()}`),
        );
      }
      const answer = OperationAnswerSchema.safeParse(parseJson(text));
      if (!answer.success) throw processFailed(operation, answer.error);
      if (!answer.data.ok) throw refusalFromChild(answer.data.error);
      return answer.data.data;
    } catch (error) {
      if (AppError.is(error)) throw error;
      const refusal = limitRefusal(operation, config, error);
      if (refusal) throw refusal;
      if (context.signal?.aborted) throw error;
      throw processFailed(operation, error);
    } finally {
      release();
    }
  };

  async function* runStream(
    operation: string,
    context: OperationCallContext,
  ): AsyncGenerator<unknown> {
    const release = acquire(operation);
    let command: NativeCommandStream | undefined;
    let ended = false;
    try {
      const stdin = encodeCall({
        operation,
        kind: 'stream',
        params: context.params,
        input: context.input,
      });
      // Inside the `try`: a start refused synchronously — an already aborted
      // caller, a rejected option — must give the slot back like any other end.
      command = streamNativeCommand({
        ...config.command,
        stdin,
        maxStdinBytes: Math.max(stdin.byteLength, 1),
        signal: context.signal ?? new AbortController().signal,
      });
      const stderr = stderrTail();
      void drain(command.stderr, stderr.push);
      // Observed below; this keeps a rejection that lands first from being unhandled.
      void command.result.catch(() => undefined);
      for await (const line of readBoundedUtf8Lines(command.stdout, maxResponseBytes)) {
        if (line.trim() === '') continue;
        const frame = OperationFrameSchema.safeParse(parseJson(line));
        if (!frame.success) throw processFailed(operation, frame.error);
        if (frame.data.type === 'data') yield frame.data.data;
        else if (frame.data.type === 'error') throw refusalFromChild(frame.data.error);
        else {
          ended = true;
          break;
        }
      }
      if (!ended) {
        const result = await command.result;
        throw processFailed(
          operation,
          new Error(
            `stream ended without its end frame (exit ${result.exitCode}): ${stderr.text()}`,
          ),
        );
      }
    } catch (error) {
      if (AppError.is(error) || context.signal?.aborted) throw error;
      if (error instanceof StreamLineLimitError)
        throw tooLarge(operation, maxResponseBytes, error);
      throw limitRefusal(operation, config, error) ?? processFailed(operation, error);
    } finally {
      // A reader that stopped early, a failure and a normal end all leave here:
      // the process must not outlive the call that started it.
      await command?.stop().catch(() => undefined);
      release();
    }
  }

  return {
    unary(contract, key) {
      const operation = `${contract.meta.prefix}.${key}`;
      // The server validates this answer against the contract's output schema
      // right after the handler returns; the type is stated here, the proof is there.
      return async (context) => transportResult(await runUnary(operation, context));
    },
    stream(contract, key) {
      const operation = `${contract.meta.prefix}.${key}`;
      // Each item is validated against `stream.item` by the surface that carries it.
      return (context) => transportResult(runStream(operation, context));
    },
    get active() {
      return active;
    },
  };
}

/** The last bytes a child wrote to stderr — for the log behind a failure, never for the caller. */
function stderrTail(limit = 16 * 1024): { push(bytes: Uint8Array): void; text(): string } {
  let tail = new Uint8Array(0);
  return {
    push(bytes) {
      const joined = new Uint8Array(tail.byteLength + bytes.byteLength);
      joined.set(tail);
      joined.set(bytes, tail.byteLength);
      tail = joined.byteLength > limit ? joined.slice(joined.byteLength - limit) : joined;
    },
    text: () => new TextDecoder().decode(tail),
  };
}

/** Read a stream to its end so the child never blocks on it; its failure is the command's. */
async function drain(
  stream: ReadableStream<Uint8Array>,
  push: (bytes: Uint8Array) => void,
): Promise<void> {
  try {
    for await (const bytes of stream) push(bytes);
  } catch {
    // The command's own result carries the failure.
  }
}
