/**
 * Render a `ToolResult` for the CLI surface and map it to a process exit code.
 *
 * Output is JSON — the CLI's audience is agents (Skills via Bash), scripts and
 * `| jq`, for which structured JSON is the right shape, not a hand-formatted
 * table. The default is pretty-printed (indented, the same shape an MCP tool
 * returns); `--json` switches success and error records to one compact line.
 *
 * stdout is reserved for that result; an error goes to stderr as the same
 * model-facing `{ error, retryable, details, _hint }` object the MCP / agent transports
 * return (`formatToolError`), so a script can keep `2>/dev/null` clean while
 * still parsing a success.
 */

import type { ErrorHintFn } from '../execute-hooks';
import type { ToolResult } from '../execute-result';
import { formatToolError } from '../mount';

/** Map a `ToolResult.code` to a process exit code. */
export type ExitCodeMap = Record<string, number>;

/**
 * Conventional exit codes — `0` success, distinct non-zero per error class so a
 * script can branch on `$?`. Merged under any `CliConfig.exitCodes` override.
 */
export const DEFAULT_EXIT_CODES: ExitCodeMap = {
  VALIDATION_ERROR: 1,
  BAD_REQUEST: 1,
  UNAUTHORIZED: 2,
  FORBIDDEN: 3,
  NOT_FOUND: 4,
  CONFLICT: 5,
  RATE_LIMITED: 6,
  TIMEOUT: 7,
  WAIT_FAILED: 1,
  INTERNAL_SERVER_ERROR: 1,
};

export interface CliWriters {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface EmitOptions {
  /** Compact single-line success/error JSON; otherwise pretty-printed. */
  json: boolean;
  toolName: string;
  errorHint?: ErrorHintFn;
  exitCodes?: ExitCodeMap;
}

/**
 * Write a result to the right stream and return the exit code. Success → JSON
 * on stdout (pretty by default, compact with `--json`), exit `0`. Failure → the
 * error JSON on stderr, exit per the code map (unknown code → `1`).
 */
/**
 * The exit code a result earns, without writing anything.
 *
 * Extracted so a caller that runs an operation in process — a stdin loop, a
 * resumable batch — gets the SAME code the printed path gives, from the same
 * table, rather than re-deriving one from the error code and drifting. It was
 * computed inside `emitResult`, which meant the only way to learn it was to
 * print.
 */
export function cliExitCode(result: ToolResult, exitCodes?: ExitCodeMap): number {
  if (result.ok) return 0;
  // Merged, not replaced: an application declaring one extra code must not
  // silently lose the defaults for every other one — and `createCli` has always
  // merged at its call sites, so an unmerged map here is the two paths
  // disagreeing about the same failure.
  const codes = { ...DEFAULT_EXIT_CODES, ...exitCodes };
  // `hasOwn`, because a code is a free string that can arrive from a remote
  // service. `constructor` or `toString` would otherwise read a function off
  // the prototype and return it as the exit code — which `JSON.stringify` then
  // drops from a stream answer, and `process.exit` receives instead of a number.
  return Object.hasOwn(codes, result.code) ? (codes[result.code] ?? 1) : 1;
}

export function emitResult(
  result: ToolResult,
  writers: CliWriters,
  opts: EmitOptions,
): number {
  if (result.ok) {
    // A no-payload success (`data === undefined`) prints nothing — explicit,
    // rather than relying on `JSON.stringify(undefined)` being a falsy value.
    if (result.data === undefined) return 0;
    const text = opts.json
      ? JSON.stringify(result.data)
      : JSON.stringify(result.data, null, 2);
    writers.stdout(`${text}\n`);
    return 0;
  }
  const error = formatToolError(result, opts.toolName, opts.errorHint);
  const text = opts.json ? JSON.stringify(error) : JSON.stringify(error, null, 2);
  writers.stderr(`${text}\n`);
  return cliExitCode(result, opts.exitCodes);
}
