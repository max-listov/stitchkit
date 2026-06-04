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

const BOOL_OPTIONS = new Set(['json', 'wait', 'quiet', 'dry-run', 'help']);
const VALUE_OPTIONS = new Set(['wait-timeout', 'output-dir']);

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
 * Map a merged tool schema to per-field kind info — what each `--flag` should
 * coerce to. A non-object schema (a union) yields an empty map: every value is
 * left as a string and the schema validates it.
 */
export function describeSchemaFields(schema: z.ZodType | undefined): Map<string, FieldInfo> {
  const fields = new Map<string, FieldInfo>();
  if (!(schema instanceof z.ZodObject)) return fields;
  for (const [name, raw] of Object.entries(schema.shape)) {
    const base = unwrap(raw);
    const kind = classify(base);
    if (kind === 'array' && base instanceof z.ZodArray) {
      fields.set(name, { kind, elementKind: classify(unwrap(base.element)) });
    } else {
      fields.set(name, { kind });
    }
  }
  return fields;
}

function parseBool(value: string): boolean {
  const v = value.toLowerCase();
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  return true;
}

/** Coerce one string to a scalar field kind — never throws; an un-coercible value is left raw for Zod to reject with a clear message. */
function coerceScalar(kind: FieldKind, value: string): unknown {
  switch (kind) {
    case 'boolean':
      return parseBool(value);
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
  // A dotted flag is client input — reject `--a.__proto__.x` before any write
  // walks the chain, the same `isUnsafeKey` guard every other ingestion
  // boundary applies (the one boundary that previously lacked it).
  if (path.some(isUnsafeKey)) return;
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
export function parseCliArgs(argv: string[], schema: z.ZodType | undefined): ParsedCliArgs {
  const options: CliRunOptions = {
    json: false,
    wait: false,
    quiet: false,
    dryRun: false,
    help: false,
  };

  // ── Pass 1: lift the reserved CLI options out of argv ──
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === undefined) continue;
    if (tok === '-h') {
      options.help = true;
      continue;
    }
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      const name = eq >= 0 ? tok.slice(2, eq) : tok.slice(2);
      const inline = eq >= 0 ? tok.slice(eq + 1) : undefined;
      if (BOOL_OPTIONS.has(name)) {
        const on = inline === undefined ? true : parseBool(inline);
        if (name === 'dry-run') options.dryRun = on;
        else if (name === 'json') options.json = on;
        else if (name === 'wait') options.wait = on;
        else if (name === 'quiet') options.quiet = on;
        else if (name === 'help') options.help = on;
        continue;
      }
      if (VALUE_OPTIONS.has(name)) {
        const value = inline ?? argv[++i];
        if (value !== undefined) {
          if (name === 'wait-timeout') {
            const n = Number(value);
            if (!Number.isNaN(n)) options.waitTimeout = n;
          } else if (name === 'output-dir') {
            options.outputDir = value;
          }
        }
        continue;
      }
    }
    rest.push(tok);
  }

  // ── Pass 2: split the remainder into flags + positionals ──
  const fields = describeSchemaFields(schema);
  const flags = new Map<string, string[]>();
  const boolFlags = new Map<string, boolean>();
  const positionals: string[] = [];

  const pushFlag = (name: string, value: string): void => {
    const existing = flags.get(name);
    if (existing) existing.push(value);
    else flags.set(name, [value]);
  };

  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === undefined) continue;
    if (!tok.startsWith('--')) {
      positionals.push(tok);
      continue;
    }
    const eq = tok.indexOf('=');
    const name = eq >= 0 ? tok.slice(2, eq) : tok.slice(2);
    let value: string | undefined = eq >= 0 ? tok.slice(eq + 1) : undefined;

    if (
      value === undefined &&
      name.startsWith('no-') &&
      fields.get(name.slice(3))?.kind === 'boolean'
    ) {
      boolFlags.set(name.slice(3), false);
      continue;
    }

    const info = fields.get(name);
    if (value === undefined) {
      if (info?.kind === 'boolean') {
        boolFlags.set(name, true);
        continue;
      }
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        value = next;
        i++;
      } else {
        // A valueless non-boolean flag — record presence; Zod reports the
        // missing value if the field needed one.
        boolFlags.set(name, true);
        continue;
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

  for (const [key, value] of boolFlags) {
    if (isUnsafeKey(key)) continue; // `--__proto__` is a client-controlled key
    toolArgs[key] = value;
  }

  for (const [key, values] of flags) {
    if (key.includes('.')) {
      setNested(toolArgs, key.split('.'), looseCoerce(values[values.length - 1] ?? ''));
      continue;
    }
    if (isUnsafeKey(key)) continue; // guard the top-level flag write too, not just dotted
    toolArgs[key] = coerceField(fields.get(key), values);
  }

  return { toolArgs, options };
}
