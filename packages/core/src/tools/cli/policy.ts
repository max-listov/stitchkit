import type { ZodType } from 'zod';
import { isUnsafeKey } from '../../internal/safe-json';
import { type JsonSchemaField, jsonSchemaFields } from '../../json-schema/json-schema';
import { describeSchemaFields } from './args-fields';
import type { CliResultPolicy } from './command';

export interface CliPresentationPolicyConfig {
  /** Command selected when argv contains no explicit command. */
  defaultCommand?: string;
  /** Exact command-scoped short option aliases (`{ logs: { f: 'follow' } }`). */
  optionAliases?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Exact ordered argv-positional fields per command; an empty array disables positionals. */
  positionals?: Readonly<Record<string, readonly string[]>>;
  /**
   * Terminal presentation and success exit code of a managed command's result,
   * keyed by command name — `{ lookup: defineCliResult(LookupOutput, { present, exitCode }) }`.
   * Declared where the CLI is mounted, because a client and a server print nothing.
   */
  results?: Readonly<Record<string, CliResultPolicy<unknown>>>;
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

/** The result policy mounted for one command, if any. */
export function cliResultPolicy(
  config: Pick<CliPresentationPolicyConfig, 'results'>,
  command: string,
): CliResultPolicy<unknown> | undefined {
  return config.results && Object.hasOwn(config.results, command)
    ? config.results[command]
    : undefined;
}

export function applyCliPresentationPolicy(
  command: string,
  descriptor: Omit<CliCommandPresentation, 'aliases' | 'positionals'>,
  config: CliPresentationPolicyConfig,
): CliCommandPresentation {
  const base: CliCommandPresentation = { ...descriptor, aliases: new Map() };
  const configuredAliases =
    config.optionAliases && Object.hasOwn(config.optionAliases, command)
      ? config.optionAliases[command]
      : undefined;
  const configuredPositionals =
    config.positionals && Object.hasOwn(config.positionals, command)
      ? config.positionals[command]
      : undefined;
  return {
    ...base,
    aliases: resolveAliases(command, base, configuredAliases),
    positionals: resolvePositionals(command, base, configuredPositionals),
  };
}

/** Validate name-keyed policies only when the complete managed surface has resolved. */
export function assertCliPoliciesResolved(
  commands: ReadonlyMap<string, CliCommandPresentation>,
  config: CliPresentationPolicyConfig,
): void {
  const configuredNames = new Set([
    ...Object.keys(config.optionAliases ?? {}),
    ...Object.keys(config.positionals ?? {}),
    ...Object.keys(config.results ?? {}),
  ]);
  if (config.defaultCommand !== undefined) configuredNames.add(config.defaultCommand);
  for (const name of configuredNames) {
    if (!commands.has(name)) {
      throw new Error(`[stitchkit] CLI policy targets unavailable command "${name}"`);
    }
  }
}
