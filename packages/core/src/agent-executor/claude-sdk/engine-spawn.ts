import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { streamNativeCommand } from '../../process/stream';

/** What the executor writes into Claude Code over one query, as for every other engine. */
const ENGINE_STDIN_BYTES = 256 * 1024 * 1024;

/** A spawned Claude Code process the driver owns: the SDK's handle, plus when it is gone. */
export interface OwnedClaudeCodeProcess {
  readonly process: SpawnedProcess;
  /** Settles once the process ended and its output was read, whatever the outcome. */
  readonly exited: Promise<void>;
}

/**
 * Spawn Claude Code for the SDK through `stitchkit/process`, like the CLI and ACP engines: no
 * shell, only the environment the SDK declares, its own process group, and that group terminated
 * if the executor dies. The leader's PID is known once the owner-loss guard confirms the start, so
 * it is handed to `onLeader` rather than returned.
 */
export function spawnOwnedClaudeCode(
  options: SpawnOptions,
  hooks: {
    readonly onStderr: ((text: string) => void) | undefined;
    readonly onLeader: (pid: number) => void;
  },
): OwnedClaudeCodeProcess {
  const input = new TransformStream<Uint8Array, Uint8Array>();
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.env))
    if (value !== undefined) env[key] = value;
  const command = streamNativeCommand({
    executable: options.command,
    args: [...options.args],
    cwd: options.cwd ?? process.cwd(),
    env,
    envPolicy: 'declared-only',
    ownerLoss: 'terminate',
    stdin: input.readable,
    maxStdinBytes: ENGINE_STDIN_BYTES,
    signal: options.signal,
    onLeaderStarted: ({ pid }) => hooks.onLeader(pid),
  });
  void (async () => {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of command.stderr) {
        const text = decoder.decode(chunk, { stream: true });
        // A failing diagnostics callback must not stop the drain that keeps the child moving.
        if (text.length > 0) invokeQuietly(hooks.onStderr, text);
      }
    } catch {
      // A failed command errors its streams; the result carries why.
    }
  })();

  const events = new EventEmitter();
  let exitCode: number | null = null;
  let signalCode: NodeJS.Signals | null = null;
  let killed = false;
  const exited = command.result.then(
    (result) => {
      exitCode = result.exitCode;
      signalCode = isSignal(result.signal) ? result.signal : null;
      events.emit('exit', exitCode, signalCode);
    },
    (error: unknown) => {
      // An EventEmitter throws an 'error' nobody listens to; the exit below still tells the end.
      if (events.listenerCount('error') > 0)
        events.emit('error', error instanceof Error ? error : new Error(String(error)));
      events.emit('exit', null, null);
    },
  );
  const stdin = Writable.fromWeb(input.writable);
  // A byte stream, as from a child process — not one object per chunk.
  const stdout = Readable.from(command.stdout, { objectMode: false });
  // Ending the process cancels these streams; the outcome is told once, by 'exit'.
  stdin.on('error', () => undefined);
  stdout.on('error', () => undefined);
  const spawned: SpawnedProcess = {
    stdin,
    stdout,
    get killed() {
      return killed;
    },
    get exitCode() {
      return exitCode;
    },
    get signalCode() {
      return signalCode;
    },
    kill() {
      // The group's stop policy (graceful, then forced) applies whatever signal the SDK names.
      if (!killed) {
        killed = true;
        void command.stop().catch(() => undefined);
      }
      return true;
    },
    on: listen((event, listener) => events.on(event, listener)),
    once: listen((event, listener) => events.once(event, listener)),
    off: listen((event, listener) => events.off(event, listener)),
  };
  return { process: spawned, exited };
}

type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;
type ErrorListener = (error: Error) => void;

/** One registration path for the SDK's overloaded `on` / `once` / `off`. */
function listen(
  register: (event: 'exit' | 'error', listener: ExitListener | ErrorListener) => void,
) {
  function registered(event: 'exit', listener: ExitListener): void;
  function registered(event: 'error', listener: ErrorListener): void;
  function registered(event: 'exit' | 'error', listener: ExitListener | ErrorListener): void {
    register(event, listener);
  }
  return registered;
}

function isSignal(value: string | null): value is NodeJS.Signals {
  return value?.startsWith('SIG') === true;
}

function invokeQuietly(callback: ((text: string) => void) | undefined, text: string): void {
  try {
    callback?.(text);
  } catch {
    // Diagnostics only.
  }
}
