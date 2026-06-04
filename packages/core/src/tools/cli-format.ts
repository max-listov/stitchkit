/**
 * Render a `ToolResult` for the CLI surface and map it to a process exit code.
 *
 * Output is JSON — the CLI's audience is agents (Skills via Bash), scripts and
 * `| jq`, for which structured JSON is the right shape, not a hand-formatted
 * table. The default is pretty-printed (indented, the same shape an MCP tool
 * returns); `--json` switches to a compact single line for piping.
 *
 * stdout is reserved for that result; an error goes to stderr as the same
 * model-facing `{ error, details, _hint }` object the MCP / agent transports
 * return (`formatToolError`), so a script can keep `2>/dev/null` clean while
 * still parsing a success.
 */
import type { ToolResult } from './execute';
import { formatToolError } from './mount';

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
  INTERNAL_SERVER_ERROR: 1,
};

export interface CliWriters {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface EmitOptions {
  /** Compact single-line JSON (for `| jq` / scripts); otherwise pretty-printed. */
  json: boolean;
  toolName: string;
  errorHint?: (toolName: string, errorCode: string) => string | null;
  exitCodes?: ExitCodeMap;
}

/**
 * Write a result to the right stream and return the exit code. Success → JSON
 * on stdout (pretty by default, compact with `--json`), exit `0`. Failure → the
 * error JSON on stderr, exit per the code map (unknown code → `1`).
 */
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
  writers.stderr(`${JSON.stringify(error, null, 2)}\n`);
  const codes = opts.exitCodes ?? DEFAULT_EXIT_CODES;
  return codes[result.code] ?? 1;
}
