/**
 * Turn a CLI `argv` slice into the flat argument object `executeToolMethod`
 * parses — the CLI transport's front half, the counterpart of how the HTTP
 * transport slices a `Request`.
 *
 * Two jobs the other transports never face:
 *  1. **Reserved options.** `--json`, `--wait`, `--output-dir`, … are CLI
 *     behaviour, not tool arguments — they are stripped before the rest is read
 *     as tool args.
 *  2. **String → typed coercion.** Every argv token is a string; the tool's Zod
 *     schema says what each field should be. We coerce primitives here
 *     (`--count 5` → `5`, `--flag` → `true`) and leave array / object values as
 *     strings for `executeToolMethod`'s `coerceJson` pass (the same path the MCP
 *     transport uses for an LLM's double-serialized JSON).
 *
 * The advertised schema is never mutated — coercion operates on the arguments,
 * so a CLI call validates against the exact same contract schema an HTTP or MCP
 * call does (ADR 0014 parity).
 */
import { z } from 'zod';
import { coerceJsonArgs } from '../schema/coerce';
import {
  coerceField,
  describeSchemaFields,
  describeSchemaPath,
  type FieldInfo,
  looseCoerce,
  separateBoolValue,
  setNested,
} from './args-fields';
import { appendCliFieldValue, cliFieldOption, coerceCliFieldValue } from './args-json';
import { classifyLongOptionToken, isOptionToken } from './args-route';
import { type CliTokens, readCliTokens } from './args-tokens';
import { type CliResultView, resolveCliView } from './args-view';

import { CliArgumentError } from './argument-error';

type FieldResolver = (name: string) => FieldInfo | undefined;

/** CLI-behaviour flags, parsed out of argv before the tool arguments. */
export interface CliRunOptions {
  /** `--json` — emit compact success/error JSON records for scripts. */
  json: boolean;
  /** `--wait` — block-poll an async result to a terminal state. */
  wait: boolean;
  /** `--wait-timeout <seconds>` — override the poll timeout. */
  waitTimeout?: number;
  /** `--output-dir <dir>` — download result media into this directory. */
  outputDir?: string;
  /** `--quiet` — suppress non-essential stderr chatter. */
  quiet: boolean;
  /** `--dry-run` — print the resolved call instead of executing it. */
  dryRun: boolean;
  /** `--help` / `-h` — print usage for the command. */
  help: boolean;
  /** `--count-by` / `--sum` / `--top` / `--table` — aggregate instead of the collection. */
  view?: CliResultView;
}

export interface ParsedCliArgs {
  /** The flat tool-argument object handed to `executeToolMethod`. */
  toolArgs: Record<string, unknown>;
  /** The CLI-behaviour flags. */
  options: CliRunOptions;
}

/**
 * Phase two: build the argument object from the sorted tokens — positionals
 * into their fields, flags coerced to their field kinds, dotted paths nested.
 */
function buildToolArgs(
  tokens: CliTokens,
  fields: ReturnType<typeof describeSchemaFields>,
  fieldFor: FieldResolver,
  declaredPositionals: readonly string[] | undefined,
  allowUnknown: boolean,
): Record<string, unknown> {
  const { flags, jsonFields, literalBooleanFlags, positionals } = tokens;
  // Without an explicit positional policy, a bare token beside an array flag
  // could be its next element or an unrelated schema-order field. Refuse before
  // assigning either meaning; aliases and dotted leaves use the same resolver.
  if (declaredPositionals === undefined && positionals.length > 0) {
    const arrayFlag = [...flags.keys()].find((key) => fieldFor(key)?.kind === 'array');
    if (arrayFlag !== undefined) {
      throw new CliArgumentError(
        `--${arrayFlag} cannot be combined with automatic positional arguments. Repeat --${arrayFlag} for each element or use --${arrayFlag}:=JSON; name other fields with flags, or declare a positional policy.`,
      );
    }
  }
  // ── Build the tool-argument object ──
  const toolArgs: Record<string, unknown> = {};

  // Positionals fill non-boolean fields in declaration order, skipping any the
  // caller already set with a flag.
  const fillable =
    declaredPositionals === undefined
      ? [...fields.entries()]
          .filter(([, info]) => info.kind !== 'boolean')
          .map(([name]) => name)
      : [...declaredPositionals];
  // A trailing ARRAY field swallows every remaining token — `handoff proj a.md
  // b.md` instead of `--files '["a.md","b.md"]'`. Only an EXPLICIT positional
  // policy opts into this: under the automatic schema order an array field is
  // just one more field in the list, and making it variadic there would turn a
  // caller's extra token from a loud `Unexpected positional argument` into a
  // silent element of some unrelated array.
  const variadicTail =
    declaredPositionals !== undefined &&
    fields.get(fillable[fillable.length - 1] ?? '')?.kind === 'array'
      ? fillable[fillable.length - 1]
      : undefined;
  let pi = 0;
  for (const key of fillable) {
    if (pi >= positionals.length) break;
    if (key === variadicTail) {
      // Both forms at once has no defensible meaning — one of the two lists
      // would silently win, and which one would depend on argument order.
      if (flags.has(key)) {
        throw new CliArgumentError(
          `--${key} conflicts with the positional values for "${key}" — pass one form, not both`,
        );
      }
      toolArgs[key] = coerceField(fields.get(key), positionals.slice(pi), `<${key}>`);
      pi = positionals.length;
      break;
    }
    if (flags.has(key)) continue;
    const value = positionals[pi++];
    if (value !== undefined) {
      toolArgs[key] = coerceField(fields.get(key), [value], `<${key}>`);
    }
  }
  if (pi < positionals.length) {
    throw new CliArgumentError(`Unexpected positional argument "${positionals[pi]}"`);
  }

  // A plain `--meta {json}` and a dotted `--meta.a` fight over the same root:
  // whichever ran last would silently destroy the other, making the RESULT
  // depend on argument order. Refuse the combination outright.
  const dottedRoots = new Map<string, string>();
  for (const key of flags.keys()) {
    const dot = key.indexOf('.');
    const exactLiteralBoolean = literalBooleanFlags.has(key) && fields.has(key);
    if (dot > 0 && !exactLiteralBoolean) {
      dottedRoots.set(key.slice(0, dot), key);
    }
  }
  for (const [root, dotted] of dottedRoots) {
    if (flags.has(root)) {
      throw new CliArgumentError(
        `--${root} conflicts with --${dotted} — pass one form, not both`,
      );
    }
  }

  for (const key of jsonFields) {
    for (const other of flags.keys()) {
      if (other.startsWith(`${key}.`) || key.startsWith(`${other}.`)) {
        throw new CliArgumentError(
          `--${key} conflicts with --${other} — pass one form, not both`,
        );
      }
    }
  }

  for (const [key, values] of flags) {
    const info = fieldFor(key);
    // Presence and aliases address an exact boolean field; canonical inline
    // dotted options retain the nested-path grammar of value options.
    const exactLiteralBoolean = literalBooleanFlags.has(key) && fields.has(key);
    if (key.includes('.') && !exactLiteralBoolean) {
      const root = key.split('.')[0] ?? key;
      const value =
        !jsonFields.has(key) && info === undefined && allowUnknown && !fields.has(root)
          ? looseCoerce(values[0] ?? '')
          : coerceCliFieldValue(info, values, `--${key}`, jsonFields.has(key));
      setNested(toolArgs, key.split('.'), value);
      continue;
    }
    toolArgs[key] = coerceCliFieldValue(info, values, `--${key}`, jsonFields.has(key));
  }
  return toolArgs;
}

/**
 * Parse one command's argv against its schema: lexical/coerced flags, explicit
 * `--field:=JSON`, dotted paths, boolean presence and declared positionals.
 */
export function parseCliArgs(
  argv: string[],
  schema: z.ZodType | undefined,
  config: {
    allowUnknown?: boolean;
    knownFields?: readonly string[];
    optionAliases?: ReadonlyMap<string, string>;
    positionals?: readonly string[];
  } = {},
): ParsedCliArgs {
  const fields = describeSchemaFields(schema);
  for (const name of config.knownFields ?? []) {
    if (!fields.has(name)) fields.set(name, { kind: 'other' });
  }
  const fieldFor: FieldResolver = (name) =>
    fields.get(name) ??
    (name.includes('.') ? describeSchemaPath(schema, name.split('.')) : undefined);
  const tokens = readCliTokens(argv, fields, fieldFor, config);
  const { options } = tokens;
  const view = resolveCliView(tokens.viewFlags, tokens.ascending);
  if (view) options.view = view;
  return {
    toolArgs: buildToolArgs(
      tokens,
      fields,
      fieldFor,
      config.positionals,
      config.allowUnknown === true,
    ),
    options,
  };
}

/** The application's own global options, lifted out of one invocation's argv. */
export interface CliGlobalOptionsParse {
  /** argv with the application-global tokens removed, ready for routing. */
  argv: string[];
  /** The validated values, as the application's own schema types them. */
  globals: Record<string, unknown>;
}

/** The argument error for the first issue of an application option's validation. */
function refuseGlobalOption(issue: z.core.$ZodIssue | undefined): never {
  const field = issue?.path[0];
  const where = typeof field === 'string' ? `--${field}` : 'application option';
  throw new CliArgumentError(`${where}: ${issue?.message ?? 'invalid value'}`);
}

/**
 * Lift the APPLICATION's global options out of argv, wherever they stand.
 *
 * These are not arguments of any operation: which identity key to use, which
 * checkout a call speaks for, which profile. They belong to the invocation, so
 * they may precede the command name as easily as follow it — and a command's
 * own parser must never see them, or an app-global would read as an unknown
 * flag on every operation that does not declare it.
 *
 * Stripping them BEFORE routing is what keeps this one grammar rather than two:
 * `routeCliArgv` then sees a command where a command is, `parseCliArgs` sees
 * only operation arguments, and `passthrough` cannot swallow an app-global into
 * a freeform bag. The token shape is the same `classifyLongOptionToken` the
 * framework's own globals use, so `--root /x`, `--root=/x` and a bare boolean
 * `--verbose` all behave as they do everywhere else.
 *
 * `--` ends the sweep: past it every token is a literal value, so a positional
 * that happens to read as `--root` survives intact.
 */
export function extractCliGlobalOptions(
  argv: readonly string[],
  schema: z.ZodObject | undefined,
): CliGlobalOptionsParse {
  if (schema === undefined) return { argv: [...argv], globals: {} };
  const fields = describeSchemaFields(schema);
  const rest: string[] = [];
  const raw = new Map<string, string[]>();
  const jsonFields = new Set<string>();
  let ended = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined) continue;
    if (!ended && token === '--') ended = true;
    const option = ended ? undefined : classifyLongOptionToken(token);
    // A framework-global name wins — an application may not redeclare one, and
    // that is refused at startup rather than silently resolved here.
    const field = option ? cliFieldOption(option, fields) : undefined;
    const info =
      field && option?.globalKind === undefined ? fields.get(field.name) : undefined;
    if (!option || !field || !info) {
      rest.push(token);
      continue;
    }
    let { value } = option;
    if (value === undefined && info.kind === 'boolean') {
      const separate = separateBoolValue(argv[i + 1]);
      if (separate !== undefined) i++;
      value = String(separate ?? true);
    } else if (value === undefined) {
      const next = argv[i + 1];
      if (next !== undefined && !isOptionToken(next)) {
        value = next;
        i++;
      } else {
        throw new CliArgumentError(`--${option.name} requires a value`);
      }
    }
    appendCliFieldValue(raw, jsonFields, field.name, value, info, field.json);
  }

  const args: Record<string, unknown> = {};
  for (const [name, values] of raw) {
    args[name] = coerceCliFieldValue(
      fields.get(name),
      values,
      `--${name}`,
      jsonFields.has(name),
    );
  }
  let coerced: Record<string, unknown>;
  try {
    coerced = coerceJsonArgs(args, schema);
  } catch (error) {
    if (error instanceof z.ZodError) refuseGlobalOption(error.issues[0]);
    throw error;
  }
  const parsed = schema.safeParse(coerced);
  if (!parsed.success) refuseGlobalOption(parsed.error.issues[0]);
  return { argv: rest, globals: parsed.data };
}
