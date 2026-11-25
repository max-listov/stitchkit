/**
 * What each flag of a command should become: the kind of every field its
 * schema declares, and the coercion from argv's strings to that kind. Every
 * argv token is a string; the schema says what it should be.
 */
import { z } from 'zod';
import { isUnsafeKey } from '../../internal/safe-json';
import { isRecord, transportResult } from '../../internal/typed';
import { coerceJsonArgs } from '../schema/coerce';
import { jsonSchemaObjectCoercionMembers } from '../schema/json-schema-origin';
import { unwrapZodWrappers } from '../schema/schema';
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
  /** True when the field accepts only booleans (not a union that also accepts non-booleans). */
  pureBoolean?: boolean;
}

/** Admit each raw occurrence before scalar coercion can discard a value. */
export function appendCliOptionValue(
  raw: Map<string, string[]>,
  name: string,
  value: string,
  info: FieldInfo | undefined,
): void {
  const existing = raw.get(name);
  // Explicitly untyped passthrough fields retain their raw-list grammar.
  // Dotted leaves and declared fields only repeat when the schema says array.
  const repeatable = info?.kind === 'array' || (!name.includes('.') && info === undefined);
  if (existing !== undefined) {
    if (!repeatable) {
      throw new CliArgumentError(`--${name} was passed ${existing.length + 1} times`);
    }
    existing.push(value);
  } else {
    raw.set(name, [value]);
  }
}

/**
 * The one primitive kind every literal branch accepts. Mixed primitive kinds stay raw: argv has
 * no type tag with which to distinguish the number `7` from the string `"7"`, and guessing from
 * its spelling would corrupt string literals such as `007`.
 */
function literalKind(field: z.core.$ZodType): FieldKind | undefined {
  const base = unwrapZodWrappers(field);
  if (base instanceof z.ZodLiteral) {
    const kinds = new Set<FieldKind>();
    for (const value of base.values) {
      const kind = typeof value;
      if (kind !== 'boolean' && kind !== 'number' && kind !== 'bigint' && kind !== 'string')
        return undefined;
      kinds.add(kind);
    }
    return kinds.size === 1 ? kinds.values().next().value : undefined;
  }
  if (base instanceof z.ZodUnion) {
    const kinds = base.def.options.map(literalKind);
    const first = kinds[0];
    return first !== undefined && kinds.every((kind) => kind === first) ? first : undefined;
  }
  return undefined;
}

function classify(field: z.core.$ZodType): FieldKind {
  if (field instanceof z.ZodBoolean) return 'boolean';
  if (field instanceof z.ZodNumber) return 'number';
  if (field instanceof z.ZodBigInt) return 'bigint';
  if (field instanceof z.ZodDate) return 'date';
  if (field instanceof z.ZodEnum) return 'enum';
  if (field instanceof z.ZodArray) return 'array';
  if (field instanceof z.ZodObject) return 'object';
  const primitiveLiteral = literalKind(field);
  if (primitiveLiteral !== undefined) return primitiveLiteral;
  if (field instanceof z.ZodString) return 'string';
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
  if (existing.kind === info.kind) {
    if (existing.kind === 'array' && existing.elementKind !== info.elementKind) {
      fields.set(name, { kind: 'array', elementKind: 'other' });
    } else if (existing.kind === 'boolean' && existing.pureBoolean !== info.pureBoolean) {
      fields.set(name, { kind: 'boolean' });
    }
    return;
  }
  if (existing.kind === 'boolean' || info.kind === 'boolean') {
    fields.set(name, { kind: 'boolean' });
    return;
  }
  fields.set(name, { kind: 'other' });
}

function collectSchemaFields(
  schema: z.core.$ZodType,
  fields: Map<string, FieldInfo>,
  inUnion = false,
): void {
  const base = unwrapZodWrappers(schema);
  if (base instanceof z.ZodObject) {
    for (const [name, raw] of Object.entries(base.shape)) {
      const fieldBase = unwrapZodWrappers(raw);
      const kind = classify(fieldBase);
      if (kind === 'array' && fieldBase instanceof z.ZodArray) {
        mergeField(fields, name, {
          kind,
          elementKind: classify(unwrapZodWrappers(fieldBase.element)),
        });
      } else {
        mergeField(fields, name, {
          kind,
          ...(fieldBase instanceof z.ZodNumber && fieldBase.isInt && { integer: true }),
          ...(kind === 'boolean' && !inUnion && { pureBoolean: true }),
        });
      }
    }
    return;
  }
  if (base instanceof z.ZodUnion) {
    for (const option of base.def.options) collectSchemaFields(option, fields, true);
    return;
  }
  if (base instanceof z.ZodIntersection) {
    collectSchemaFields(base.def.left, fields, inUnion);
    collectSchemaFields(base.def.right, fields, inUnion);
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

function infoOf(field: z.core.$ZodType): FieldInfo {
  const base = unwrapZodWrappers(field);
  const kind = classify(base);
  if (kind === 'array' && base instanceof z.ZodArray) {
    return { kind, elementKind: classify(unwrapZodWrappers(base.element)) };
  }
  return {
    kind,
    ...(base instanceof z.ZodNumber && base.isInt && { integer: true }),
    ...(kind === 'boolean' && { pureBoolean: true }),
  };
}

function mergePathInfos(
  infos: readonly (FieldInfo | undefined)[],
  composition: 'union' | 'intersection',
): FieldInfo | undefined {
  const present = infos.filter((info): info is FieldInfo => info !== undefined);
  if (present.length === 0) return undefined;
  // A union may accept the raw text through its free branch, so coercing for a
  // different branch would choose semantics the schema did not declare.
  if (composition === 'union' && present.some((info) => info.kind === 'other')) {
    return { kind: 'other' };
  }
  const concrete = present.filter((info) => info.kind !== 'other');
  const candidates =
    composition === 'intersection' && concrete.length > 0 ? concrete : present;
  const first = candidates[0];
  if (!first) return undefined;
  if (candidates.every((info) => info.kind === first.kind)) {
    const elementKind =
      first.kind === 'array'
        ? candidates.every((info) => info.elementKind === first.elementKind)
          ? first.elementKind
          : 'other'
        : undefined;
    const pureBoolean =
      first.kind === 'boolean' &&
      (composition === 'intersection'
        ? candidates.some((info) => info.pureBoolean)
        : infos.every((info) => info?.pureBoolean));
    return {
      kind: first.kind,
      ...(elementKind && { elementKind }),
      ...(first.integer && candidates.every((info) => info.integer) && { integer: true }),
      ...(pureBoolean && { pureBoolean: true }),
    };
  }
  return candidates.some((info) => info.kind === 'boolean')
    ? { kind: 'boolean' }
    : { kind: 'other' };
}

function pathInfo(schema: z.core.$ZodType, path: readonly string[]): FieldInfo | undefined {
  const guarded = jsonSchemaObjectCoercionMembers(schema);
  if (guarded) {
    return mergePathInfos(
      guarded.map((member) => pathInfo(member, path)),
      'intersection',
    );
  }
  const base = unwrapZodWrappers(schema);
  if (base !== schema) return pathInfo(base, path);
  if (base instanceof z.ZodUnion) {
    return mergePathInfos(
      base.def.options.map((member) => pathInfo(member, path)),
      'union',
    );
  }
  if (base instanceof z.ZodIntersection) {
    return mergePathInfos(
      [pathInfo(base.def.left, path), pathInfo(base.def.right, path)],
      'intersection',
    );
  }
  if (path.length === 0) return infoOf(base);
  const [name, ...rest] = path;
  if (name === undefined) return infoOf(base);
  if (base instanceof z.ZodObject) {
    const member = base.shape[name] ?? base.def.catchall;
    return member ? pathInfo(member, rest) : undefined;
  }
  if (base instanceof z.ZodRecord) return pathInfo(base.valueType, rest);
  return undefined;
}

/**
 * Resolve the declared leaf of a dotted option. An intersection's concrete
 * constraint can refine a free member; a union with a free member stays raw,
 * because coercion must not choose one accepted branch for the caller.
 */
export function describeSchemaPath(
  schema: z.ZodType | undefined,
  path: readonly string[],
): FieldInfo | undefined {
  if (!schema || path.length === 0) return undefined;
  return pathInfo(schema, path);
}

/**
 * Single boolean word table for CLI flags (case-insensitive):
 * - inline (`--flag=word`): `true`, `1`, `yes`, `on`, `false`, `0`, `no`, `off`
 * - separate token (`--flag word`): `true`, `false` only, so ordinary values like `1`, `yes`, `no` stay positionals.
 */
interface BoolWordRow {
  readonly value: boolean;
  readonly separate: boolean;
}

const BOOL_WORDS: Readonly<Record<string, BoolWordRow>> = {
  true: { value: true, separate: true },
  '1': { value: true, separate: false },
  yes: { value: true, separate: false },
  on: { value: true, separate: false },
  false: { value: false, separate: true },
  '0': { value: false, separate: false },
  no: { value: false, separate: false },
  off: { value: false, separate: false },
};

function lookupBoolWord(value: string): BoolWordRow | undefined {
  const key = value.toLowerCase();
  return Object.hasOwn(BOOL_WORDS, key) ? BOOL_WORDS[key] : undefined;
}

/**
 * The token after a bare boolean flag, when it is the flag's value: `true` or
 * `false` (case-insensitive). Other inline boolean words (`1`, `yes`, `no`,
 * `on`, `off`) stay positionals here so a flag does not swallow an ordinary value.
 */
export function separateBoolValue(next: string | undefined): boolean | undefined {
  if (next === undefined) return undefined;
  const row = lookupBoolWord(next);
  return row?.separate ? row.value : undefined;
}

/** True for a value the reserved-boolean grammar already claims. */
export function isReservedBoolWord(value: string): boolean {
  return lookupBoolWord(value) !== undefined;
}

/** Strict boolean for a reserved option or inline boolean flag — unknown words throw. */
export function parseReservedBool(name: string, value: string): boolean {
  const row = lookupBoolWord(value);
  if (row !== undefined) return row.value;
  throw new CliArgumentError(`--${name} expects a boolean (true/false), got "${value}"`);
}

/** Coerce one string to a scalar field kind — never throws; an un-coercible value is left raw for Zod to reject with a clear message. */
function coerceScalar(kind: FieldKind, value: string): unknown {
  switch (kind) {
    case 'boolean':
      return lookupBoolWord(value)?.value ?? value;
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

/** Best-effort coercion for a wholly unknown passthrough option (`true`/`false` and numbers only). */
export function looseCoerce(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  const number = Number(value);
  return value.trim() !== '' && !Number.isNaN(number) ? number : value;
}

/** The argument error for the first issue of an application option's validation. */
function refuseGlobalOption(issue: z.core.$ZodIssue | undefined): never {
  const field = issue?.path[0];
  const where = typeof field === 'string' ? `--${field}` : 'application option';
  throw new CliArgumentError(`${where}: ${issue?.message ?? 'invalid value'}`);
}

/**
 * Validate raw application global options against their schema once:
 * coerce JSON-stringified objects/arrays, apply declared defaults, and refuse
 * invalid values with `CliArgumentError`.
 */
export function parseCliGlobalValues<TGlobals extends z.ZodObject>(
  schema: TGlobals,
  raw: Record<string, unknown> | undefined,
): z.output<TGlobals>;
export function parseCliGlobalValues<TGlobals extends z.ZodObject = z.ZodObject>(
  schema: TGlobals | undefined,
  raw: Record<string, unknown> | undefined,
): z.output<TGlobals>;
export function parseCliGlobalValues<TGlobals extends z.ZodObject = z.ZodObject>(
  schema: TGlobals | undefined,
  raw: Record<string, unknown> | undefined,
): z.output<TGlobals> {
  const base = raw ?? {};
  if (schema === undefined) return transportResult<z.output<TGlobals>>(base);
  let coerced: Record<string, unknown>;
  try {
    coerced = coerceJsonArgs(base, schema);
  } catch (error) {
    if (error instanceof z.ZodError) refuseGlobalOption(error.issues[0]);
    throw error;
  }
  const parsed = schema.safeParse(coerced);
  if (!parsed.success) refuseGlobalOption(parsed.error.issues[0]);
  return parsed.data;
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
