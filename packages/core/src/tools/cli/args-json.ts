import { safeJsonParse } from '../../internal/safe-json';
import { appendCliOptionValue, coerceField, type FieldInfo } from './args-fields';
import type { CliLongOptionToken } from './args-route';
import { CliArgumentError } from './argument-error';

/** An inline := assigns a whole JSON value; an exact declared colon name stays literal. */
export function cliFieldOption(
  option: CliLongOptionToken,
  fields: ReadonlyMap<string, FieldInfo>,
): { name: string; json: boolean } {
  const json = option.inline && option.name.endsWith(':') && !fields.has(option.name);
  const name = json ? option.name.slice(0, -1) : option.name;
  return { name, json };
}

/** Whole JSON assignments cannot accumulate or mix with repeated element flags. */
export function appendCliFieldValue(
  raw: Map<string, string[]>,
  jsonFields: Set<string>,
  name: string,
  value: string,
  info: FieldInfo | undefined,
  json: boolean,
): void {
  appendCliOptionValue(
    raw,
    name,
    value,
    json || jsonFields.has(name) ? { kind: 'other' } : info,
  );
  if (json) jsonFields.add(name);
}

/** JSON assigns a value without scalar coercion; the command schema still validates it. */
export function coerceCliFieldValue(
  info: FieldInfo | undefined,
  values: string[],
  label: string,
  json: boolean,
): unknown {
  if (!json) return coerceField(info, values, label);
  try {
    return safeJsonParse(values[0] ?? '');
  } catch (cause) {
    throw new CliArgumentError(`${label} expects valid JSON`, { cause });
  }
}
