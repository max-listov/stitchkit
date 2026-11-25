import type { ZodType } from 'zod';
import { isUnsafeKey } from '../../internal/safe-json';
import { type JsonSchemaField, jsonSchemaFields } from '../../json-schema/json-schema';
import { describeSchemaFields } from './args-fields';
import type { CliResultPolicy } from './command';
import type { CliWaitConfig } from './wait';

/** All per-command CLI settings, grouped under one command name in `commandSettings`. */
export interface CliCommandSettings {
  /** Exact ordered argv-positional fields; an empty array disables positionals. */
  positionals?: readonly string[];
  /** Exact command-scoped short option aliases (`{ f: 'follow' }`). */
  aliases?: Readonly<Record<string, string>>;
  /**
   * Terminal presentation and success exit code of a managed command's result —
   * `defineCliResult(LookupOutput, { present, exitCode })`.
   * Declared where the CLI is mounted, because a client and a server print nothing.
   */
  result?: CliResultPolicy<unknown>;
  /**
   * Route unknown `--flags` into a freeform object field. Lets
   * `generate <model> --prompt … --aspect_ratio 16:9` fill the model's `parameters`
   * directly instead of a `--parameters '{json}'` blob.
   */
  passthrough?: string;
  /** `--wait` polling behaviour for this command. */
  wait?: CliWaitConfig;
}

type StaticServiceCommandName<TServices> = [TServices] extends [undefined]
  ? never
  : TServices extends (...args: never[]) => unknown
    ? string
    : TServices extends readonly (infer TService)[]
      ? TService extends { readonly methods: infer TMethods extends Record<string, unknown> }
        ? string extends keyof TMethods
          ? string
          : {
              [K in keyof TMethods & string]: TMethods[K] extends {
                readonly toolName: infer TToolName extends string;
              }
                ? string extends TToolName
                  ? K
                  : TToolName
                : K;
            }[keyof TMethods & string]
        : string
      : string;

type StaticRuntimeCommandName<TRuntime> = [TRuntime] extends [undefined]
  ? never
  : TRuntime extends (...args: never[]) => unknown
    ? string
    : TRuntime extends readonly (infer TTool)[]
      ? TTool extends { readonly name: infer TName extends string }
        ? TName
        : string
      : string;

type StaticNativeCommandName<TCommands> = [TCommands] extends [undefined]
  ? never
  : TCommands extends readonly (infer TCommand)[]
    ? TCommand extends { readonly name: infer TName extends string }
      ? TName
      : string
    : string;

/**
 * Command names accepted as keys of `commandSettings`.
 *
 * Resolves to the literal union of command names when `services` and
 * `runtimeTools` (and optional `commands`) are static tuples with literal names;
 * widens to `string` when any source is a factory function or an array of
 * unknown composition.
 */
export type CliCommandName<TServices = unknown, TRuntime = unknown, TCommands = undefined> = [
  | StaticServiceCommandName<TServices>
  | StaticRuntimeCommandName<TRuntime>
  | StaticNativeCommandName<TCommands>,
] extends [never]
  ? string
  :
      | StaticServiceCommandName<TServices>
      | StaticRuntimeCommandName<TRuntime>
      | StaticNativeCommandName<TCommands>;

export interface CliPresentationPolicyConfig<TCommandName extends string = string> {
  /** Command selected when argv contains no explicit command. */
  defaultCommand?: string;
  /**
   * Per-command CLI settings keyed by command name: positional order, short
   * aliases, managed result presentation/exit code, unknown-flag passthrough
   * target and `--wait` polling configuration.
   */
  commandSettings?: Readonly<{ [name in TCommandName]?: CliCommandSettings }>;
}

const REMOVED_TOP_LEVEL_KEYS = [
  'optionAliases',
  'positionals',
  'results',
  'passthrough',
  'wait',
] as const;

/**
 * Refuse the five removed top-level CLI policy maps at startup so JS callers,
 * spreads and untyped configs fail loudly instead of silently dropping settings.
 */
export function assertNoLegacyCliPolicyKeys(config: unknown): void {
  if (typeof config !== 'object' || config === null) return;
  for (const key of REMOVED_TOP_LEVEL_KEYS) {
    if (Object.hasOwn(config, key)) {
      throw new TypeError(
        `[stitchkit] CLI option "${key}" was moved into "commandSettings.<command>" — migrate to commandSettings`,
      );
    }
  }
}

export interface CliCommandPresentation {
  description: string;
  /** An argv field conflict in a runtime catalogue entry; never executable. */
  unavailableReason?: string;
  argumentSchema: Parameters<typeof describeSchemaFields>[0];
  presentationSchema: Record<string, unknown>;
  /** The schema a successful result is validated against; absent when none is declared. */
  outputSchema?: ZodType;
  /** A contract stream: the command prints a line per item, and `outputSchema` is one item. */
  stream?: true;
  /** Canonical field name → one short alias. */
  aliases: ReadonlyMap<string, string>;
  /**
   * `undefined` retains automatic non-boolean schema order. A trailing ARRAY
   * field is variadic — it takes every remaining token. An array declared
   * anywhere else keeps taking exactly one (a JSON-array token), and command
   * help says which is which: only the variadic tail renders as `<name...>`.
   */
  positionals?: readonly string[];
}

const SHORT_ALIAS = /^[A-Za-z]$/;
const RESERVED_SHORT_OPTIONS = new Set(['h']);

function fieldMap(descriptor: CliCommandPresentation): Map<string, JsonSchemaField> {
  return new Map(
    jsonSchemaFields(descriptor.presentationSchema).map((field) => [field.name, field]),
  );
}

function resolveAliases(
  command: string,
  descriptor: CliCommandPresentation,
  configured: Readonly<Record<string, string>> | undefined,
): ReadonlyMap<string, string> {
  if (!configured) return new Map();
  const fields = fieldMap(descriptor);
  const aliases = new Map<string, string>();
  for (const [alias, target] of Object.entries(configured)) {
    if (!SHORT_ALIAS.test(alias)) {
      throw new Error(
        `[stitchkit] CLI command "${command}" alias "${alias}" must be one ASCII letter`,
      );
    }
    if (RESERVED_SHORT_OPTIONS.has(alias)) {
      throw new Error(`[stitchkit] CLI command "${command}" alias "-${alias}" is reserved`);
    }
    if (isUnsafeKey(target) || !fields.has(target)) {
      throw new Error(
        `[stitchkit] CLI command "${command}" alias "-${alias}" targets unknown field "${target}"`,
      );
    }
    const existing = aliases.get(target);
    if (existing !== undefined) {
      throw new Error(
        `[stitchkit] CLI command "${command}" field "${target}" has multiple aliases: -${existing}, -${alias}`,
      );
    }
    aliases.set(target, alias);
  }
  return aliases;
}

function resolvePositionals(
  command: string,
  descriptor: CliCommandPresentation,
  configured: readonly string[] | undefined,
): readonly string[] | undefined {
  if (configured === undefined) return undefined;
  const fields = fieldMap(descriptor);
  const kinds = describeSchemaFields(descriptor.argumentSchema);
  const seen = new Set<string>();
  let optionalSeen = false;
  for (const name of configured) {
    const field = fields.get(name);
    if (isUnsafeKey(name) || !field || !kinds.has(name)) {
      throw new Error(
        `[stitchkit] CLI command "${command}" positional targets unknown field "${name}"`,
      );
    }
    if (seen.has(name)) {
      throw new Error(
        `[stitchkit] CLI command "${command}" repeats positional field "${name}"`,
      );
    }
    if (kinds.get(name)?.kind === 'boolean') {
      throw new Error(
        `[stitchkit] CLI command "${command}" boolean field "${name}" cannot be positional`,
      );
    }
    if (optionalSeen && field.required) {
      throw new Error(
        `[stitchkit] CLI command "${command}" required positional "${name}" cannot follow an optional positional`,
      );
    }
    if (!field.required) optionalSeen = true;
    seen.add(name);
  }
  return [...configured];
}

/** Settings configured for one command, if any. */
export function cliCommandSettingsFor(
  config: Pick<CliPresentationPolicyConfig, 'commandSettings'>,
  command: string,
): CliCommandSettings | undefined {
  return config.commandSettings && Object.hasOwn(config.commandSettings, command)
    ? config.commandSettings[command]
    : undefined;
}

/** The result policy mounted for one command, if any. */
export function cliResultPolicy(
  config: Pick<CliPresentationPolicyConfig, 'commandSettings'>,
  command: string,
): CliResultPolicy<unknown> | undefined {
  return cliCommandSettingsFor(config, command)?.result;
}

/** The passthrough target field configured for one command, if any. */
export function cliPassthroughField(
  config: Pick<CliPresentationPolicyConfig, 'commandSettings'>,
  command: string,
): string | undefined {
  return cliCommandSettingsFor(config, command)?.passthrough;
}

/** The `--wait` polling configuration mounted for one command, if any. */
export function cliWaitConfig(
  config: Pick<CliPresentationPolicyConfig, 'commandSettings'>,
  command: string,
): CliWaitConfig | undefined {
  return cliCommandSettingsFor(config, command)?.wait;
}

export function applyCliPresentationPolicy(
  command: string,
  descriptor: Omit<CliCommandPresentation, 'aliases' | 'positionals'>,
  config: CliPresentationPolicyConfig,
): CliCommandPresentation {
  const base: CliCommandPresentation = { ...descriptor, aliases: new Map() };
  const settings = cliCommandSettingsFor(config, command);
  return {
    ...base,
    aliases: resolveAliases(command, base, settings?.aliases),
    positionals: resolvePositionals(command, base, settings?.positionals),
  };
}

/** Validate name-keyed policies only when the complete managed surface has resolved. */
export function assertCliPoliciesResolved(
  commands: ReadonlyMap<string, CliCommandPresentation>,
  config: CliPresentationPolicyConfig,
): void {
  const configuredNames = new Set(Object.keys(config.commandSettings ?? {}));
  if (config.defaultCommand !== undefined) configuredNames.add(config.defaultCommand);
  for (const name of configuredNames) {
    if (!commands.has(name)) {
      throw new Error(`[stitchkit] CLI policy targets unavailable command "${name}"`);
    }
  }
}
