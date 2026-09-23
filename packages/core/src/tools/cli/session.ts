/**
 * The state one `createCli` invocation carries between its phases: what was
 * registered at startup (the session) and what argv asked for (the route).
 */
import type { ZodObject, z } from 'zod';
import { type JsonSchemaField, jsonSchemaFields } from '../../json-schema/json-schema';
import { assertUniqueToolName } from '../names';
import { buildToolPresentationSchema } from '../schema/presentation';
import { extractCliGlobalOptions } from './args';
import { type CliArgvRoute, RESERVED_CLI_OPTIONS, routeCliArgv } from './args-route';
import { CliArgumentError } from './argument-error';
import { type CliCommandDefinition, cliCommandPresentationSchema } from './command';
import type { CliConfig } from './config';
import { DEFAULT_EXIT_CODES, type EmitOptions } from './format';
import type { CliIo } from './io';
import { applyCliPresentationPolicy, type CliCommandPresentation } from './policy';

function nativeDescriptor(
  definition: CliCommandDefinition,
): Omit<CliCommandPresentation, 'aliases' | 'positionals'> {
  return {
    description: definition.description,
    argumentSchema: definition.input,
    presentationSchema: cliCommandPresentationSchema(definition),
  };
}

export function assertCommandShape(
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

export interface CliSession<
  TAuth,
  TContext extends Record<string, unknown>,
  TGlobals extends ZodObject,
> {
  config: CliConfig<TAuth, TContext, TGlobals>;
  io: CliIo;
  applicationOptions: readonly JsonSchemaField[];
  applicationGlobalNames: Set<string>;
  nativeCommands: Map<string, CliCommandDefinition>;
  nativeHelp: Map<string, CliCommandPresentation>;
}

/** Startup: everything that is a configuration fault throws here, before argv is read. */
export function createCliSession<
  TAuth,
  TContext extends Record<string, unknown>,
  TGlobals extends ZodObject,
>(
  config: CliConfig<TAuth, TContext, TGlobals>,
  io: CliIo,
): CliSession<TAuth, TContext, TGlobals> {
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
  return {
    config,
    io,
    applicationOptions,
    applicationGlobalNames,
    nativeCommands,
    nativeHelp,
  };
}

export interface CliRoute<TGlobals extends ZodObject> {
  globals: Record<string, unknown>;
  typedGlobals: z.output<TGlobals>;
  route: CliArgvRoute;
  command: string | undefined;
  commandArgv: string[];
  beforeSeparator: string[];
  helpRequested: boolean;
}

/**
 * Lift the application's globals, route the rest and answer `--version`.
 * `undefined` means the invocation was already answered and `exit` was called.
 */
export function resolveCliRoute<
  TAuth,
  TContext extends Record<string, unknown>,
  TGlobals extends ZodObject,
>(
  session: CliSession<TAuth, TContext, TGlobals>,
  argv: string[],
): CliRoute<TGlobals> | undefined {
  const { config } = session;
  const { stdout, stderr, exit } = session.io;
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
    exit(2);
    return undefined;
  }
  // The application declared this shape; `extractCliGlobalOptions` validated
  // against it. This is the one bridge between the two.
  const typedGlobals = globals as z.output<TGlobals>;

  const route = routeCliArgv(routableArgv, config.defaultCommand);
  if (route.error) {
    stderr(`${route.error}\n`);
    exit(2);
    return undefined;
  }
  const { command, commandArgv } = route;
  if (route.version || command === '--version' || command === 'version') {
    stdout(`${config.name} ${config.version}\n`);
    exit(0);
    return undefined;
  }

  // `--help` wins over every option validator — a user must be able to ask a
  // command about its flags even when the rest of the invocation is mistyped.
  const beforeSeparator =
    commandArgv.indexOf('--') === -1
      ? commandArgv
      : commandArgv.slice(0, commandArgv.indexOf('--'));
  const helpRequested = beforeSeparator.includes('--help') || beforeSeparator.includes('-h');
  return {
    globals,
    typedGlobals,
    route,
    command,
    commandArgv,
    beforeSeparator,
    helpRequested,
  };
}

/** The emit options every result path shares; only `json` and the tool name vary. */
export function emitOptionsFor(
  config: Pick<CliConfig, 'errorHint' | 'exitCodes'>,
  json: boolean,
  toolName: string,
): EmitOptions {
  return {
    json,
    toolName,
    errorHint: config.errorHint,
    exitCodes: { ...DEFAULT_EXIT_CODES, ...config.exitCodes },
  };
}
