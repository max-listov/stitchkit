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
import process from 'node:process';
import { safeJsonParse } from '../internal/safe-json';
import { fetchGuarded, readCapped } from '../internal/secure-fetch';
import { isRecord } from '../internal/typed';
import { writeDownload } from '../internal/write-download';
import type { ServiceDef, StitchLogger } from '../server/types';
import {
  CliArgumentError,
  describeSchemaFields,
  parseCliArgs,
  RESERVED_CLI_OPTIONS,
} from './cli-args';
import {
  type CliCommandDefinition,
  cliCommandPresentationSchema,
  executeCliCommand,
} from './cli-command';
import { DEFAULT_EXIT_CODES, type ExitCodeMap, emitResult } from './cli-format';
import { type CliWaitConfig, pollUntilDone } from './cli-wait';
import {
  type ErrorHintFn,
  type ToolCallHooks,
  type ToolLifecycle,
  type ToolResult,
  toolResultFromError,
} from './execute';
import { type JsonSchemaField, jsonSchemaFields } from './json-schema';
import { createToolRunner, type MountableTool } from './mount';
import { assertUniqueToolName } from './names';
import type { RuntimeToolDefinition } from './runtime-tool';
import { objectShapeKeys } from './schema';
import { collectToolSurface } from './surface';

export type CliSurfaceSource<TAuth, TValue> =
  | readonly TValue[]
  | ((auth: Awaited<TAuth> | undefined) => readonly TValue[]);

export interface CliConfig<
  TAuth = unknown,
  TContext extends Record<string, unknown> = Record<string, unknown>,
> {
  /** Program name — shown in help and unknown-command messages. */
  name: string;
  /** Program version — printed by `--version`. */
  version: string;
  /** Contract services exposed as commands — may depend on the resolved identity. */
  services?: CliSurfaceSource<TAuth, ServiceDef>;
  /** Pathless managed operations. CLI exposure always requires `transports: ['CLI']`. */
  runtimeTools?: CliSurfaceSource<TAuth, RuntimeToolDefinition>;
  /** CLI-only executable commands, dispatched before auth and managed surface factories. */
  commands?: readonly CliCommandDefinition[];
  /**
   * Identity for the single CLI invocation — resolved ONCE at startup (from an
   * env var / token file), like a stdio MCP server, not per call. A value or a
   * promise of one.
   */
  auth?: TAuth | Promise<TAuth>;
  /** Lazily resolve identity only when a managed command/surface actually needs it. */
  resolveAuth?: () => TAuth | Promise<TAuth>;
  /**
   * Context merged into every handler. Typed against the app's context shape
   * when the CLI is built via `createToolkit<AppContext>()`.
   */
  context?: (auth: Awaited<TAuth> | undefined) => TContext;
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
  /** Logger for diagnostics — defaults to stderr-safe `console.error`. */
  logger?: StitchLogger;
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

interface CliHelpCommand {
  description: string;
  argumentSchema: Parameters<typeof parseCliArgs>[1];
  presentationSchema: Record<string, unknown>;
}

function renderTopHelp(
  name: string,
  version: string,
  commands: Map<string, CliHelpCommand>,
): string {
  const lines = [
    `${name} ${version}`,
    '',
    `Usage: ${name} <command> [args] [--flags]`,
    '',
    'Commands:',
  ];
  const width = Math.max(0, ...[...commands.keys()].map((key) => key.length));
  for (const [command, descriptor] of commands) {
    lines.push(`  ${padRight(command, width)}  ${summarize(descriptor.description)}`);
  }
  lines.push('', 'Global options:');
  const optWidth = Math.max(...GLOBAL_OPTIONS.map(([flag]) => flag.length));
  for (const [flag, desc] of GLOBAL_OPTIONS)
    lines.push(`  ${padRight(flag, optWidth)}  ${desc}`);
  lines.push('', `Run "${name} <command> --help" for command-specific flags.`);
  return `${lines.join('\n')}\n`;
}

function renderCommandHelp(name: string, command: string, descriptor: CliHelpCommand): string {
  const fields = jsonSchemaFields(descriptor.presentationSchema);
  const fieldsByName = new Map(fields.map((field) => [field.name, field]));
  const positionals: JsonSchemaField[] = [];
  for (const [fieldName, info] of describeSchemaFields(descriptor.argumentSchema)) {
    if (info.kind === 'boolean') continue;
    const field = fieldsByName.get(fieldName);
    if (field) positionals.push(field);
  }
  const positionalSyntax = new Map(
    positionals.map((field) => [
      field.name,
      field.required ? `<${field.name}>` : `[${field.name}]`,
    ]),
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
        return [
          field.name,
          positional ? `${positional} | --${field.name}` : `--${field.name}`,
        ];
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
  return `${lines.join('\n')}\n`;
}

function managedDescriptor(tool: MountableTool): CliHelpCommand {
  return {
    description: tool.method.desc,
    argumentSchema: tool.argumentSchema,
    presentationSchema: tool.presentationSchema,
  };
}

function nativeDescriptor(definition: CliCommandDefinition): CliHelpCommand {
  return {
    description: definition.description,
    argumentSchema: definition.input,
    presentationSchema: cliCommandPresentationSchema(definition),
  };
}

function assertCommandShape(name: string, descriptor: CliHelpCommand, exists: boolean): void {
  assertUniqueToolName(name, exists, 'CLI command');
  if (name === 'help' || name === 'version') {
    throw new Error(`[stitchkit] CLI command "${name}" is reserved`);
  }
  const conflicting = jsonSchemaFields(descriptor.presentationSchema)
    .map((field) => field.name)
    .filter((field) => RESERVED_CLI_OPTIONS.has(field));
  if (conflicting.length > 0) {
    throw new Error(
      `[stitchkit] CLI command "${name}" declares reserved option field(s): ${conflicting.join(', ')}`,
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
  descriptor: CliHelpCommand,
  config: Pick<CliConfig, 'passthrough'>,
  readStdin: () => Promise<string | null>,
): Promise<PreparedCliInvocation> {
  let parsed: ReturnType<typeof parseCliArgs>;
  try {
    parsed = parseCliArgs(commandArgv, descriptor.argumentSchema, {
      allowUnknown: config.passthrough?.[command] !== undefined,
      knownFields: jsonSchemaFields(descriptor.presentationSchema).map((field) => field.name),
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
    if (piped !== null) toolArgs[firstUnset.name] = piped;
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
>(config: CliConfig<TAuth, TContext>): Promise<void> {
  // Synchronous by default: the async `process.stdout.write` buffers, and the
  // `process.exit` right after a print truncates anything past the pipe
  // buffer (observed: a 70 KB JSON cut at exactly 65536 bytes). `writeSync`
  // lands the full payload before exit; the async writer stays as a fallback
  // for exotic fds where a sync write is refused (e.g. EAGAIN).
  const writeFd = (fd: 1 | 2, text: string): void => {
    try {
      writeSync(fd, text);
    } catch {
      void (fd === 1 ? process.stdout : process.stderr).write(text);
    }
  };
  const stdout = config.stdout ?? ((text: string) => writeFd(1, text));
  const stderr = config.stderr ?? ((text: string) => writeFd(2, text));
  const exit = config.exit ?? ((code: number) => void process.exit(code));
  const argv = config.argv ?? process.argv.slice(2);
  const readStdin = config.stdin ?? readPipedStdin;
  if (config.auth !== undefined && config.resolveAuth !== undefined) {
    throw new Error('[stitchkit] createCli: use either auth or resolveAuth, not both');
  }

  const nativeCommands = new Map<string, CliCommandDefinition>();
  const nativeHelp = new Map<string, CliHelpCommand>();
  for (const definition of config.commands ?? []) {
    const descriptor = nativeDescriptor(definition);
    assertCommandShape(definition.name, descriptor, nativeCommands.has(definition.name));
    nativeCommands.set(definition.name, definition);
    nativeHelp.set(definition.name, descriptor);
  }

  const [command, ...commandArgv] = argv;
  if (command === '--version' || command === 'version') {
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
      stdout(renderCommandHelp(config.name, command, descriptor));
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
      stdout(renderCommandHelp(config.name, command, descriptor));
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
    );
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
    return exit(exitCode);
  }

  let authPromise: Promise<Awaited<TAuth> | undefined> | undefined;
  const resolveIdentity = (): Promise<Awaited<TAuth> | undefined> => {
    authPromise ??= Promise.resolve(config.resolveAuth ? config.resolveAuth() : config.auth);
    return authPromise;
  };
  const dynamicSurface =
    typeof config.services === 'function' || typeof config.runtimeTools === 'function';
  const buildManagedSurface = async (forExecution: boolean) => {
    const auth = dynamicSurface || forExecution ? await resolveIdentity() : undefined;
    const services =
      typeof config.services === 'function' ? config.services(auth) : (config.services ?? []);
    const runtimeTools =
      typeof config.runtimeTools === 'function'
        ? config.runtimeTools(auth)
        : (config.runtimeTools ?? []);
    const tools = new Map<string, MountableTool>();
    const help = new Map(nativeHelp);
    for (const { mountable } of collectToolSurface({
      surface: { services, runtimeTools },
      transport: 'CLI',
    })) {
      const descriptor = managedDescriptor(mountable);
      assertCommandShape(mountable.name, descriptor, help.has(mountable.name));
      tools.set(mountable.name, mountable);
      help.set(mountable.name, descriptor);
    }
    return { auth, help, tools };
  };

  const topLevelHelp =
    command === undefined || command === 'help' || command === '--help' || command === '-h';
  const managed = await buildManagedSurface(!topLevelHelp && !helpRequested);
  if (topLevelHelp) {
    stdout(renderTopHelp(config.name, config.version, managed.help));
    return exit(0);
  }

  const tool = managed.tools.get(command);
  if (!tool) {
    stderr(
      `Unknown command "${command}". Run "${config.name} --help" for the command list.\n`,
    );
    return exit(1);
  }
  const descriptor = managedDescriptor(tool);
  if (helpRequested) {
    stdout(renderCommandHelp(config.name, command, descriptor));
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
    stdout(renderCommandHelp(config.name, command, descriptor));
    return exit(0);
  }

  if (options.dryRun) {
    stdout(`${JSON.stringify({ command, args: toolArgs }, null, 2)}\n`);
    return exit(0);
  }

  const runTool = createToolRunner({
    source: 'cli',
    context: { ...config.context?.(managed.auth), signal: config.signal },
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
