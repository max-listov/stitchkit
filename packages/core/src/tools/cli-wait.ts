/**
 * `--wait` polling — block on an async tool result until it reaches a terminal
 * state. The headline CLI feature (a `Bash(run_in_background)` generation that
 * notifies when done), kept strictly generic per ADR 0002: the core knows
 * nothing about generations or statuses. The consumer supplies how to read the
 * poll target from the first result (`poll`), which tool to re-call (`tool`)
 * and when it is done (`done`).
 */
import type { ToolResult } from './execute';
import { pollUntil } from './wait-core';

export interface CliWaitConfig {
  /**
   * Extract the poll-tool arguments from the initial result (e.g. `{ id }` from
   * a `generate` response). Return `null` when there is nothing to wait on.
   */
  poll: (result: unknown) => Record<string, unknown> | null;
  /** The tool/command name to call on each poll tick (e.g. `get_generation`). */
  tool: string;
  /** Done when this returns `true` for a poll result. */
  done: (result: unknown) => boolean;
  /** Backoff schedule in seconds; the last entry repeats. Default `[2,3,5,5,8,10]`. */
  backoff?: number[];
  /** Max seconds before giving up. Default `600`. */
  timeout?: number;
}

const DEFAULT_TIMEOUT = 600;

export interface PollParams {
  /** The result of the initial (non-poll) call. */
  initial: ToolResult;
  wait: CliWaitConfig;
  /** Run a tool by name — the CLI binds this to its tool map + runner. */
  call: (toolName: string, args: Record<string, unknown>) => Promise<ToolResult>;
  /** Override `wait.timeout` (from `--wait-timeout`). */
  timeoutSec?: number;
  /** Progress callback — the CLI logs ticks to stderr unless `--quiet`. */
  onTick?: (attempt: number, elapsedSec: number) => void;
  /** Injectable sleep for tests. */
  sleepFn?: (ms: number) => Promise<void>;
}

/**
 * Poll `wait.tool` until `wait.done` or the timeout. Returns the last poll
 * result; returns the initial result untouched when the initial call failed,
 * already satisfies `done`, or yields no poll target. A timeout produces a
 * `TIMEOUT` failed `ToolResult`.
 */
export async function pollUntilDone(params: PollParams): Promise<ToolResult> {
  const { initial, wait, call } = params;
  if (!initial.ok) return initial;
  if (wait.done(initial.data)) return initial;
  const pollArgs = wait.poll(initial.data);
  if (!pollArgs) return initial;

  const timeoutSec = params.timeoutSec ?? wait.timeout ?? DEFAULT_TIMEOUT;
  const { state, timedOut } = await pollUntil<ToolResult>({
    poll: () => call(wait.tool, pollArgs),
    // Stop on a failed poll call (return that error) or when the result is done.
    done: (result) => !result.ok || wait.done(result.data),
    backoff: wait.backoff,
    timeoutSec,
    sleepFn: params.sleepFn,
    onTick: params.onTick,
  });

  if (timedOut) {
    return {
      ok: false,
      code: 'TIMEOUT',
      details: { message: `Timed out after ${timeoutSec}s waiting for "${wait.tool}"` },
    };
  }
  return state;
}
