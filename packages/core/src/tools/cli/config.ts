import type { ZodObject, z } from 'zod';
import type { ErrorHintFn, ToolCallHooks, ToolLifecycle } from '../execute-hooks';
import type { ExitCodeMap } from './format';
import type { CliInvokerConfig } from './invoke';
import type { CliWaitConfig } from './wait';

export interface CliConfig<
  TAuth = unknown,
  TContext extends Record<string, unknown> = Record<string, unknown>,
  TGlobals extends ZodObject = ZodObject,
> extends CliInvokerConfig<TAuth, TContext, TGlobals> {
  /** Program version — printed by `--version`. */
  version: string;
  /**
   * Identity for the single CLI invocation — resolved ONCE at startup (from an
   * env var / token file), like a stdio MCP server, not per call. A value or a
   * promise of one.
   */
  auth?: TAuth | Promise<TAuth>;
  /**
   * Lazily resolve identity only when a managed command/surface actually needs
   * it. Receives the application's global options, so `--caller <key>` can
   * select WHICH identity this invocation speaks as.
   */
  resolveAuth?: (globals: z.output<TGlobals>) => TAuth | Promise<TAuth>;
  /**
   * The application's OWN global options — invocation context that belongs to
   * no single operation: which identity key, which checkout, which profile.
   * Declared as a Zod object of optional fields; `createCli` lifts these flags
   * out of argv wherever they stand (before or after the command name),
   * validates them against this schema and keeps them out of every operation's
   * arguments. A name that collides with a framework option or with a field of
   * any command is a startup error, never silent shadowing.
   */
  globalOptions?: TGlobals;
  /**
   * Context merged into every handler. Typed against the app's context shape
   * when the CLI is built via `createToolkit<AppContext>()`.
   */
  context?: (auth: Awaited<TAuth> | undefined, globals: z.output<TGlobals>) => TContext;
  /** Explicit cancellation for this invocation; applications may bind SIGINT to it. */
  signal?: AbortSignal;
  /** Tool-call observability hooks — `afterToolCall` fires for every result,
   *  `onToolError` for the raw value behind a thrown one. */
  hooks?: ToolCallHooks;
  /**
   * Auth / scope gate — pass the same `createAuthHook` result used for the HTTP
   * server's `beforeHandle` so a CLI command is guarded identically. Without it
   * a scoped command bypasses the gate.
   */
  lifecycle?: ToolLifecycle;
  /** Coerce JSON-stringified arrays/objects in arguments. Default: true. */
  coerceJsonArgs?: boolean;
  /** Global error hint appended to every failed command's error. */
  errorHint?: ErrorHintFn;
  /** Override exit codes per `ToolResult.code`, merged over the defaults. */
  exitCodes?: ExitCodeMap;
  /**
   * Route a command's unknown `--flags` into a freeform object field, keyed by
   * command name → field. Lets `generate <model> --prompt … --aspect_ratio 16:9`
   * fill the model's `parameters` directly, instead of a `--parameters '{json}'`
   * blob. Values are loosely coerced (`"30"` → `30`, `"true"` → `true`).
   */
  passthrough?: Record<string, string>;
  /** Per-command `--wait` polling behaviour, keyed by command name. */
  wait?: Record<string, CliWaitConfig>;
  /** Extract downloadable media URLs from a result for `--output-dir`. */
  download?: (result: unknown) => Array<{ url: string; name: string }>;
  /**
   * Allow `--output-dir` downloads from private / internal / loopback hosts.
   * Default `false` — the SSRF guard, since the URLs come from handler output.
   */
  allowPrivateDownloadHosts?: boolean;
  /** Max bytes per `--output-dir` download before aborting. Default 100 MB. */
  maxDownloadBytes?: number;
  /**
   * Deadline for producing response headers per `--output-dir` download (DNS,
   * connects and redirects share it). Default 15 seconds.
   */
  downloadTimeoutMs?: number;
  /** argv to parse — default `process.argv.slice(2)`; injectable for tests. */
  argv?: string[];
  /** stdout sink — default `process.stdout`; injectable for tests. */
  stdout?: (text: string) => void;
  /** stderr sink — default `process.stderr`; injectable for tests. */
  stderr?: (text: string) => void;
  /** Exit hook — default `process.exit`; injectable for tests. */
  exit?: (code: number) => void;
  /** Read piped stdin — default reads when not a TTY; injectable for tests. */
  stdin?: () => Promise<string | null>;
}
