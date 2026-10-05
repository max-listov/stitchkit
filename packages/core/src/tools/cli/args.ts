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
import { isUnsafeKey } from '../../internal/safe-json';
import { coerceJsonArgs } from '../schema/coerce';
import {
  appendCliOptionValue,
  coerceField,
  describeSchemaFields,
  looseCoerce,
  parseReservedBool,
  separateBoolValue,
  setNested,
} from './args-fields';
import {
  classifyLongOptionToken,
  isOptionToken,
  looksLikeOption,
  VIEW_OPTIONS,
} from './args-route';
import { type CliResultView, resolveCliView } from './args-view';
import { CliArgumentError } from './argument-error';

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
 * Parse a command's argv slice (everything after the command name) against its
 * merged tool schema.
 *
 * Supported forms:
 *  - `--key value` / `--key=value` / `-` repeated for arrays
 *  - `--flag` boolean presence, `--flag true|false` as a separate token, `--no-flag` to negate
 *  - `--a.b=c` dotted path → nested object (loose-coerced leaf)
 *  - positional args fill non-boolean fields in schema-declaration order
 */
type CliConfigForParse = NonNullable<Parameters<typeof parseCliArgs>[2]>;

/** One invocation's argv, sorted into what each token is for. */
interface CliTokens {
  options: CliRunOptions;
  /** Raw values per flag, in order; only an array field may have several. */
  flags: Map<string, string[]>;
  /** Boolean presence and aliases name exact fields, even when the name has a dot. */
  literalBooleanFlags: Set<string>;
  viewFlags: Map<string, string>;
  ascending: boolean;
  positionals: string[];
}

/**
 * Phase one: tokenise. Every refusal about the SHAPE of the command line —
 * an unknown option, a missing value, a prototype-polluting name, a repeated
 * non-array flag — happens here, before its raw multiplicity can be lost.
 */
function readCliTokens(
  argv: readonly string[],
  fields: ReturnType<typeof describeSchemaFields>,
  config: CliConfigForParse,
): CliTokens {
  const options: CliRunOptions = {
    json: false,
    wait: false,
    quiet: false,
    dryRun: false,
    help: false,
  };

  const flags = new Map<string, string[]>();
  const literalBooleanFlags = new Set<string>();
  const frameworkFlags = new Map<string, string[]>();
  const viewFlags = new Map<string, string>();
  let ascending = false;
  const positionals: string[] = [];

  const pushFlag = (name: string, value: string): void => {
    appendCliOptionValue(flags, name, value, fields.get(name));
  };

  let optionsEnded = false;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === undefined) continue;
    if (!optionsEnded && tok === '--') {
      optionsEnded = true;
      continue;
    }
    if (optionsEnded || !looksLikeOption(tok)) {
      positionals.push(tok);
      continue;
    }
    if (tok === '-h') {
      options.help = true;
      continue;
    }
    if (!tok.startsWith('--')) {
      const match = /^-([A-Za-z])(?:=(.*))?$/.exec(tok);
      const alias = match?.[1];
      const field = alias === undefined ? undefined : config.optionAliases?.get(alias);
      if (!alias || !field) throw new CliArgumentError(`Unknown option "${tok}"`);
      const inline = match?.[2];
      const info = fields.get(field);
      if (info?.kind === 'boolean') {
        const separate = inline === undefined ? separateBoolValue(argv[i + 1]) : undefined;
        if (separate !== undefined) i++;
        pushFlag(field, inline ?? String(separate ?? true));
        if (inline !== undefined) parseReservedBool(field, inline);
        literalBooleanFlags.add(field);
        continue;
      }
      let value = inline;
      if (value === undefined) {
        const next = argv[i + 1];
        if (next !== undefined && !isOptionToken(next)) {
          value = next;
          i++;
        } else {
          throw new CliArgumentError(`--${field} requires a value`);
        }
      }
      pushFlag(field, value);
      continue;
    }
    const option = classifyLongOptionToken(tok);
    if (!option) throw new CliArgumentError(`Unknown option "${tok}"`);
    const { name } = option;
    let { value } = option;
    if (name.length === 0) throw new CliArgumentError('Invalid empty option name');

    if (option.globalKind === 'boolean') {
      const separate = value === undefined ? separateBoolValue(argv[i + 1]) : undefined;
      if (separate !== undefined) i++;
      // Help is a request, not a setting: asking twice asks once.
      if (name !== 'help') {
        appendCliOptionValue(frameworkFlags, name, value ?? String(separate ?? true), {
          kind: 'boolean',
        });
      }
      const enabled =
        value === undefined ? (separate ?? true) : parseReservedBool(name, value);
      if (name === 'dry-run') options.dryRun = enabled;
      else if (name === 'json') options.json = enabled;
      else if (name === 'wait') options.wait = enabled;
      else if (name === 'quiet') options.quiet = enabled;
      else if (name === 'ascending') ascending = enabled;
      else options.help = options.help || enabled;
      continue;
    }
    if (option.globalKind === 'value') {
      const next = argv[i + 1];
      value = value ?? next;
      if (value === undefined || (!option.inline && isOptionToken(value))) {
        throw new CliArgumentError(`--${name} requires a value`);
      }
      if (!option.inline) i++;
      appendCliOptionValue(frameworkFlags, name, value, { kind: 'string' });
      if (name === 'wait-timeout') {
        const timeout = Number(value);
        if (!Number.isFinite(timeout) || timeout <= 0) {
          throw new CliArgumentError('--wait-timeout must be a positive number');
        }
        options.waitTimeout = timeout;
      } else if (VIEW_OPTIONS.has(name)) {
        viewFlags.set(name, value);
      } else {
        options.outputDir = value;
      }
      continue;
    }

    if (
      value === undefined &&
      name.startsWith('no-') &&
      fields.get(name.slice(3))?.kind === 'boolean'
    ) {
      pushFlag(name.slice(3), 'false');
      literalBooleanFlags.add(name.slice(3));
      continue;
    }

    // Client-controlled names — refuse a prototype-polluting segment loudly
    // instead of silently dropping the argument.
    const unsafeSegment = name.split('.').find(isUnsafeKey);
    if (unsafeSegment !== undefined) {
      throw new CliArgumentError(`Unsafe option name "--${name}"`);
    }
    const info = fields.get(name);
    const rootName = name.split('.')[0] ?? name;
    if (!fields.has(rootName) && !config.allowUnknown) {
      throw new CliArgumentError(`Unknown option "--${name}"`);
    }
    if (value === undefined) {
      if (info?.kind === 'boolean') {
        const separate = separateBoolValue(argv[i + 1]);
        if (separate !== undefined) i++;
        pushFlag(name, String(separate ?? true));
        literalBooleanFlags.add(name);
        continue;
      }
      // The next token is the value unless it is itself an option: `--grep
      // -foo` and `--count -5` are values, `--grep --json` is a missing one.
      const next = argv[i + 1];
      if (next !== undefined && !isOptionToken(next)) {
        value = next;
        i++;
      } else {
        throw new CliArgumentError(`--${name} requires a value`);
      }
    }
    pushFlag(name, value);
  }
  return { options, flags, literalBooleanFlags, viewFlags, ascending, positionals };
}

/**
 * Phase two: build the argument object from the sorted tokens — positionals
 * into their fields, flags coerced to their field kinds, dotted paths nested.
 */
function buildToolArgs(
  tokens: CliTokens,
  fields: ReturnType<typeof describeSchemaFields>,
  declaredPositionals: readonly string[] | undefined,
): Record<string, unknown> {
  const { flags, literalBooleanFlags, positionals } = tokens;
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
    if (dot > 0 && !literalBooleanFlags.has(key)) {
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

  for (const [key, values] of flags) {
    const info = fields.get(key);
    // Presence and aliases address an exact boolean field; canonical inline
    // dotted options retain the nested-path grammar of value options.
    if (key.includes('.') && !literalBooleanFlags.has(key)) {
      setNested(toolArgs, key.split('.'), looseCoerce(values[0] ?? ''));
      continue;
    }
    toolArgs[key] = coerceField(info, values, `--${key}`);
  }
  return toolArgs;
}

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
  const tokens = readCliTokens(argv, fields, config);
  const { options } = tokens;
  const view = resolveCliView(tokens.viewFlags, tokens.ascending);
  if (view) options.view = view;
  return { toolArgs: buildToolArgs(tokens, fields, config.positionals), options };
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
  let ended = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined) continue;
    if (!ended && token === '--') ended = true;
    const option = ended ? undefined : classifyLongOptionToken(token);
    // A framework-global name wins — an application may not redeclare one, and
    // that is refused at startup rather than silently resolved here.
    const info =
      option && option.globalKind === undefined ? fields.get(option.name) : undefined;
    if (!option || !info) {
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
    appendCliOptionValue(raw, option.name, value, info);
  }

  const args: Record<string, unknown> = {};
  for (const [name, values] of raw) {
    args[name] = coerceField(fields.get(name), values, `--${name}`);
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
