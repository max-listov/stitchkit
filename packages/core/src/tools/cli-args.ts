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

/** CLI-behaviour flags, parsed out of argv before the tool arguments. */
export interface CliRunOptions {
  /** `--json` — emit raw JSON on stdout for piping. */
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
}

export interface ParsedCliArgs {
  /** The flat tool-argument object handed to `executeToolMethod`. */
  toolArgs: Record<string, unknown>;
  /** The CLI-behaviour flags. */
  options: CliRunOptions;
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

const BOOL_OPTIONS = new Set(['json', 'wait', 'quiet', 'dry-run', 'help']);
const VALUE_OPTIONS = new Set(['wait-timeout', 'output-dir']);
export const RESERVED_CLI_OPTIONS = new Set([...BOOL_OPTIONS, ...VALUE_OPTIONS]);

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
  config: { allowUnknown?: boolean; knownFields?: readonly string[] } = {},
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
      throw new CliArgumentError(`Unknown option "${tok}"`);
    }
    const eq = tok.indexOf('=');
    const name = eq >= 0 ? tok.slice(2, eq) : tok.slice(2);
    let value: string | undefined = eq >= 0 ? tok.slice(eq + 1) : undefined;
    if (name.length === 0) throw new CliArgumentError('Invalid empty option name');

    if (BOOL_OPTIONS.has(name)) {
      const enabled = value === undefined ? true : parseReservedBool(name, value);
      if (name === 'dry-run') options.dryRun = enabled;
      else if (name === 'json') options.json = enabled;
      else if (name === 'wait') options.wait = enabled;
      else if (name === 'quiet') options.quiet = enabled;
      else options.help = enabled;
      continue;
    }
    if (VALUE_OPTIONS.has(name)) {
      const next = argv[i + 1];
      value = value ?? next;
      if (value === undefined || (value.startsWith('-') && !NUMERIC_VALUE.test(value))) {
        throw new CliArgumentError(`--${name} requires a value`);
      }
      if (eq < 0) i++;
      if (name === 'wait-timeout') {
        const timeout = Number(value);
        if (!Number.isFinite(timeout) || timeout <= 0) {
          throw new CliArgumentError('--wait-timeout must be a positive number');
        }
        options.waitTimeout = timeout;
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

  // ── Build the tool-argument object ──
  const toolArgs: Record<string, unknown> = {};

  // Positionals fill non-boolean fields in declaration order, skipping any the
  // caller already set with a flag.
  const fillable = [...fields.entries()]
    .filter(([, info]) => info.kind !== 'boolean')
    .map(([name]) => name);
  let pi = 0;
  for (const key of fillable) {
    if (pi >= positionals.length) break;
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
