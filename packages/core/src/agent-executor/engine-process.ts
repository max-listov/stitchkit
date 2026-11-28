import { abortReason, raceAbort } from '../internal/abort-race';
import { createBoundedLineDecoder } from '../internal/bounded-lines';
import { assertPositiveSafeInteger } from '../internal/positive-integer';
import type { NativeCommandResult } from '../process/contract';
import { streamNativeCommand } from '../process/stream';

/** What an engine may write on one line: a whole JSON record, transcripts included. */
export const ENGINE_LINE_BYTES = 8 * 1024 * 1024;
/** Maximum bytes queued for the engine's stdin before `send()` refuses. */
const ENGINE_PENDING_STDIN_BYTES = 16 * 1024 * 1024;
/** What the executor writes into an engine over one connection, by default. */
const ENGINE_STDIN_BYTES = 256 * 1024 * 1024;
/** The end of stderr kept for a failure report. */
const STDERR_TAIL_BYTES = 16 * 1024;

/** Spawn parameters handed to an {@link EngineProcessWrapCommand} hook before launching an engine process. */
export interface EngineProcessCommandSpec {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** Optional abort signal cancelling asynchronous wrapping/probing work before spawn. */
  readonly signal?: AbortSignal | undefined;
}

/** Optional hook rewriting an engine command (for example into an OS sandbox) before `stitchkit/process` spawns it. */
export type EngineProcessWrapCommand = (
  command: EngineProcessCommandSpec,
) => EngineProcessCommandSpec | Promise<EngineProcessCommandSpec>;

/** Eagerly check an optional `wrapCommand` hook before opening a driver or session. */
export function assertEngineWrapCommand(
  wrapCommand: EngineProcessWrapCommand | undefined,
  caller: string,
): void {
  if (wrapCommand !== undefined && typeof wrapCommand !== 'function') {
    throw new TypeError(`[stitchkit] ${caller}: wrapCommand must be a function`);
  }
}

/** Run an optional `wrapCommand` hook and validate its returned command spec before spawning. */
export async function resolveWrappedEngineCommand(
  command: EngineProcessCommandSpec,
  wrapCommand: EngineProcessWrapCommand | undefined,
  caller: string,
  signal?: AbortSignal | undefined,
): Promise<{
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
}> {
  const effectiveSignal = signal ?? command.signal;
  if (effectiveSignal?.aborted) throw abortReason(effectiveSignal);
  if (wrapCommand === undefined) {
    return {
      executable: command.executable,
      args: [...command.args],
      cwd: command.cwd,
      env: { ...command.env },
    };
  }
  const input: EngineProcessCommandSpec = {
    executable: command.executable,
    args: [...command.args],
    cwd: command.cwd,
    env: { ...command.env },
    ...(effectiveSignal !== undefined && { signal: effectiveSignal }),
  };
  const wrapping = Promise.resolve().then(() => wrapCommand(input));
  const wrapped: unknown =
    effectiveSignal !== undefined
      ? await raceAbort(wrapping, effectiveSignal)
      : await wrapping;
  if (effectiveSignal?.aborted) throw abortReason(effectiveSignal);
  if (typeof wrapped !== 'object' || wrapped === null || Array.isArray(wrapped)) {
    throw new TypeError(`[stitchkit] ${caller}: wrapCommand must return a command object`);
  }
  const executable: unknown = Reflect.get(wrapped, 'executable');
  if (typeof executable !== 'string' || executable.trim().length === 0) {
    throw new TypeError(
      `[stitchkit] ${caller}: wrapCommand must return a non-empty string executable`,
    );
  }
  const args: unknown = Reflect.get(wrapped, 'args');
  if (
    !Array.isArray(args) ||
    !args.every((item): item is string => typeof item === 'string')
  ) {
    throw new TypeError(
      `[stitchkit] ${caller}: wrapCommand must return an array of string args`,
    );
  }
  const cwd: unknown = Reflect.get(wrapped, 'cwd');
  if (typeof cwd !== 'string' || cwd.trim().length === 0) {
    throw new TypeError(
      `[stitchkit] ${caller}: wrapCommand must return a non-empty string cwd`,
    );
  }
  const rawEnv: unknown = Reflect.get(wrapped, 'env');
  if (typeof rawEnv !== 'object' || rawEnv === null || Array.isArray(rawEnv)) {
    throw new TypeError(`[stitchkit] ${caller}: wrapCommand must return a string env record`);
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawEnv)) {
    if (typeof value !== 'string') {
      throw new TypeError(
        `[stitchkit] ${caller}: wrapCommand env.${key} must be a string, received ${typeof value}`,
      );
    }
    env[key] = value;
  }
  return { executable, args: [...args], cwd, env };
}

/** An engine process talked to by lines: one connection, one process. */
export interface EngineProcess {
  /** OS process id of the spawned engine once its leader has started, if available. */
  readonly pid?: number;
  /** Settles to the spawned leader PID once started, or `undefined` if startup ended without one. */
  readonly pidReady?: Promise<number | undefined>;
  /**
   * Write one line; refused once the process closed its input, when queuing
   * the line would exceed `maxPendingStdinBytes`, or when it would take the
   * connection past `maxStdinBytes` written over its life (a `RangeError`).
   * Refusing a write never splits an NDJSON frame or closes the session.
   */
  send(line: string): void;
  /** The engine's stdout, one line at a time; ends when the process ends. */
  readonly lines: AsyncIterable<string>;
  /** The last bytes of stderr, for a failure report. */
  stderrTail(): string;
  /** Settles when the process ended and its output was read. */
  readonly result: Promise<NativeCommandResult>;
  /** Stop the process, its group included, and wait until it is gone. */
  stop(): Promise<void>;
}

/**
 * Spawn an engine through `stitchkit/process`: no shell, the declared
 * environment only, the process group terminated if the executor dies, and
 * output bounded per line. The engine lives as long as the connection that
 * spawned it. Every option is checked before the engine is started.
 */
export function spawnEngineProcess(input: {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  /** The connection's lifetime: aborting it stops the engine. */
  signal: AbortSignal;
  /** The longest line the engine may write. Default 8 MiB. */
  maxLineBytes?: number | undefined;
  /** Maximum bytes queued for the engine's stdin before `send()` refuses. Default 16 MiB. */
  maxPendingStdinBytes?: number | undefined;
  /**
   * The most bytes the connection writes into the engine over its life; `send()` refuses a
   * line past it and the engine keeps running. Default 256 MiB.
   */
  maxStdinBytes?: number | undefined;
  /**
   * How stdout is consumed: `'lines'` (default, caller reads `lines`) or `'drain'` (drained
   * continuously in the background when the engine speaks over another transport such as a Unix socket).
   */
  stdoutMode?: 'lines' | 'drain' | undefined;
}): EngineProcess {
  assertPositiveSafeInteger('maxLineBytes', input.maxLineBytes);
  assertPositiveSafeInteger('maxPendingStdinBytes', input.maxPendingStdinBytes);
  assertPositiveSafeInteger('maxStdinBytes', input.maxStdinBytes);
  const maxLineBytes = input.maxLineBytes ?? ENGINE_LINE_BYTES;
  const maxPendingStdinBytes = input.maxPendingStdinBytes ?? ENGINE_PENDING_STDIN_BYTES;
  const maxStdinBytes = input.maxStdinBytes ?? ENGINE_STDIN_BYTES;
  const stdoutMode = input.stdoutMode ?? 'lines';
  if (stdoutMode !== 'lines' && stdoutMode !== 'drain') {
    throw new TypeError(
      `stdoutMode must be "lines" or "drain", received ${String(stdoutMode)}`,
    );
  }
  let written = 0;
  let pid: number | undefined;
  const pidReady = Promise.withResolvers<number | undefined>();
  const encoder = new TextEncoder();
  let writer!: ReadableStreamDefaultController<Uint8Array>;
  let open = true;
  const stdin = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        writer = controller;
      },
      cancel() {
        open = false;
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: maxPendingStdinBytes }),
  );
  const command = streamNativeCommand({
    executable: input.executable,
    args: [...input.args],
    cwd: input.cwd,
    env: input.env,
    envPolicy: 'declared-only',
    ownerLoss: 'terminate',
    stdin,
    maxStdinBytes,
    signal: input.signal,
    onLeaderStarted: ({ pid: startedPid }) => {
      pid = startedPid;
      pidReady.resolve(startedPid);
    },
  });
  let tail = '';
  void (async () => {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of command.stderr) {
        tail = (tail + decoder.decode(chunk, { stream: true })).slice(-STDERR_TAIL_BYTES);
      }
    } catch {
      // A failed command errors its streams; the result carries why.
    }
  })();
  if (stdoutMode === 'drain') {
    void (async () => {
      try {
        for await (const _chunk of command.stdout) {
          // Continuously drain stdout so pipe backpressure never blocks a socket-serving child.
        }
      } catch {
        // A failed command errors its streams; the result carries why.
      }
    })();
  }
  const closeInput = () => {
    if (!open) return;
    open = false;
    try {
      writer.close();
    } catch {
      // Already closed by the process.
    }
  };
  const onCommandSettled = () => {
    closeInput();
    pidReady.resolve(pid);
  };
  void command.result.then(onCommandSettled, onCommandSettled);
  const cleanLine = (line: string) => (line.endsWith('\r') ? line.slice(0, -1) : line);
  async function* lines(): AsyncGenerator<string> {
    if (stdoutMode === 'drain') return;
    const decoder = createBoundedLineDecoder(maxLineBytes);
    for await (const chunk of command.stdout) {
      for (const line of decoder.push(chunk)) {
        const trimmed = cleanLine(line);
        if (trimmed.length > 0) yield trimmed;
      }
    }
    for (const line of decoder.end()) {
      const trimmed = cleanLine(line);
      if (trimmed.length > 0) yield trimmed;
    }
  }
  return {
    get pid() {
      return pid;
    },
    pidReady: pidReady.promise,
    send(line) {
      if (!open) throw new Error('The engine process has closed its input');
      const available = writer.desiredSize;
      if (available === null) throw new Error('The engine process has closed its input');
      const bytes = encoder.encode(`${line}\n`);
      if (bytes.byteLength > available) {
        throw new RangeError(
          `Engine stdin queue exceeded ${maxPendingStdinBytes} bytes (${bytes.byteLength} bytes needed, ${available} bytes available)`,
        );
      }
      if (written + bytes.byteLength > maxStdinBytes) {
        throw new RangeError(
          `Engine stdin budget of ${maxStdinBytes} bytes for this connection is spent (${written} bytes written, ${bytes.byteLength} bytes needed)`,
        );
      }
      writer.enqueue(bytes);
      written += bytes.byteLength;
    },
    lines: lines(),
    stderrTail: () => tail,
    result: command.result,
    async stop() {
      closeInput();
      await command.stop();
    },
  };
}
