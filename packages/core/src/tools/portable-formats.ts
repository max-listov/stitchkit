import { isRecord } from '../internal/typed';

/**
 * JSON Schema formats implemented by the standard `ajv-formats` package and
 * defined by JSON Schema itself. This deliberately excludes its OpenAPI-only,
 * deprecated and AJV-specific aliases: the MCP surface must travel across
 * clients, not only compile in one validator.
 */
export const PORTABLE_JSON_SCHEMA_FORMATS: ReadonlySet<string> = new Set([
  'date',
  'time',
  'date-time',
  'duration',
  'uri',
  'uri-reference',
  'uri-template',
  'email',
  'hostname',
  'ipv4',
  'ipv6',
  'regex',
  'uuid',
  'json-pointer',
  'relative-json-pointer',
]);

export interface NonPortableFormat {
  /** Path inside the JSON Schema; `(root)` when the root itself has a format. */
  path: string;
  format: string;
}

interface WalkTarget {
  value: unknown;
  path: string;
}

function propertyPath(prefix: string, property: string): string {
  return prefix ? `${prefix}.${property}` : property;
}

function keywordPath(prefix: string, keyword: string): string {
  if (prefix && keyword.startsWith('[')) return `${prefix}${keyword}`;
  return prefix ? `${prefix}.${keyword}` : keyword;
}

/** Find every format outside the portable baseline and an explicit allowlist. */
export function findNonPortableFormats(
  schema: unknown,
  allowFormats: readonly string[] = [],
): NonPortableFormat[] {
  const allowed = new Set([...PORTABLE_JSON_SCHEMA_FORMATS, ...allowFormats]);
  const found: NonPortableFormat[] = [];
  const pending: WalkTarget[] = [{ value: schema, path: '' }];

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || !isRecord(current.value)) continue;

    const format = current.value.format;
    if (typeof format === 'string' && !allowed.has(format)) {
      found.push({ path: current.path || '(root)', format });
    }

    const properties = current.value.properties;
    if (isRecord(properties)) {
      for (const [key, value] of Object.entries(properties)) {
        pending.push({ value, path: propertyPath(current.path, key) });
      }
    }

    for (const mapKey of ['$defs', 'definitions', 'patternProperties', 'dependentSchemas']) {
      const entries = current.value[mapKey];
      if (!isRecord(entries)) continue;
      for (const [key, value] of Object.entries(entries)) {
        pending.push({ value, path: keywordPath(current.path, `${mapKey}.${key}`) });
      }
    }

    const directChildren: Array<[string, string]> = [
      ['items', '[]'],
      ['contains', 'contains'],
      ['additionalProperties', '*'],
      ['unevaluatedProperties', '*'],
      ['propertyNames', 'propertyNames'],
      ['not', 'not'],
      ['if', 'if'],
      ['then', 'then'],
      ['else', 'else'],
    ];
    for (const [keyword, segment] of directChildren) {
      const child = current.value[keyword];
      if (isRecord(child)) {
        pending.push({ value: child, path: keywordPath(current.path, segment) });
      }
      if (Array.isArray(child)) {
        child.forEach((value, index) => {
          pending.push({ value, path: keywordPath(current.path, `${segment}[${index}]`) });
        });
      }
    }

    for (const keyword of ['prefixItems', 'allOf', 'anyOf', 'oneOf']) {
      const branches = current.value[keyword];
      if (!Array.isArray(branches)) continue;
      branches.forEach((value, index) => {
        pending.push({ value, path: keywordPath(current.path, `${keyword}[${index}]`) });
      });
    }
  }

  return found.sort(
    (left, right) =>
      left.path.localeCompare(right.path) || left.format.localeCompare(right.format),
  );
}
