/**
 * The state one `createCli` invocation carries between its phases: what was
 * registered at startup (the session) and what argv asked for (the route).
 */
import type { ZodObject, z } from 'zod';
import { assertPositiveSafeInteger } from '../../internal/positive-integer';
import {
  type JsonSchemaField,
  jsonSchemaFields,
  toJsonSchema,
} from '../../json-schema/json-schema';
import { resolveOptionalCliToolAccess } from '../access';
import type { ToolLifecycle } from '../execute-hooks';
import { buildToolPresentationSchema } from '../schema/presentation';
import { RESERVED_CLI_OPTIONS } from './args-classify';
import { type CliFrameworkOptions, scanCliInvocation } from './args-scan';
import { CliArgumentError } from './argument-error';
import type { CliCommandDefinition } from './command';
import {
  assertStaticCliCommandNames,
  commandShapeIssue,
  nativeCliDescriptor,
} from './command-shape';
import type { CliConfig } from './config';
import { DEFAULT_EXIT_CODES, type EmitOptions } from './format';
import type { CliIo } from './io';
import {
  applyCliPresentationPolicy,
  assertCliPoliciesResolved,
  assertNoLegacyCliPolicyKeys,
  type CliCommandPresentation,
  cliPassthroughField,
  cliResultPolicy,
} from './policy';
import { assertCliAuthConfig } from './runner';

export interface CliSession<
  TAuth,
  TContext extends Record<string, unknown>,
  TGlobals extends ZodObject,
> {
  config: CliConfig<TAuth, TContext, TGlobals>;
  lifecycle: ToolLifecycle;
  io: CliIo;
  applicationOptions: readonly JsonSchemaField[];
  applicationGlobalNames: Set<string>;
  nativeCommands: Map<string, CliCommandDefinition>;
  nativeHelp: Map<string, CliCommandPresentation>;
  hasManagedFactory: boolean;
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
  const lifecycle = resolveOptionalCliToolAccess('createCliSession', config);
  assertNoLegacyCliPolicyKeys(config);
  assertCliAuthConfig(config);
  assertPositiveSafeInteger('createCli maxDownloadBytes', config.maxDownloadBytes);

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
  assertStaticCliCommandNames(
    typeof config.services === 'function' ? [] : (config.services ?? []),
    typeof config.runtimeTools === 'function' ? [] : (config.runtimeTools ?? []),
  );
  for (const definition of config.commands ?? []) {
    if (cliResultPolicy(config, definition.name) !== undefined) {
      throw new Error(
        `[stitchkit] CLI result policy "${definition.name}" targets a command that is not managed; a native command declares present and exitCode on defineCliCommand`,
      );
    }
    const descriptor = applyCliPresentationPolicy(
      definition.name,
      nativeCliDescriptor(definition),
      config,
    );
    const issue = commandShapeIssue(
      definition.name,
      descriptor,
      nativeCommands.has(definition.name),
      cliPassthroughField(config, definition.name),
      applicationGlobalNames,
    );
    if (issue !== undefined) throw new Error(issue);
    nativeCommands.set(definition.name, definition);
    nativeHelp.set(definition.name, descriptor);
  }
  if (config.services === undefined && config.runtimeTools === undefined) {
    assertCliPoliciesResolved(nativeHelp, config);
  }
  return {
    config,
    lifecycle,
    io,
    applicationOptions,
    applicationGlobalNames,
    nativeCommands,
    nativeHelp,
    hasManagedFactory:
      typeof config.services === 'function' || typeof config.runtimeTools === 'function',
  };
}

export interface CliRoute<TGlobals extends ZodObject> {
  globals: Record<string, unknown>;
  typedGlobals: z.output<TGlobals>;
  framework: CliFrameworkOptions;
  command: string | undefined;
  commandTokens: string[];
  separatedBefore: ReadonlySet<number>;
  topLevelHelp: boolean;
  helpFilter?: string;
  quiet: boolean;
  helpRequested: boolean;
  /** `--schema` — answered like help: before identity, validation and the call. */
  schemaRequested: boolean;
}

/**
 * Scan the invocation once (application globals, framework flags and routing)
 * and answer `--version`. `undefined` means the invocation was already answered
 * and `exit` was called.
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
  let scan: ReturnType<typeof scanCliInvocation<TGlobals>>;
  try {
    scan = scanCliInvocation(argv, {
      appGlobals: config.globalOptions,
      defaultCommand: config.defaultCommand,
    });
  } catch (error) {
    if (!(error instanceof CliArgumentError)) throw error;
    stderr(`${error.message}\n`);
    exit(2);
    return undefined;
  }
  if (scan.version) {
    stdout(`${config.name} ${config.version}\n`);
    exit(0);
    return undefined;
  }
  const helpRequested = scan.framework.help;
  const schemaRequested = !helpRequested && scan.framework.schema;
  return {
    globals: scan.globals,
    typedGlobals: scan.globals,
    framework: scan.framework,
    command: scan.command,
    commandTokens: scan.commandTokens,
    separatedBefore: scan.separatedBefore,
    topLevelHelp: scan.topLevelHelp,
    ...(scan.helpFilter !== undefined && { helpFilter: scan.helpFilter }),
    quiet: scan.framework.quiet,
    helpRequested,
    schemaRequested,
  };
}

/**
 * `--schema`: one line of JSON carrying the JSON Schema of a command's input
 * and of its successful result, converted from the very Zod schemas the call
 * is validated against.
 */
export function renderCommandSchema(
  command: string,
  descriptor: CliCommandPresentation,
): string {
  return `${JSON.stringify({
    command,
    input: descriptor.presentationSchema,
    ...(descriptor.outputSchema !== undefined && {
      // The dialect of `input`: one document, one dialect.
      [descriptor.stream ? 'item' : 'output']: toJsonSchema(
        descriptor.outputSchema,
        'output',
        'any',
        'draft-07',
      ),
    }),
  })}\n`;
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
