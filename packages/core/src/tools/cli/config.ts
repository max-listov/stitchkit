import type { ZodObject } from 'zod';
import type { ServiceDef } from '../../server/types';
import type { RuntimeToolDefinition } from '../runtime-tool-declaration';
import type { CliCommandDefinition } from './command';
import type { CliInvokerConfig } from './invoke';

/** Terminal-only options added on top of `CliInvokerConfig` by `createCli`. */
interface CliTerminalConfig {
  /** Program version — printed by `--version`. */
  version: string;
  /** Name a result's URL files for `--output-dir`; files inline in `content` need no callback. */
  download?: (result: unknown) => Array<{ url: string; name: string }>;
  /**
   * Allow `--output-dir` downloads from private / internal / loopback hosts.
   * Default `false` — the SSRF guard, since the URLs come from handler output.
   */
  allowPrivateDownloadHosts?: boolean;
  /**
   * Byte cap per URL or inline file of `--output-dir`. A positive safe
   * integer, checked when the CLI is created. Default 100 MB.
   */
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
  /**
   * Read stdin for the first required unset field. The default skips TTYs,
   * waits up to 250 ms for the first byte, then reads to EOF without a deadline.
   * Override to explicitly wait for a delayed producer; no probe wraps this hook.
   */
  stdin?: () => Promise<string | null>;
}

/**
 * Full configuration for `createCli`.
 *
 * When `services` or `runtimeTools` are declared, `access` is required (`{ gate }`
 * with `beforeHandle` or `{ open }`). A native-only CLI (`commands` only) does
 * not run the tool lifecycle and does not require `access`.
 */
export type CliConfig<
  TAuth = unknown,
  TContext extends Record<string, unknown> = Record<string, unknown>,
  TGlobals extends ZodObject = ZodObject,
  TServices extends readonly ServiceDef[] = readonly ServiceDef[],
  TRuntime extends readonly RuntimeToolDefinition[] = readonly RuntimeToolDefinition[],
  TCommands extends readonly CliCommandDefinition[] = readonly CliCommandDefinition[],
> = CliInvokerConfig<TAuth, TContext, TGlobals, TServices, TRuntime, TCommands> &
  CliTerminalConfig;
