/**
 * What each flag of a command should become: the kind of every field its
 * schema declares, and the coercion from argv's strings to that kind. Every
 * argv token is a string; the schema says what it should be.
 */
import { z } from 'zod';
import { isUnsafeKey } from '../../internal/safe-json';
import { isRecord } from '../../internal/typed';
import { CliArgumentError } from './argument-error';

export type FieldKind =
  | 'boolean'
  | 'number'
  | 'bigint'
  | 'date'
  | 'string'
  | 'enum'
  | 'array'
  | 'object'
  | 'other';

export interface FieldInfo {
  kind: FieldKind;
  /** Element kind for an `array` field — drives per-element coercion. */
  elementKind?: FieldKind;
  /** A `number` field that only accepts integers — named in its coercion error. */
  integer?: boolean;
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
        mergeField(fields, name, {
          kind,
          elementKind: classify(unwrap(fieldBase.element)),
        });
      } else {
        mergeField(fields, name, {
          kind,
          ...(fieldBase instanceof z.ZodNumber && fieldBase.isInt && { integer: true }),
        });
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

export function parseReservedBool(name: string, value: string): boolean {
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
export function looseCoerce(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  const n = Number(value);
  return value.trim() !== '' && !Number.isNaN(n) ? n : value;
}

function looksLikeJson(value: string): boolean {
  const t = value.trim();
  return t.startsWith('[') || t.startsWith('{');
}

/** What a kind that has to be parsed out of a string is called in a refusal. */
function expectedValue(kind: FieldKind, integer: boolean | undefined): string | undefined {
  if (kind === 'number') return integer ? 'a whole number' : 'a number';
  if (kind === 'bigint') return 'a whole number';
  if (kind === 'date') return 'a date';
  return undefined;
}

/**
 * Coerce one scalar and refuse, naming the argument, when it cannot be read.
 *
 * Left raw, `--tail abc` reached the schema as the string it is and came back
 * as "expected number, received string" — true of every argv token, and silent
 * about which flag it was.
 */
function coerceNamed(
  label: string,
  kind: FieldKind,
  integer: boolean | undefined,
  value: string,
): unknown {
  const coerced = coerceScalar(kind, value);
  const expected = expectedValue(kind, integer);
  if (expected !== undefined && typeof coerced === 'string') {
    throw new CliArgumentError(`${label} expects ${expected}, got "${value}"`);
  }
  if (integer && typeof coerced === 'number' && !Number.isInteger(coerced)) {
    throw new CliArgumentError(`${label} expects ${expected}, got "${value}"`);
  }
  return coerced;
}

/** Coerce the collected raw string value(s) for one field to its typed form. */
export function coerceField(
  info: FieldInfo | undefined,
  values: string[],
  label: string,
): unknown {
  const last = values[values.length - 1] ?? '';
  if (!info) return values.length > 1 ? values : last;

  if (info.kind === 'array') {
    // A single JSON-array string is left for `coerceJson`; repeated flags
    // (`--tag a --tag b`) become a coerced element array.
    if (values.length === 1 && looksLikeJson(last)) return last;
    return values.map((v) => coerceNamed(label, info.elementKind ?? 'string', false, v));
  }
  // An object field arrives as a JSON string — `coerceJson` parses it.
  if (info.kind === 'object') return last;
  return coerceNamed(label, info.kind, info.integer, last);
}

export function setNested(
  target: Record<string, unknown>,
  path: string[],
  value: unknown,
): void {
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
