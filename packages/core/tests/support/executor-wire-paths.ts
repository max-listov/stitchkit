/**
 * The shape a wire schema declares, as a set of readable paths: every property, every member of
 * a union by its discriminator, every enum value. Two releases' sets differ by exactly what the
 * newer one writes that the older one — strict on every object — refuses.
 */
import { isRecord } from '../../src/internal/typed';

function discriminatorOf(member: Record<string, unknown>): string | undefined {
  if (!isRecord(member.properties)) return undefined;
  for (const [key, property] of Object.entries(member.properties)) {
    if (isRecord(property) && typeof property.const === 'string') {
      return `${key}=${property.const}`;
    }
  }
  return undefined;
}

function collect(schema: unknown, at: string, paths: Set<string>): void {
  // A `$ref` is the open JSON value (`z.json()`): it has no declared shape to compare.
  if (!isRecord(schema) || typeof schema.$ref === 'string') return;
  if (Array.isArray(schema.enum)) {
    for (const value of schema.enum) paths.add(`${at}=${String(value)}`);
  }
  if (isRecord(schema.properties)) {
    for (const [key, property] of Object.entries(schema.properties)) {
      paths.add(`${at}.${key}`);
      collect(property, `${at}.${key}`, paths);
    }
  }
  if (schema.items !== undefined) collect(schema.items, `${at}[]`, paths);
  if (isRecord(schema.additionalProperties)) {
    collect(schema.additionalProperties, `${at}{}`, paths);
  }
  for (const keyword of ['anyOf', 'oneOf'] as const) {
    const members = schema[keyword];
    if (!Array.isArray(members)) continue;
    for (const member of members) {
      if (!isRecord(member)) continue;
      const variant = discriminatorOf(member);
      if (variant === undefined) {
        collect(member, at, paths);
        continue;
      }
      paths.add(`${at}[${variant}]`);
      collect(member, `${at}[${variant}]`, paths);
    }
  }
}

/** Every path `schema` declares under the message `name`. */
export function wirePaths(name: string, schema: unknown): Set<string> {
  const paths = new Set<string>();
  collect(schema, name, paths);
  return paths;
}

/**
 * What `current` declares that `previous` does not, outermost first: a new union member or
 * object is named once, not again for each of its own properties.
 */
export function addedWirePaths(previous: Set<string>, current: Set<string>): string[] {
  const added = [...current].filter((path) => !previous.has(path)).sort();
  return added.filter(
    (path) =>
      !added.some(
        (outer) =>
          outer !== path && path.startsWith(outer) && /^[.[{=]/.test(path.slice(outer.length)),
      ),
  );
}
