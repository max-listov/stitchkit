/**
 * The CLI transport — the fourth surface a `defineContract` drives, alongside
 * HTTP, MCP and agent tools. `createCli` turns contract services into a
 * command-line program: `<app> <command> [positional] [--flags]`, one command
 * per contract tool exposed on `'CLI'`.
 *
 * It is a peer of `mountMcp` / `mountAgent`, not a wrapper around the HTTP
 * client: a command runs through the very same `executeToolMethod` pipeline —
 * the same validation, the same `lifecycle.beforeHandle` auth gate, the same
 * error model — so a CLI call accepts and rejects exactly as the other
 * transports do (ADR 0014 parity). The CLI-unique parts live around that core:
 * argv parsing (`cli-args`), stdout/exit formatting (`cli-format`) and `--wait`
 * polling (`cli-wait`).
 *
 * Exposure is opt-in: a method appears as a command only when its contract
 * `expose` lists `'CLI'` (the default `['MCP','AGENT']` keeps it off the CLI).
 *
 * stitchkit ships no binary — `createCli` is the building block. A consuming app
 * writes the executable (`#!/usr/bin/env node` → `createCli({ … })`) and the
 * `bin` entry in its own `package.json`.
 */
import { writeSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { ZodObject, z } from 'zod';
import { safeJsonParse } from '../internal/safe-json';
import { fetchGuarded, readCapped } from '../internal/secure-fetch';
import { isRecord } from '../internal/typed';
import { writeDownload } from '../internal/write-download';
import {
  CliArgumentError,
  describeSchemaFields,
  extractCliGlobalOptions,
  isReservedBoolWord,
  parseCliArgs,
  RESERVED_CLI_OPTIONS,
  routeCliArgv,
} from './cli-args';
import {
  type CliCommandDefinition,
  cliCommandPresentationSchema,
  executeCliCommand,
  prepareCliCommandEmission,
} from './cli-command';
import { DEFAULT_EXIT_CODES, type ExitCodeMap, emitResult } from './cli-format';
import {
  buildCliSurface,
  type CliInvocationResult,
  type CliInvoker,
  type CliInvokerCommand,
  type CliInvokerConfig,
  type CliSurfaceSource,
  cliInvocationResult,
  createCliInvoker,
} from './cli-invoke';
import { applyCliPresentationPolicy, type CliCommandPresentation } from './cli-policy';
import { renderCliView } from './cli-view';
import { type CliWaitConfig, pollUntilDone } from './cli-wait';
import {
  type ErrorHintFn,
  type ToolCallHooks,
  type ToolLifecycle,
  type ToolResult,
  toolErrorFromResult,
  toolResultFromError,
} from './execute';
import { type JsonSchemaField, jsonSchemaFields } from './json-schema';
import { createToolRunner, type MountableTool } from './mount';
import { assertUniqueToolName } from './names';
import { buildToolPresentationSchema } from './presentation';
import { objectShapeKeys } from './schema';

export type {
  CliInvocationResult,
  CliInvoker,
  CliInvokerCommand,
  CliInvokerConfig,
  CliSurfaceSource,
};
export { cliInvocationResult, createCliInvoker };

export interface CliConfig<
  TAuth = unknown,
  TContext extends Record<string, unknown> = Record<string, unknown>,
  TGlobals extends ZodObject = ZodObject,
> extends CliInvokerConfig<TAuth, TContext, TGlobals> {
  /** Program version — printed by `--version`. */
  version: string;
  /** CLI-only executable commands, dispatched before auth and managed surface factories. */
  commands?: readonly CliCommandDefinition[];
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

const GLOBAL_OPTIONS = [
  ['--json', 'Emit compact success/error JSON records (for scripts)'],
  ['--wait', 'Block-poll an async result to a terminal state'],
  ['--wait-timeout <s>', 'Override the --wait timeout in seconds'],
  ['--output-dir <dir>', 'Download result media into a directory'],
  ['--quiet', 'Suppress non-essential stderr output'],
  ['--dry-run', 'Print the resolved call without executing it'],
  ['--help, -h', 'Show help for a command'],
  ['--help <text>', 'List only the commands matching a substring'],
  ['--count-by <field>', 'Count records per distinct value of a field'],
  ['--sum <field>', 'Total a numeric field, optionally grouped by --by'],
  ['--sort <field>', 'Order the records by a field, largest first'],
  ['--ascending', 'Flip --sort to smallest first'],
  ['--top <n>', 'Keep the n leading entries of the view asked for'],
  ['--table <a,b>', 'Render the named fields as an aligned table'],
] as const;

/** Default stdin reader — `null` on an interactive TTY (nothing piped). */
async function readPipedStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text.length > 0 ? text : null;
}

/** A human label for a flag's JSON-Schema type. */
function typeLabel(schema: Record<string, unknown>): string {
  if (Array.isArray(schema.enum)) return schema.enum.join('|');
  if (schema.type === 'array') return 'value…';
  if (typeof schema.type === 'string') return schema.type;
  return 'value';
}

function padRight(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

/**
 * A terse one-line command summary for the top-level help — the first sentence
 * of the (model-facing, often long) `desc`, capped. The full `desc` shows under
 * `<app> <command> --help`.
 */
function summarize(desc: string): string {
  const firstLine = desc.split('\n')[0]?.trim() ?? '';
  const firstSentence = firstLine.split('. ')[0]?.trim() ?? firstLine;
  const max = 72;
  return firstSentence.length > max
    ? `${firstSentence.slice(0, max - 1).trimEnd()}…`
    : firstSentence;
}

/** Best-effort coercion for a passthrough value of unknown schema type. */
function looseCoerceValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(looseCoerceValue);
  if (typeof value !== 'string') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  const n = Number(value);
  return value.trim() !== '' && !Number.isNaN(n) ? n : value;
}

/**
 * Resolve the existing value of a passthrough target field to a record base to
 * merge onto. The field may still be a JSON *string* at this point — passthrough
 * runs before `executeToolMethod`'s `coerceJson` pass parses object fields — so
 * a `--parameters '{json}'` blob must be parsed here, or the passthrough bag
 * would clobber it (silent data loss). A non-JSON / non-record value yields
 * `undefined`: the bag replaces it, as before.
 */
function passthroughBase(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = safeJsonParse(value);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Not JSON — fall through; the bag becomes the field value.
    }
  }
  return undefined;
}

/**
 * Move a command's unknown top-level args into a freeform object `field` — the
 * `passthrough` mechanism. A flag that is not a known schema key (and not the
 * target field itself) is loose-coerced and folded into `field`, so per-model
 * params arrive as flat `--flags` rather than a JSON blob.
 */
function collectPassthrough(
  toolArgs: Record<string, unknown>,
  field: string,
  knownKeys: string[],
): void {
  const known = new Set(knownKeys);
  const bag: Record<string, unknown> = {};
  for (const key of Object.keys(toolArgs)) {
    if (key === field || known.has(key)) continue;
    bag[key] = looseCoerceValue(toolArgs[key]);
    delete toolArgs[key];
  }
  if (Object.keys(bag).length === 0) return;
  const base = passthroughBase(toolArgs[field]);
  toolArgs[field] = base ? { ...base, ...bag } : bag;
}

/** The application's own global options, rendered like the framework's own. */
function applicationOptionLines(fields: readonly JsonSchemaField[]): string[] {
  if (fields.length === 0) return [];
  const labels = new Map(
    fields.map((field) => [field.name, `--${field.name} <${typeLabel(field.schema)}>`]),
  );
  const width = Math.max(...fields.map((field) => labels.get(field.name)?.length ?? 0));
  return [
    '',
    'Application options:',
    ...fields.map((field) =>
      `  ${padRight(labels.get(field.name) ?? `--${field.name}`, width)}  ${field.description ?? ''}`.trimEnd(),
    ),
  ];
}

/**
 * Commands matching a substring, by name or by description.
 *
 * A discovered surface can be two hundred commands, at which point the full list
 * stops being an answer: it scrolls past a person and costs an agent the same
 * context an unfiltered result would. The description is searched too, because
 * the word someone knows is often in the sentence rather than the name.
 */
function filterCommands(
  commands: Map<string, CliCommandPresentation>,
  filter: string,
): Map<string, CliCommandPresentation> {
  const needle = filter.toLowerCase();
  return new Map(
    [...commands].filter(
      ([command, descriptor]) =>
        command.toLowerCase().includes(needle) ||
        descriptor.description.toLowerCase().includes(needle),
    ),
  );
}

function renderTopHelp(input: {
  name: string;
  version: string;
  commands: Map<string, CliCommandPresentation>;
  defaultCommand?: string;
  applicationOptions: readonly JsonSchemaField[];
  /** Why the managed surface is missing from this listing, when it is. */
  unavailable?: string;
  /** Narrow the listing; the counted line says what was left out. */
  filter?: string;
}): string {
  const { name, version, defaultCommand } = input;
  const commands =
    input.filter === undefined ? input.commands : filterCommands(input.commands, input.filter);
  const lines = [
    `${name} ${version}`,
    '',
    `Usage: ${name} ${defaultCommand ? '[command]' : '<command>'} [args] [--flags]`,
    '',
    input.filter === undefined
      ? 'Commands:'
      : `Commands matching "${input.filter}" (${commands.size} of ${input.commands.size}):`,
  ];
  const width = Math.max(0, ...[...commands.keys()].map((key) => key.length));
  for (const [command, descriptor] of commands) {
    lines.push(
      `  ${padRight(command, width)}  ${summarize(descriptor.description)}${command === defaultCommand ? ' (default)' : ''}`,
    );
  }
  // Naming the reason is the whole point: a command list that silently lost
  // most of itself reads as a CLI that never had those commands.
  if (input.unavailable !== undefined) {
    lines.push('', `Managed commands are unavailable: ${input.unavailable}`);
  }
  // A filtered listing is an answer to one question; repeating the whole option
  // table under it would bury the answer the reader asked for.
  if (input.filter !== undefined) {
    lines.push('', `Run "${name} <command> --help" for command-specific flags.`);
    return `${lines.join('\n')}\n`;
  }
  lines.push('', 'Global options:');
  const optWidth = Math.max(...GLOBAL_OPTIONS.map(([flag]) => flag.length));
  for (const [flag, desc] of GLOBAL_OPTIONS)
    lines.push(`  ${padRight(flag, optWidth)}  ${desc}`);
  lines.push(...applicationOptionLines(input.applicationOptions));
  lines.push('', `Run "${name} <command> --help" for command-specific flags.`);
  return `${lines.join('\n')}\n`;
}

function renderCommandHelp(
  name: string,
  command: string,
  descriptor: CliCommandPresentation,
  applicationOptions: readonly JsonSchemaField[] = [],
): string {
  const fields = jsonSchemaFields(descriptor.presentationSchema);
  const fieldsByName = new Map(fields.map((field) => [field.name, field]));
  const kinds = describeSchemaFields(descriptor.argumentSchema);
  const positionals: JsonSchemaField[] = [];
  const positionalNames =
    descriptor.positionals ??
    [...kinds].filter(([, info]) => info.kind !== 'boolean').map(([fieldName]) => fieldName);
  for (const fieldName of positionalNames) {
    const field = fieldsByName.get(fieldName);
    if (field) positionals.push(field);
  }
  // Only an explicit policy makes a trailing array field variadic, so only
  // there does the usage line promise a list.
  const variadicTail =
    descriptor.positionals !== undefined &&
    kinds.get(descriptor.positionals[descriptor.positionals.length - 1] ?? '')?.kind ===
      'array'
      ? descriptor.positionals[descriptor.positionals.length - 1]
      : undefined;
  const positionalSyntax = new Map(
    positionals.map((field) => {
      const label = field.name === variadicTail ? `${field.name}...` : field.name;
      return [field.name, field.required ? `<${label}>` : `[${label}]`];
    }),
  );
  const usage = [
    `Usage: ${name} ${command}`,
    ...positionals.map((field) => positionalSyntax.get(field.name) ?? field.name),
    '[--flags]',
  ].join(' ');
  const lines = [descriptor.description, '', usage, ''];
  if (fields.length > 0) {
    lines.push('Arguments:');
    const labels = new Map(
      fields.map((field) => {
        const positional = positionalSyntax.get(field.name);
        const alias = descriptor.aliases.get(field.name);
        const option = alias ? `-${alias}, --${field.name}` : `--${field.name}`;
        return [field.name, positional ? `${positional} | ${option}` : option];
      }),
    );
    const width = Math.max(...fields.map((field) => labels.get(field.name)?.length ?? 0));
    for (const f of fields) {
      const req = f.required ? ' (required)' : '';
      const desc = f.description ? ` — ${f.description}` : '';
      const label = labels.get(f.name) ?? `--${f.name}`;
      lines.push(`  ${padRight(label, width)}  <${typeLabel(f.schema)}>${req}${desc}`);
    }
    lines.push('');
  }
  const applicationLines = applicationOptionLines(applicationOptions);
  if (applicationLines.length > 0) lines.push(...applicationLines.slice(1), '');
  return `${lines.join('\n')}\n`;
}

function nativeDescriptor(
  definition: CliCommandDefinition,
): Omit<CliCommandPresentation, 'aliases' | 'positionals'> {
  return {
    description: definition.description,
    argumentSchema: definition.input,
    presentationSchema: cliCommandPresentationSchema(definition),
  };
}

function assertCommandShape(
  name: string,
  descriptor: CliCommandPresentation,
  exists: boolean,
  passthroughField?: string,
  applicationGlobals: ReadonlySet<string> = new Set(),
): void {
  assertUniqueToolName(name, exists, 'CLI command');
  if (name === 'help' || name === 'version') {
    throw new Error(`[stitchkit] CLI command "${name}" is reserved`);
  }
  const fieldNames = jsonSchemaFields(descriptor.presentationSchema).map(
    (field) => field.name,
  );
  const conflicting = fieldNames.filter((field) => RESERVED_CLI_OPTIONS.has(field));
  if (conflicting.length > 0) {
    throw new Error(
      `[stitchkit] CLI command "${name}" declares reserved option field(s): ${conflicting.join(', ')}`,
    );
  }
  // An application global is stripped from argv before any command parses it,
  // so a command field of the same name could never receive a value. Say so at
  // startup instead of losing the argument at every call.
  const shadowed = fieldNames.filter((field) => applicationGlobals.has(field));
  if (shadowed.length > 0) {
    throw new Error(
      `[stitchkit] CLI command "${name}" declares field(s) shadowed by application global options: ${shadowed.join(', ')}`,
    );
  }
  if (passthroughField !== undefined && descriptor.aliases.has(passthroughField)) {
    throw new Error(
      `[stitchkit] CLI command "${name}" cannot alias passthrough field "${passthroughField}"`,
    );
  }
}

type PreparedCliInvocation =
  | {
      ok: true;
      toolArgs: Record<string, unknown>;
      options: ReturnType<typeof parseCliArgs>['options'];
    }
  | { ok: false; message: string };

async function prepareInvocation(
  command: string,
  commandArgv: string[],
  descriptor: CliCommandPresentation,
  config: Pick<CliConfig, 'passthrough'>,
  readStdin: () => Promise<string | null>,
): Promise<PreparedCliInvocation> {
  let parsed: ReturnType<typeof parseCliArgs>;
  try {
    parsed = parseCliArgs(commandArgv, descriptor.argumentSchema, {
      allowUnknown: config.passthrough?.[command] !== undefined,
      knownFields: jsonSchemaFields(descriptor.presentationSchema).map((field) => field.name),
      optionAliases: new Map([...descriptor.aliases].map(([field, alias]) => [alias, field])),
      positionals: descriptor.positionals,
    });
  } catch (error) {
    if (!(error instanceof CliArgumentError)) throw error;
    return { ok: false, message: error.message };
  }

  const { toolArgs, options } = parsed;
  const firstUnset = jsonSchemaFields(descriptor.presentationSchema).find(
    (field) => field.required && !(field.name in toolArgs) && field.schema.type !== 'boolean',
  );
  if (firstUnset) {
    const piped = await readStdin();
    if (piped !== null) {
      if (descriptor.positionals === undefined) {
        // Preserve the historical no-policy path byte-for-byte: stdin used to
        // arrive as a raw string and the command schema decided whether it fit.
        toolArgs[firstUnset.name] = piped;
      } else {
        // An explicit positional policy makes option-only fields obey the same
        // field-aware coercion as their equivalent `--field value` invocation.
        const stdinArgs = parseCliArgs(
          [`--${firstUnset.name}`, piped],
          descriptor.argumentSchema,
        );
        toolArgs[firstUnset.name] = stdinArgs.toolArgs[firstUnset.name];
      }
    }
  }

  const passthroughField = config.passthrough?.[command];
  if (passthroughField) {
    collectPassthrough(toolArgs, passthroughField, objectShapeKeys(descriptor.argumentSchema));
  }
  return { ok: true, toolArgs, options };
}

/** Default memory cap per downloaded file — overridable via `maxDownloadBytes`. */
const DEFAULT_DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024;

/** Download each extracted URL into `dir`, reporting per-file outcome to stderr. */
async function downloadResults(
  files: Array<{ url: string; name: string }>,
  dir: string,
  stderr: (text: string) => void,
  quiet: boolean,
  allowPrivate: boolean,
  maxBytes: number,
  timeoutMs: number | undefined,
): Promise<boolean> {
  const root = resolve(dir);
  let succeeded = true;
  for (const file of files) {
    try {
      // `file.url` is handler/remote-derived → SSRF-guard it (private hosts,
      // non-http(s) schemes, per-redirect-hop) and cap the body so a hostile or
      // huge resource cannot OOM the CLI.
      const res = await fetchGuarded(new URL(file.url), allowPrivate, { timeoutMs });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buffer = await readCapped(res, maxBytes);
      if (!buffer) throw new Error(`file exceeds the ${maxBytes}-byte cap`);
      // `file.name` is untrusted → basename-only, then re-check containment so a
      // crafted name (`../../etc/x`, absolute path) cannot escape the output dir.
      const target = resolve(root, basename(file.name));
      await writeDownload(root, target, buffer);
      if (!quiet) stderr(`saved ${target} (${(buffer.length / 1024).toFixed(0)}KB)\n`);
    } catch (err) {
      succeeded = false;
      stderr(
        `failed to download ${file.url}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
  return succeeded;
}

/** Build and run one mixed contract/runtime/native CLI surface, then exit. */
export async function createCli<
  TAuth = unknown,
  TContext extends Record<string, unknown> = Record<string, unknown>,
  TGlobals extends ZodObject = ZodObject,
>(config: CliConfig<TAuth, TContext, TGlobals>): Promise<void> {
  /**
   * Write every byte, synchronously, before the process is allowed to exit.
   *
   * Two distinct truncations live here, and the second was mistaken for the
   * first for a long time. The async `process.stdout.write` buffers, so a
   * `process.exit` right after a print drops whatever the runtime had not
   * flushed — a 70 KB JSON cut at exactly 65536 bytes. `writeSync` answers
   * that one.
   *
   * It does NOT answer the other. Once anything in the process has touched
   * `process.stdout`, the runtime has made that descriptor non-blocking; a
   * `writeSync` into a pipe whose reader is slow then writes as much as the
   * 64 KB pipe buffer will take, RETURNS THAT COUNT and throws nothing. The
   * old code ignored the count, so the tail was lost in silence with exit code
   * 0 — the same 65536 bytes as the bug it was written to fix, which is why it
   * read as fixed. Measured on Bun 1.3.14: `bun -e 'process.stdout;
   * writeSync(1, "x".repeat(200000))' | (sleep 1; wc -c)` → 65536.
   *
   * So the count is the loop condition, and a completely full buffer (`EAGAIN`)
   * is a wait, not a failure: a blocking write into a pipe nobody is draining
   * is supposed to block. Bytes, not characters — `writeSync` counts bytes and
   * a resumed multi-byte character would otherwise split.
   */
  let pendingWrite: Promise<void> | undefined;
  let writeFailed = false;
  const writeFd = (fd: 1 | 2, text: string): void => {
    const bytes = Buffer.from(text, 'utf8');
    let offset = 0;
    while (offset < bytes.length) {
      try {
        offset += writeSync(fd, bytes, offset, bytes.length - offset);
      } catch (error) {
        if (isRecord(error) && error.code === 'EAGAIN') {
          // A synchronous pause: the descriptor is full and there is nothing
          // else this invocation may do until the reader drains it.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
          continue;
        }
        // An exotic descriptor that refuses a sync write at all. The async
        // stream is the last resort, and `exit` below waits for it rather than
        // cutting it off — otherwise this branch would reintroduce the very
        // truncation the sync path exists to prevent.
        const stream = fd === 1 ? process.stdout : process.stderr;
        const rest = bytes.subarray(offset);
        pendingWrite = new Promise<void>((resolve) => {
          stream.write(rest, (failure) => {
            if (failure) writeFailed = true;
            resolve();
          });
        });
        return;
      }
    }
  };
  const stdout = config.stdout ?? ((text: string) => writeFd(1, text));
  const stderr = config.stderr ?? ((text: string) => writeFd(2, text));
  const exit =
    config.exit ??
    ((code: number) => {
      // Nothing is pending on the normal path — the loop above already put
      // every byte in the descriptor. When the fallback ran, exiting now would
      // cut it, and output that could not be delivered at all is a failure,
      // not a success with a short result.
      if (pendingWrite === undefined) process.exit(code);
      else void pendingWrite.then(() => process.exit(writeFailed ? 1 : code));
    });
  const argv = config.argv ?? process.argv.slice(2);
  const readStdin = config.stdin ?? readPipedStdin;
  if (config.auth !== undefined && config.resolveAuth !== undefined) {
    throw new Error('[stitchkit] createCli: use either auth or resolveAuth, not both');
  }

  const applicationOptions = config.globalOptions
    ? jsonSchemaFields(
        buildToolPresentationSchema({
          inputSchema: config.globalOptions,
          unrepresentable: 'any',
        }),
      )
    : [];
  const applicationGlobalNames = new Set(applicationOptions.map((field) => field.name));
  for (const name of applicationGlobalNames) {
    if (RESERVED_CLI_OPTIONS.has(name)) {
      throw new Error(
        `[stitchkit] CLI global option "--${name}" is reserved by the framework`,
      );
    }
  }

  const nativeCommands = new Map<string, CliCommandDefinition>();
  const nativeHelp = new Map<string, CliCommandPresentation>();
  for (const definition of config.commands ?? []) {
    const descriptor = applyCliPresentationPolicy(
      definition.name,
      nativeDescriptor(definition),
      config,
    );
    assertCommandShape(
      definition.name,
      descriptor,
      nativeCommands.has(definition.name),
      config.passthrough?.[definition.name],
      applicationGlobalNames,
    );
    nativeCommands.set(definition.name, definition);
    nativeHelp.set(definition.name, descriptor);
  }

  // The application's globals come off argv BEFORE routing: they may stand
  // before the command name as easily as after it, and no command's parser
  // should ever see them.
  let globals: Record<string, unknown>;
  let routableArgv: string[];
  try {
    const lifted = extractCliGlobalOptions(argv, config.globalOptions);
    globals = lifted.globals;
    routableArgv = lifted.argv;
  } catch (error) {
    if (!(error instanceof CliArgumentError)) throw error;
    stderr(`${error.message}\n`);
    return exit(2);
  }
  // The application declared this shape; `extractCliGlobalOptions` validated
  // against it. This is the one bridge between the two.
  const typedGlobals = globals as z.output<TGlobals>;

  const route = routeCliArgv(routableArgv, config.defaultCommand);
  if (route.error) {
    stderr(`${route.error}\n`);
    return exit(2);
  }
  const { command, commandArgv } = route;
  if (route.version || command === '--version' || command === 'version') {
    stdout(`${config.name} ${config.version}\n`);
    return exit(0);
  }

  // `--help` wins over every option validator — a user must be able to ask a
  // command about its flags even when the rest of the invocation is mistyped.
  const beforeSeparator =
    commandArgv.indexOf('--') === -1
      ? commandArgv
      : commandArgv.slice(0, commandArgv.indexOf('--'));
  const helpRequested = beforeSeparator.includes('--help') || beforeSeparator.includes('-h');

  const native = command === undefined ? undefined : nativeCommands.get(command);
  if (native && command !== undefined) {
    const descriptor = nativeHelp.get(command);
    if (!descriptor) throw new Error('[stitchkit] native CLI descriptor invariant failed');
    if (helpRequested) {
      stdout(renderCommandHelp(config.name, command, descriptor, applicationOptions));
      return exit(0);
    }
    const prepared = await prepareInvocation(
      command,
      commandArgv,
      descriptor,
      config,
      readStdin,
    );
    if (!prepared.ok) {
      stderr(`${prepared.message}\n`);
      return exit(2);
    }
    const { toolArgs, options } = prepared;
    if (options.help) {
      stdout(renderCommandHelp(config.name, command, descriptor, applicationOptions));
      return exit(0);
    }
    if (options.wait) {
      stderr(`--wait is not configured for native command "${command}"\n`);
      return exit(2);
    }
    if (options.waitTimeout !== undefined) {
      stderr('--wait-timeout requires --wait\n');
      return exit(2);
    }
    if (options.outputDir !== undefined) {
      stderr('--output-dir is not configured for native commands\n');
      return exit(2);
    }
    if (options.dryRun) {
      stdout(`${JSON.stringify({ command, args: toolArgs }, null, 2)}\n`);
      return exit(0);
    }
    const result = await executeCliCommand(
      native,
      toolArgs,
      options,
      { stdout, stderr },
      config.coerceJsonArgs ?? true,
      globals,
    );
    const emission = prepareCliCommandEmission(native, result, options);
    let emittedExitCode: number;
    if (emission.result.ok && emission.presentation !== undefined) {
      stdout(emission.presentation);
      emittedExitCode = 0;
    } else {
      emittedExitCode = emitResult(
        emission.result,
        { stdout, stderr },
        {
          json: options.json,
          toolName: command,
          errorHint: config.errorHint,
          exitCodes: { ...DEFAULT_EXIT_CODES, ...config.exitCodes },
        },
      );
    }
    return exit(emission.result.ok ? emission.successExitCode : emittedExitCode);
  }

  let authPromise: Promise<Awaited<TAuth> | undefined> | undefined;
  const resolveIdentity = (): Promise<Awaited<TAuth> | undefined> => {
    // An async IIFE, not `Promise.resolve(...)`: a `resolveAuth` that throws
    // SYNCHRONOUSLY would otherwise escape before the memo is assigned, and the
    // next caller would run it a second time.
    authPromise ??= (async (): Promise<Awaited<TAuth> | undefined> =>
      config.resolveAuth ? await config.resolveAuth(typedGlobals) : await config.auth)();
    return authPromise;
  };
  const dynamicSurface =
    typeof config.services === 'function' || typeof config.runtimeTools === 'function';
  /**
   * The managed surface, or the reason there isn't one.
   *
   * A CLI whose command set comes from a running server cannot list those
   * commands when the server is unreachable — but it still HAS native commands,
   * and it knows why the rest are missing. Letting the rejection escape printed
   * neither, and answering `Unknown command` would be a lie: the name is not
   * unknown, it is unresolvable. Only identity resolution is caught here; a
   * configuration fault in the surface itself is still a startup error.
   */
  type ManagedSurface =
    | {
        resolved: true;
        auth: Awaited<TAuth> | undefined;
        help: Map<string, CliCommandPresentation>;
        tools: Map<string, MountableTool>;
      }
    | {
        resolved: false;
        failure: Extract<ToolResult, { ok: false }>;
        reason: string;
        help: Map<string, CliCommandPresentation>;
      };
  const buildManagedSurface = async (forExecution: boolean): Promise<ManagedSurface> => {
    let auth: Awaited<TAuth> | undefined;
    if (dynamicSurface || forExecution) {
      try {
        auth = await resolveIdentity();
      } catch (error) {
        const failure = toolResultFromError(error);
        const normalized = toolErrorFromResult(failure);
        return {
          resolved: false,
          failure,
          reason: `${normalized.code}: ${normalized.message}`,
          help: new Map(nativeHelp),
        };
      }
    }
    // The same walk the in-process invoker does, from the same function: if the
    // two ever built the surface separately, a line of a stream and the same
    // call typed at a prompt could resolve to different tools.
    const { tools, help } = buildCliSurface(
      config,
      auth,
      nativeHelp,
      applicationGlobalNames,
      assertCommandShape,
    );
    return { resolved: true, auth, help, tools };
  };

  const topLevelHelp =
    route.topLevelHelp ||
    command === undefined ||
    command === 'help' ||
    command === '--help' ||
    command === '-h' ||
    // `--help=<substring>` is the same question written inline; without this it
    // routed as an unknown command name. `--help=false` stays what it always
    // was — the boolean negation — so the inline form keeps one meaning per
    // value rather than two.
    (command.startsWith('--help=') && !isReservedBoolWord(command.slice('--help='.length)));
  const managed = await buildManagedSurface(!topLevelHelp && !helpRequested);
  if (topLevelHelp) {
    const helpFilter =
      route.helpFilter ?? (command !== undefined ? commandArgv[0] : undefined);
    const filter =
      helpFilter !== undefined && !helpFilter.startsWith('-') ? helpFilter : undefined;
    // Nothing matched is a fact a script branches on, not an empty success —
    // an exit 0 over an empty list reads as "there are none", which is a
    // different statement from "none of these".
    if (filter !== undefined && filterCommands(managed.help, filter).size === 0) {
      stderr(
        `no command matches "${filter}" (${managed.help.size} available)\n` +
          (managed.resolved ? '' : `Managed commands are unavailable: ${managed.reason}\n`),
      );
      const codes = { ...DEFAULT_EXIT_CODES, ...config.exitCodes };
      return exit(codes.NOT_FOUND ?? 4);
    }
    stdout(
      renderTopHelp({
        name: config.name,
        version: config.version,
        commands: managed.help,
        defaultCommand: config.defaultCommand,
        applicationOptions,
        ...(filter !== undefined && { filter }),
        ...(managed.resolved ? {} : { unavailable: managed.reason }),
      }),
    );
    return exit(0);
  }
  if (!managed.resolved) {
    // Every native command already dispatched above, so this name could only
    // have come from the surface that failed to resolve. Report THAT, with the
    // exit code its error class declares.
    return exit(
      emitResult(
        managed.failure,
        { stdout, stderr },
        {
          json: beforeSeparator.includes('--json'),
          toolName: command ?? config.name,
          errorHint: config.errorHint,
          exitCodes: { ...DEFAULT_EXIT_CODES, ...config.exitCodes },
        },
      ),
    );
  }

  const tool = managed.tools.get(command);
  if (!tool) {
    stderr(
      `Unknown command "${command}". Run "${config.name} --help" for the command list.\n`,
    );
    return exit(1);
  }
  const descriptor = managed.help.get(command);
  if (!descriptor) throw new Error('[stitchkit] managed CLI descriptor invariant failed');
  if (helpRequested) {
    stdout(renderCommandHelp(config.name, command, descriptor, applicationOptions));
    return exit(0);
  }
  const prepared = await prepareInvocation(
    command,
    commandArgv,
    descriptor,
    config,
    readStdin,
  );
  if (!prepared.ok) {
    stderr(`${prepared.message}\n`);
    return exit(2);
  }
  const { toolArgs, options } = prepared;

  if (options.wait && !config.wait?.[command]) {
    stderr(`--wait is not configured for command "${command}"\n`);
    return exit(2);
  }
  if (options.waitTimeout !== undefined && !options.wait) {
    stderr('--wait-timeout requires --wait\n');
    return exit(2);
  }
  if (options.outputDir !== undefined && !config.download) {
    stderr('--output-dir is not configured for this CLI\n');
    return exit(2);
  }

  if (options.help) {
    stdout(renderCommandHelp(config.name, command, descriptor, applicationOptions));
    return exit(0);
  }

  if (options.dryRun) {
    stdout(`${JSON.stringify({ command, args: toolArgs }, null, 2)}\n`);
    return exit(0);
  }

  const runTool = createToolRunner({
    source: 'cli',
    context: { ...config.context?.(managed.auth, typedGlobals), signal: config.signal },
    hooks: config.hooks,
    lifecycle: config.lifecycle,
    errorHint: config.errorHint,
    coerceJsonArgs: config.coerceJsonArgs,
  });
  let result: ToolResult;
  try {
    result = await runTool(tool, toolArgs);
  } catch (err) {
    result = toolResultFromError(err);
  }

  const waitConfig = config.wait?.[command];
  if (options.wait && waitConfig) {
    result = await pollUntilDone({
      initial: result,
      wait: waitConfig,
      call: async (toolName, args) => {
        const pollTool = managed.tools.get(toolName);
        if (!pollTool) {
          return {
            ok: false,
            code: 'NOT_FOUND',
            details: { message: `--wait: no command "${toolName}" to poll` },
          };
        }
        return runTool(pollTool, args);
      },
      timeoutSec: options.waitTimeout,
      onTick: options.quiet ? undefined : (attempt) => stderr(`waiting… (poll ${attempt})\n`),
      signal: config.signal,
    });
  }

  let downloadsOk = true;
  if (options.outputDir && result.ok && config.download) {
    downloadsOk = await downloadResults(
      config.download(result.data),
      options.outputDir,
      stderr,
      options.quiet,
      config.allowPrivateDownloadHosts ?? false,
      config.maxDownloadBytes ?? DEFAULT_DOWNLOAD_MAX_BYTES,
      config.downloadTimeoutMs,
    );
  }

  // A view replaces the payload, never the outcome: a failed call still reports
  // its own error and exit code, because an aggregate over an error is not an
  // answer to the question that was asked.
  if (options.view && result.ok) {
    let viewed: ReturnType<typeof renderCliView>;
    try {
      viewed = renderCliView(result.data, options.view);
    } catch (error) {
      if (!(error instanceof CliArgumentError)) throw error;
      stderr(`${error.message}\n`);
      return exit(2);
    }
    if (viewed.kind === 'text') {
      stdout(viewed.text);
      return exit(downloadsOk ? 0 : 1);
    }
    result = { ...result, data: viewed.data };
  }

  const exitCode = emitResult(
    result,
    { stdout, stderr },
    {
      json: options.json,
      toolName: command,
      errorHint: config.errorHint,
      exitCodes: { ...DEFAULT_EXIT_CODES, ...config.exitCodes },
    },
  );
  return exit(downloadsOk ? exitCode : 1);
}
