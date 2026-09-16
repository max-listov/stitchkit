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
import { isUnsafeKey } from '../internal/safe-json';
import { isRecord } from '../internal/typed';
import { coerceJsonArgs } from './coerce';

/**
 * A requested aggregate view over the result.
 *
 * `--by` always names the grouping field, in every form it appears in, so the
 * grammar has one meaning rather than two: `--top 5 --by status` is the five
 * largest groups of `status`, exactly as `--count-by status --top 5` is.
 */
export type CliResultView =
  | { kind: 'count'; field: string; top?: number }
  | { kind: 'sum'; field: string; by?: string; top?: number }
  | {
      kind: 'records';
      sort?: string;
      ascending?: boolean;
      top?: number;
      table?: readonly string[];
    };

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

export interface CliArgvRoute {
  command?: string;
  commandArgv: string[];
  topLevelHelp: boolean;
  version: boolean;
  /** `--help <substring>` — narrow the command list instead of printing it whole. */
  helpFilter?: string;
  error?: string;
}

type FieldKind =
  | 'boolean'
  | 'number'
  | 'bigint'
  | 'date'
  | 'string'
  | 'enum'
  | 'array'
  | 'object'
  | 'other';

interface FieldInfo {
  kind: FieldKind;
  /** Element kind for an `array` field — drives per-element coercion. */
  elementKind?: FieldKind;
}

/** A `-`-leading token that still reads as a value: a negative number. */
const NUMERIC_VALUE = /^-(\d+\.?\d*|\.\d+)$/;

const BOOL_OPTIONS = new Set(['json', 'wait', 'quiet', 'dry-run', 'help', 'ascending']);
const VIEW_OPTIONS = new Set(['count-by', 'sum', 'by', 'top', 'table', 'sort']);
const VALUE_OPTIONS = new Set(['wait-timeout', 'output-dir', ...VIEW_OPTIONS]);
export const RESERVED_CLI_OPTIONS = new Set([...BOOL_OPTIONS, ...VALUE_OPTIONS]);

interface CliLongOptionToken {
  name: string;
  value?: string;
  inline: boolean;
  globalKind?: 'boolean' | 'value';
}

/** One source of truth for long-option token shape and framework-global ownership. */
function classifyLongOptionToken(token: string): CliLongOptionToken | undefined {
  if (!token.startsWith('--') || token === '--') return undefined;
  const equals = token.indexOf('=');
  const name = equals >= 0 ? token.slice(2, equals) : token.slice(2);
  return {
    name,
    value: equals >= 0 ? token.slice(equals + 1) : undefined,
    inline: equals >= 0,
    globalKind: BOOL_OPTIONS.has(name)
      ? 'boolean'
      : VALUE_OPTIONS.has(name)
        ? 'value'
        : undefined,
  };
}

/**
 * Select a command without duplicating the framework-global option grammar.
 * With no default configured this returns the historical first-token routing
 * byte-for-byte. With a default, recognised leading globals may precede an
 * explicit command; a remaining option token belongs to the default command.
 */
const HELP_TOKENS = new Set(['--help', '-h', 'help']);

/**
 * The substring after a help token, in any of the forms a person types it.
 *
 * `--help=false` is NOT one of them: `--help` is a reserved boolean and the
 * inline form has always been its negation, so a boolean word keeps the meaning
 * it had. Only a value that is not one narrows the listing.
 */
function helpFilterFrom(
  token: string | undefined,
  rest: readonly string[],
): string | undefined {
  if (token?.startsWith('--help=')) {
    const value = token.slice('--help='.length).trim();
    if (value.length === 0 || isReservedBoolWord(value)) return undefined;
    return value;
  }
  if (token === undefined || !HELP_TOKENS.has(token)) return undefined;
  const next = rest[0];
  return next !== undefined && !next.startsWith('-') ? next : undefined;
}

export function routeCliArgv(argv: string[], defaultCommand?: string): CliArgvRoute {
  if (defaultCommand === undefined) {
    const [command, ...commandArgv] = argv;
    const helpFilter = helpFilterFrom(command, commandArgv);
    return {
      command,
      commandArgv,
      topLevelHelp: false,
      version: false,
      ...(helpFilter !== undefined && { helpFilter }),
    };
  }

  const globals: string[] = [];
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === undefined) break;
    if (token === '--') {
      return {
        commandArgv: [],
        topLevelHelp: false,
        version: false,
        error: 'A command is required before "--"',
      };
    }
    // `--help=false` is the reserved boolean's negation and keeps that meaning;
    // only a non-boolean inline value asks the narrower question.
    const inlineHelpFilter =
      token.startsWith('--help=') && !isReservedBoolWord(token.slice('--help='.length));
    if (token === '--help' || token === '-h' || inlineHelpFilter) {
      const helpFilter = helpFilterFrom(token, argv.slice(index + 1));
      return {
        commandArgv: [],
        topLevelHelp: true,
        version: false,
        ...(helpFilter !== undefined && { helpFilter }),
      };
    }
    if (token === '--version' || token === 'version') {
      return { commandArgv: [], topLevelHelp: false, version: true };
    }
    if (!token.startsWith('-') || token === '-') {
      return {
        command: token,
        commandArgv: [...globals, ...argv.slice(index + 1)],
        topLevelHelp: false,
        version: false,
      };
    }
    if (!token.startsWith('--')) {
      return {
        command: defaultCommand,
        commandArgv: [...globals, ...argv.slice(index)],
        topLevelHelp: false,
        version: false,
      };
    }

    const option = classifyLongOptionToken(token);
    if (!option) {
      return {
        command: defaultCommand,
        commandArgv: [...globals, ...argv.slice(index)],
        topLevelHelp: false,
        version: false,
      };
    }
    if (option.globalKind === 'boolean') {
      globals.push(token);
      index += 1;
      continue;
    }
    if (option.globalKind === 'value') {
      globals.push(token);
      if (!option.inline) {
        const value = argv[index + 1];
        if (value === '--help' || value === '-h') {
          const helpFilter = helpFilterFrom(value, argv.slice(index + 2));
          return {
            commandArgv: [],
            topLevelHelp: true,
            version: false,
            ...(helpFilter !== undefined && { helpFilter }),
          };
        }
        if (value === '--version' || value === 'version') {
          return { commandArgv: [], topLevelHelp: false, version: true };
        }
        if (value !== undefined) globals.push(value);
        index += value === undefined ? 1 : 2;
      } else {
        index += 1;
      }
      continue;
    }
    return {
      command: defaultCommand,
      commandArgv: [...globals, ...argv.slice(index)],
      topLevelHelp: false,
      version: false,
    };
  }
  return {
    command: defaultCommand,
    commandArgv: globals,
    topLevelHelp: false,
    version: false,
  };
}

export class CliArgumentError extends Error {
  override name = 'CliArgumentError';
}

/** Strip `.optional()` / `.nullable()` / `.default()` wrappers to the base type. */
function unwrap(field: z.core.$ZodType): z.core.$ZodType {
  if (
    field instanceof z.ZodOptional ||
    field instanceof z.ZodNullable ||
    field instanceof z.ZodDefault
  ) {
    return unwrap(field.unwrap());
  }
  return field;
}

function classify(field: z.core.$ZodType): FieldKind {
  if (field instanceof z.ZodBoolean) return 'boolean';
  if (field instanceof z.ZodNumber) return 'number';
  if (field instanceof z.ZodBigInt) return 'bigint';
  if (field instanceof z.ZodDate) return 'date';
  if (field instanceof z.ZodEnum) return 'enum';
  if (field instanceof z.ZodArray) return 'array';
  if (field instanceof z.ZodObject) return 'object';
  if (field instanceof z.ZodString || field instanceof z.ZodLiteral) return 'string';
  return 'other';
}

/**
 * Merge one field into the map. On a kind conflict between members, presence
 * semantics win: a field that is boolean in ANY member must stay usable as a
 * bare `--flag`; any other mismatch degrades to `other` (raw string, the
 * schema validates it).
 */
function mergeField(fields: Map<string, FieldInfo>, name: string, info: FieldInfo): void {
  const existing = fields.get(name);
  if (!existing) {
    fields.set(name, info);
    return;
  }
  if (existing.kind === info.kind) return;
  if (existing.kind === 'boolean' || info.kind === 'boolean') {
    fields.set(name, { kind: 'boolean' });
    return;
  }
  fields.set(name, { kind: 'other' });
}

function collectSchemaFields(schema: z.core.$ZodType, fields: Map<string, FieldInfo>): void {
  const base = unwrap(schema);
  if (base instanceof z.ZodObject) {
    for (const [name, raw] of Object.entries(base.shape)) {
      const fieldBase = unwrap(raw);
      const kind = classify(fieldBase);
      if (kind === 'array' && fieldBase instanceof z.ZodArray) {
        mergeField(fields, name, { kind, elementKind: classify(unwrap(fieldBase.element)) });
      } else {
        mergeField(fields, name, { kind });
      }
    }
    return;
  }
  if (base instanceof z.ZodUnion) {
    for (const option of base.def.options) collectSchemaFields(option, fields);
    return;
  }
  if (base instanceof z.ZodIntersection) {
    collectSchemaFields(base.def.left, fields);
    collectSchemaFields(base.def.right, fields);
    return;
  }
}

/**
 * Map a merged tool schema to per-field kind info — what each `--flag` should
 * coerce to. Object members of unions and intersections contribute their
 * fields too, so a boolean member of a union stays reachable as a bare flag; a
 * scalar schema yields an empty map and every value is left as a string.
 */
export function describeSchemaFields(schema: z.ZodType | undefined): Map<string, FieldInfo> {
  const fields = new Map<string, FieldInfo>();
  if (schema) collectSchemaFields(schema, fields);
  return fields;
}

const TRUE_WORDS = new Set(['true', '1', 'yes', 'on']);
const FALSE_WORDS = new Set(['false', '0', 'no', 'off']);

/** Strict boolean for a RESERVED option — an unrecognised value is a usage error, never a silent `true`. */
/** True for a value the reserved-boolean grammar already claims. */
export function isReservedBoolWord(value: string): boolean {
  const word = value.toLowerCase();
  return TRUE_WORDS.has(word) || FALSE_WORDS.has(word);
}

function parseReservedBool(name: string, value: string): boolean {
  const v = value.toLowerCase();
  if (TRUE_WORDS.has(v)) return true;
  if (FALSE_WORDS.has(v)) return false;
  throw new CliArgumentError(`--${name} expects a boolean (true/false), got "${value}"`);
}

/** Coerce one string to a scalar field kind — never throws; an un-coercible value is left raw for Zod to reject with a clear message. */
function coerceScalar(kind: FieldKind, value: string): unknown {
  switch (kind) {
    case 'boolean': {
      const v = value.toLowerCase();
      if (TRUE_WORDS.has(v)) return true;
      if (FALSE_WORDS.has(v)) return false;
      return value; // not a recognisable boolean — Zod rejects it loudly.
    }
    case 'number': {
      const n = Number(value);
      return value.trim() !== '' && !Number.isNaN(n) ? n : value;
    }
    case 'bigint':
      try {
        return BigInt(value);
      } catch {
        return value;
      }
    case 'date': {
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? value : d;
    }
    default:
      return value;
  }
}

/** Best-effort coercion for a dotted-path leaf, where the schema type is unknown. */
function looseCoerce(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  const n = Number(value);
  return value.trim() !== '' && !Number.isNaN(n) ? n : value;
}

function looksLikeJson(value: string): boolean {
  const t = value.trim();
  return t.startsWith('[') || t.startsWith('{');
}

/** Coerce the collected raw string value(s) for one field to its typed form. */
function coerceField(info: FieldInfo | undefined, values: string[]): unknown {
  const last = values[values.length - 1] ?? '';
  if (!info) return values.length > 1 ? values : last;

  if (info.kind === 'array') {
    // A single JSON-array string is left for `coerceJson`; repeated flags
    // (`--tag a --tag b`) become a coerced element array.
    if (values.length === 1 && looksLikeJson(last)) return last;
    return values.map((v) => coerceScalar(info.elementKind ?? 'string', v));
  }
  // An object field arrives as a JSON string — `coerceJson` parses it.
  if (info.kind === 'object') return last;
  return coerceScalar(info.kind, last);
}

function setNested(target: Record<string, unknown>, path: string[], value: unknown): void {
  // A dotted flag is client input — reject `--a.__proto__.x` LOUDLY before any
  // write walks the chain; a silently dropped argument reads as data loss.
  const unsafe = path.find(isUnsafeKey);
  if (unsafe !== undefined) {
    throw new CliArgumentError(`Unsafe option path segment "${unsafe}"`);
  }
  let node = target;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (key === undefined) return;
    const next = node[key];
    if (isRecord(next)) {
      node = next;
    } else {
      const created: Record<string, unknown> = {};
      node[key] = created;
      node = created;
    }
  }
  const leaf = path[path.length - 1];
  if (leaf !== undefined) node[leaf] = value;
}

/**
 * Parse a command's argv slice (everything after the command name) against its
 * merged tool schema.
 *
 * Supported forms:
 *  - `--key value` / `--key=value` / `-` repeated for arrays
 *  - `--flag` boolean presence, `--no-flag` to negate
 *  - `--a.b=c` dotted path → nested object (loose-coerced leaf)
 *  - positional args fill non-boolean fields in schema-declaration order
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
  const options: CliRunOptions = {
    json: false,
    wait: false,
    quiet: false,
    dryRun: false,
    help: false,
  };

  const fields = describeSchemaFields(schema);
  for (const name of config.knownFields ?? []) {
    if (!fields.has(name)) fields.set(name, { kind: 'other' });
  }
  const flags = new Map<string, string[]>();
  const boolFlags = new Map<string, boolean>();
  const viewFlags = new Map<string, string>();
  let ascending = false;
  const positionals: string[] = [];

  const pushFlag = (name: string, value: string): void => {
    const existing = flags.get(name);
    if (existing) existing.push(value);
    else flags.set(name, [value]);
  };

  let optionsEnded = false;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === undefined) continue;
    if (!optionsEnded && tok === '--') {
      optionsEnded = true;
      continue;
    }
    if (optionsEnded || !tok.startsWith('-') || tok === '-') {
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
        boolFlags.set(field, inline === undefined ? true : parseReservedBool(field, inline));
        continue;
      }
      let value = inline;
      if (value === undefined) {
        const next = argv[i + 1];
        if (next !== undefined && (!next.startsWith('-') || NUMERIC_VALUE.test(next))) {
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
      const enabled = value === undefined ? true : parseReservedBool(name, value);
      if (name === 'dry-run') options.dryRun = enabled;
      else if (name === 'json') options.json = enabled;
      else if (name === 'wait') options.wait = enabled;
      else if (name === 'quiet') options.quiet = enabled;
      else if (name === 'ascending') ascending = enabled;
      else options.help = enabled;
      continue;
    }
    if (option.globalKind === 'value') {
      const next = argv[i + 1];
      value = value ?? next;
      if (value === undefined || (value.startsWith('-') && !NUMERIC_VALUE.test(value))) {
        throw new CliArgumentError(`--${name} requires a value`);
      }
      if (!option.inline) i++;
      if (name === 'wait-timeout') {
        const timeout = Number(value);
        if (!Number.isFinite(timeout) || timeout <= 0) {
          throw new CliArgumentError('--wait-timeout must be a positive number');
        }
        options.waitTimeout = timeout;
      } else if (VIEW_OPTIONS.has(name)) {
        if (viewFlags.has(name)) throw new CliArgumentError(`--${name} was given twice`);
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
      boolFlags.set(name.slice(3), false);
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
        boolFlags.set(name, true);
        continue;
      }
      // A next token starting with `-` is a value only when it reads as a
      // number (`--count -5`); anything else is a misplaced option.
      const next = argv[i + 1];
      if (next !== undefined && (!next.startsWith('-') || NUMERIC_VALUE.test(next))) {
        value = next;
        i++;
      } else {
        throw new CliArgumentError(`--${name} requires a value`);
      }
    }
    pushFlag(name, value);
  }

  const view = resolveCliView(viewFlags, ascending);
  if (view) options.view = view;

  // ── Build the tool-argument object ──
  const toolArgs: Record<string, unknown> = {};

  // Positionals fill non-boolean fields in declaration order, skipping any the
  // caller already set with a flag.
  const fillable =
    config.positionals === undefined
      ? [...fields.entries()]
          .filter(([, info]) => info.kind !== 'boolean')
          .map(([name]) => name)
      : [...config.positionals];
  // A trailing ARRAY field swallows every remaining token — `handoff proj a.md
  // b.md` instead of `--files '["a.md","b.md"]'`. Only an EXPLICIT positional
  // policy opts into this: under the automatic schema order an array field is
  // just one more field in the list, and making it variadic there would turn a
  // caller's extra token from a loud `Unexpected positional argument` into a
  // silent element of some unrelated array.
  const variadicTail =
    config.positionals !== undefined &&
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
      toolArgs[key] = coerceField(fields.get(key), positionals.slice(pi));
      pi = positionals.length;
      break;
    }
    if (flags.has(key)) continue;
    const value = positionals[pi++];
    if (value !== undefined) toolArgs[key] = coerceField(fields.get(key), [value]);
  }
  if (pi < positionals.length) {
    throw new CliArgumentError(`Unexpected positional argument "${positionals[pi]}"`);
  }

  for (const [key, value] of boolFlags) {
    toolArgs[key] = value;
  }

  // A plain `--meta {json}` and a dotted `--meta.a` fight over the same root:
  // whichever ran last would silently destroy the other, making the RESULT
  // depend on argument order. Refuse the combination outright.
  const dottedRoots = new Map<string, string>();
  for (const key of flags.keys()) {
    const dot = key.indexOf('.');
    if (dot > 0) dottedRoots.set(key.slice(0, dot), key);
  }
  for (const [root, dotted] of dottedRoots) {
    if (flags.has(root)) {
      throw new CliArgumentError(
        `--${root} conflicts with --${dotted} — pass one form, not both`,
      );
    }
  }

  for (const [key, values] of flags) {
    if (key.includes('.')) {
      if (values.length > 1) {
        throw new CliArgumentError(`--${key} was passed ${values.length} times`);
      }
      setNested(toolArgs, key.split('.'), looseCoerce(values[0] ?? ''));
      continue;
    }
    const info = fields.get(key);
    // Only an array field legitimately repeats (`--tag a --tag b`); a repeated
    // scalar silently taking the last value would hide a caller mistake.
    if (
      values.length > 1 &&
      info !== undefined &&
      info.kind !== 'array' &&
      info.kind !== 'other'
    ) {
      throw new CliArgumentError(`--${key} was passed ${values.length} times`);
    }
    toolArgs[key] = coerceField(info, values);
  }

  return { toolArgs, options };
}

/** The application's own global options, lifted out of one invocation's argv. */
export interface CliGlobalOptionsParse {
  /** argv with the application-global tokens removed, ready for routing. */
  argv: string[];
  /** The validated values, as the application's own schema types them. */
  globals: Record<string, unknown>;
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
      value = 'true';
    } else if (value === undefined) {
      const next = argv[i + 1];
      if (next !== undefined && (!next.startsWith('-') || NUMERIC_VALUE.test(next))) {
        value = next;
        i++;
      } else {
        throw new CliArgumentError(`--${option.name} requires a value`);
      }
    }
    const existing = raw.get(option.name);
    if (existing) existing.push(value);
    else raw.set(option.name, [value]);
  }

  const args: Record<string, unknown> = {};
  for (const [name, values] of raw) args[name] = coerceField(fields.get(name), values);
  const parsed = schema.safeParse(coerceJsonArgs(args, schema));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path[0];
    const where = typeof field === 'string' ? `--${field}` : 'application option';
    throw new CliArgumentError(`${where}: ${issue?.message ?? 'invalid value'}`);
  }
  return { argv: rest, globals: parsed.data };
}

/**
 * Turn the raw view flags into one view, or refuse the combination.
 *
 * Refusing here rather than at emission time is the point: a caller who asked
 * for two aggregates at once, or for `--by` with nothing to group, gets the
 * message before the command runs, not a shape they did not ask for after it.
 */
function resolveCliView(
  flags: ReadonlyMap<string, string>,
  ascending: boolean,
): CliResultView | undefined {
  if (flags.size === 0) {
    if (ascending) {
      throw new CliArgumentError('--ascending orders a record view; pass --sort with it');
    }
    return undefined;
  }
  const countBy = flags.get('count-by');
  const sum = flags.get('sum');
  const table = flags.get('table');
  const by = flags.get('by');
  const rawTop = flags.get('top');

  const named = [
    ['--count-by', countBy],
    ['--sum', sum],
  ].filter(([, value]) => value !== undefined);
  if (named.length > 1) {
    throw new CliArgumentError(
      `${named.map(([flag]) => flag).join(' and ')} ask for different shapes — pass one`,
    );
  }

  let top: number | undefined;
  if (rawTop !== undefined) {
    top = Number(rawTop);
    if (!Number.isInteger(top) || top <= 0) {
      throw new CliArgumentError('--top must be a positive whole number');
    }
  }

  const sort = flags.get('sort');

  // `--table` and `--sort` describe the same view — the records themselves — so
  // they compose. `--top` keeps the single meaning it has everywhere: the n
  // leading entries of whatever view was asked for, groups or records.
  if (table !== undefined || sort !== undefined) {
    if (countBy !== undefined || sum !== undefined) {
      throw new CliArgumentError(
        `${table !== undefined ? '--table' : '--sort'} lists records; --count-by and --sum aggregate them — pass one`,
      );
    }
    if (by !== undefined) {
      throw new CliArgumentError('--by groups a view; a record view orders with --sort');
    }
    if (top !== undefined && sort === undefined) {
      throw new CliArgumentError(
        '--top needs --sort here: unordered records have no n largest',
      );
    }
    let fields: string[] | undefined;
    if (table !== undefined) {
      fields = table
        .split(',')
        .map((field) => field.trim())
        .filter(Boolean);
      if (fields.length === 0) throw new CliArgumentError('--table needs at least one field');
    }
    return {
      kind: 'records',
      ...(sort !== undefined && { sort }),
      ...(ascending && { ascending }),
      ...(top !== undefined && { top }),
      ...(fields && { table: fields }),
    };
  }

  if (ascending) {
    throw new CliArgumentError('--ascending orders a record view; pass --sort with it');
  }

  if (sum !== undefined) {
    if (top !== undefined && by === undefined) {
      throw new CliArgumentError('--top needs --by: a single sum has nothing to rank');
    }
    return {
      kind: 'sum',
      field: sum,
      ...(by !== undefined && { by }),
      ...(top !== undefined && { top }),
    };
  }

  if (countBy !== undefined) {
    if (by !== undefined) {
      throw new CliArgumentError('--count-by already names the grouping field; drop --by');
    }
    return { kind: 'count', field: countBy, ...(top !== undefined && { top }) };
  }

  if (by !== undefined) {
    if (top === undefined) {
      throw new CliArgumentError(
        '--by groups a view; pass --count-by, --sum or --top with it',
      );
    }
    return { kind: 'count', field: by, top };
  }
  throw new CliArgumentError('--top needs --sort, --by, --count-by or --sum to rank');
}
