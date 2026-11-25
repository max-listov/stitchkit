import { serializeCanonicalJson } from '../../internal/canonical-json';
import { isRecord } from '../../internal/typed';
import { mergePropertySchemas, type VariantProperty } from '../schema/flatten-join';

export const OBJECT_SCHEMA_KEYWORDS = [
  'properties',
  'required',
  'additionalProperties',
  'patternProperties',
  'propertyNames',
  'minProperties',
  'maxProperties',
] as const;

const NON_OBJECT_SCHEMA_KEYWORDS = new Set(
  [
    'enum const multipleOf maximum exclusiveMaximum minimum exclusiveMinimum',
    'maxLength minLength pattern format contentEncoding contentMediaType contentSchema',
    'items prefixItems additionalItems minItems maxItems uniqueItems contains minContains maxContains',
  ]
    .join(' ')
    .split(' '),
);

const ROOT_DOCUMENT_KEYWORDS = new Set(['$schema', '$defs', 'definitions', 'oneOf', 'anyOf']);

const ROOT_REF_DOCUMENT_KEYS = new Set(
  [
    '$ref $schema $defs definitions $id $comment $vocabulary $anchor $dynamicAnchor',
    'title description default deprecated readOnly writeOnly examples example externalDocs xml',
  ]
    .join(' ')
    .split(' '),
);

export function hasObjectKeywords(node: Record<string, unknown>): boolean {
  return OBJECT_SCHEMA_KEYWORDS.some((key) => node[key] !== undefined);
}

export function hasNonObjectKeywords(node: Record<string, unknown>): boolean {
  return Object.keys(node).some(
    (key) => NON_OBJECT_SCHEMA_KEYWORDS.has(key) && node[key] !== undefined,
  );
}

function isNonObjectNode(node: Record<string, unknown>): boolean {
  return (node.type !== undefined && node.type !== 'object') || hasNonObjectKeywords(node);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function nonObjectError(keyword: string): Error {
  return new Error(
    `Top-level ${keyword} contains a non-object branch and cannot be mounted as a tool object schema`,
  );
}

function lookupLocalPointer(
  root: Record<string, unknown>,
  ref: string,
): Record<string, unknown> | undefined {
  if (!ref.startsWith('#/')) return undefined;
  let current: unknown = root;
  for (const segment of ref.slice(2).split('/')) {
    const key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return isRecord(current) ? current : undefined;
}

function derefLocal(
  root: Record<string, unknown>,
  ref: string,
  seen: ReadonlySet<string>,
  context: string,
): { target: Record<string, unknown>; nextSeen: Set<string> } {
  if (seen.has(ref)) throw new Error(`${context} contains a circular $ref "${ref}"`);
  const target = lookupLocalPointer(root, ref);
  if (!target) throw new Error(`${context} contains an unresolvable $ref "${ref}"`);
  const nextSeen = new Set(seen);
  nextSeen.add(ref);
  return { target, nextSeen };
}

export function resolveLocalRef(
  root: Record<string, unknown>,
  node: unknown,
  seen = new Set<string>(),
): Record<string, unknown> | undefined {
  if (!isRecord(node)) return undefined;
  const ref = node.$ref;
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return node;
  if (seen.has(ref)) return undefined;
  const nextSeen = new Set(seen);
  nextSeen.add(ref);
  const target = lookupLocalPointer(root, ref);
  return target ? resolveLocalRef(root, target, nextSeen) : undefined;
}

function withoutKeys(
  node: Record<string, unknown>,
  omitted: ReadonlySet<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (!omitted.has(key)) out[key] = value;
  }
  return out;
}

/**
 * Dereference a local root `$ref` before Phase 1 joins when its target uses
 * `allOf`/`oneOf`/`anyOf` or when Draft 2020-12 siblings sit beside `$ref`.
 * Plain recursive root `$ref` targets (`type: 'object'` without composition or
 * siblings) are returned untouched so `z.fromJSONSchema` handles recursion natively.
 */
export function prepareRootRef(schema: Record<string, unknown>): {
  schema: Record<string, unknown>;
  seen: ReadonlySet<string>;
} {
  if (typeof schema.$ref !== 'string' || !schema.$ref.startsWith('#/')) {
    return { schema, seen: new Set() };
  }
  const rootSiblings = withoutKeys(schema, ROOT_REF_DOCUMENT_KEYS);
  const collectedSiblings: Record<string, unknown>[] = [];
  if (Object.keys(rootSiblings).length > 0) collectedSiblings.push(rootSiblings);

  let seen: ReadonlySet<string> = new Set();
  let current: Record<string, unknown> = schema;
  while (typeof current.$ref === 'string' && current.$ref.startsWith('#/')) {
    const resolved = derefLocal(schema, current.$ref, seen, 'Root schema');
    seen = resolved.nextSeen;
    if (current !== schema) {
      const stepSiblings = withoutKeys(current, new Set(['$ref']));
      if (Object.keys(stepSiblings).length > 0) collectedSiblings.push(stepSiblings);
    }
    current = resolved.target;
  }

  const targetHasComposition =
    Array.isArray(current.allOf) ||
    Array.isArray(current.oneOf) ||
    Array.isArray(current.anyOf);
  if (!targetHasComposition && collectedSiblings.length === 0) {
    return { schema, seen: new Set() };
  }

  const rootEnvelope: Record<string, unknown> = {};
  for (const key of ROOT_REF_DOCUMENT_KEYS) {
    if (key !== '$ref' && schema[key] !== undefined) rootEnvelope[key] = schema[key];
  }
  if (collectedSiblings.length > 0) {
    return { schema: { ...rootEnvelope, allOf: [current, ...collectedSiblings] }, seen };
  }
  return { schema: { ...current, ...rootEnvelope }, seen };
}

function needsPropagatedType(member: Record<string, unknown>): boolean {
  return (
    member.type === undefined &&
    member.$ref === undefined &&
    member.enum === undefined &&
    member.const === undefined &&
    !Array.isArray(member.anyOf) &&
    !Array.isArray(member.oneOf) &&
    !Array.isArray(member.allOf)
  );
}

function recordSubschemaEntries(
  source: unknown,
  target: Map<string, Record<string, unknown>[]>,
): void {
  if (!isRecord(source)) return;
  for (const [key, sub] of Object.entries(source)) {
    const list = target.get(key) ?? [];
    list.push(isRecord(sub) ? sub : {});
    target.set(key, list);
  }
}

/**
 * Combine multiple subschemas that must all hold on one property (e.g. duplicate keys
 * across `allOf` branches). Propagates a sibling's `type` onto typeless branches so
 * `z.fromJSONSchema` does not erase them to `z.any()`.
 */
function combineConjoinedSchemas(
  schemas: readonly Record<string, unknown>[],
): Record<string, unknown> {
  const flat = schemas.flatMap((schema) =>
    Array.isArray(schema.allOf) && Object.keys(schema).length === 1
      ? schema.allOf.filter(isRecord)
      : [schema],
  );
  const unique: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const member of flat) {
    const key = serializeCanonicalJson(member);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(member);
  }
  if (unique.length === 1 && unique[0]) return unique[0];
  const explicitType = unique.find((m) => typeof m.type === 'string')?.type;
  const sharedType =
    typeof explicitType === 'string'
      ? explicitType
      : unique.some(hasObjectKeywords)
        ? 'object'
        : undefined;
  const typed =
    sharedType === undefined
      ? unique
      : unique.map((member) =>
          needsPropagatedType(member) ? { type: sharedType, ...member } : member,
        );
  return { allOf: typed };
}

function collectAllOfMembers(
  node: unknown,
  root: Record<string, unknown>,
  seen: ReadonlySet<string>,
  out: Record<string, unknown>[],
): void {
  if (!isRecord(node)) throw nonObjectError('allOf');
  if (typeof node.$ref === 'string') {
    const { target, nextSeen } = derefLocal(root, node.$ref, seen, 'Top-level allOf');
    collectAllOfMembers(target, root, nextSeen, out);
    const siblings = withoutKeys(node, new Set(['$ref']));
    if (Object.keys(siblings).length > 0) collectAllOfMembers(siblings, root, nextSeen, out);
    return;
  }
  if (isNonObjectNode(node)) throw nonObjectError('allOf');
  if (Array.isArray(node.oneOf) || Array.isArray(node.anyOf)) {
    collectAllOfMembers(joinTopLevelUnion(node, root, seen), root, seen, out);
    return;
  }
  if (Array.isArray(node.allOf)) {
    if (node.allOf.length === 0) {
      throw new Error('Top-level allOf must declare at least one object branch');
    }
    const own = withoutKeys(node, new Set(['allOf', ...ROOT_DOCUMENT_KEYWORDS]));
    if (Object.keys(own).length > 0) out.push(own);
    for (const branch of node.allOf) collectAllOfMembers(branch, root, seen, out);
    return;
  }
  out.push(node);
}

function mergePropertyNameSchemas(values: readonly unknown[]): unknown {
  if (values.includes(false)) return false;
  const schemas = values
    .filter(isRecord)
    .map((entry) => (needsPropagatedType(entry) ? { type: 'string', ...entry } : entry));
  return schemas.length > 0 ? combineConjoinedSchemas(schemas) : undefined;
}

function mergeSubschemaMap(
  entries: ReadonlyMap<string, Record<string, unknown>[]>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const [key, list] of entries) merged[key] = combineConjoinedSchemas(list);
  return merged;
}

/**
 * Flatten a top-level `allOf` into a single `type: 'object'` schema before `z.fromJSONSchema`.
 * Resolves local `$ref`, combines duplicate property/pattern schemas via `allOf`, unions
 * `required`, preserves sibling root keywords, and throws on non-object or cyclic branches.
 */
export function joinTopLevelAllOf(
  schema: Record<string, unknown>,
  root: Record<string, unknown> = schema,
  seen: ReadonlySet<string> = new Set(),
): Record<string, unknown> {
  if (!Array.isArray(schema.allOf)) return schema;
  if (schema.allOf.length === 0) {
    throw new Error('Top-level allOf must declare at least one object branch');
  }
  if (isNonObjectNode(schema)) throw nonObjectError('allOf');
  const members: Record<string, unknown>[] = [];
  const rootOwn = withoutKeys(schema, new Set(['allOf', ...ROOT_DOCUMENT_KEYWORDS]));
  if (Object.keys(rootOwn).length > 0) members.push(rootOwn);
  for (const branch of schema.allOf) collectAllOfMembers(branch, root, seen, members);
  if (
    schema.type !== 'object' &&
    !members.some((member) => member.type === 'object' || hasObjectKeywords(member))
  ) {
    throw nonObjectError('allOf');
  }

  const propMap = new Map<string, Record<string, unknown>[]>();
  const patternMap = new Map<string, Record<string, unknown>[]>();
  const required = new Set<string>();
  const propertyNameValues: unknown[] = [];
  const additionalSchemas: Record<string, unknown>[] = [];
  let minProperties: number | undefined;
  let maxProperties: number | undefined;
  let additionalFalse = false;

  for (const member of members) {
    recordSubschemaEntries(member.properties, propMap);
    recordSubschemaEntries(member.patternProperties, patternMap);
    for (const name of stringList(member.required)) required.add(name);
    if (typeof member.minProperties === 'number') {
      minProperties = Math.max(minProperties ?? member.minProperties, member.minProperties);
    }
    if (typeof member.maxProperties === 'number') {
      maxProperties = Math.min(maxProperties ?? member.maxProperties, member.maxProperties);
    }
    if (member.propertyNames !== undefined) propertyNameValues.push(member.propertyNames);
    if (member.additionalProperties === false) additionalFalse = true;
    else if (isRecord(member.additionalProperties)) {
      additionalSchemas.push(member.additionalProperties);
    }
  }

  const out = withoutKeys(schema, new Set(['allOf', 'type', ...OBJECT_SCHEMA_KEYWORDS]));
  out.type = 'object';
  if (propMap.size > 0) out.properties = mergeSubschemaMap(propMap);
  if (required.size > 0) out.required = [...required];
  if (minProperties !== undefined) out.minProperties = minProperties;
  if (maxProperties !== undefined) out.maxProperties = maxProperties;
  const mergedPropertyNames = mergePropertyNameSchemas(propertyNameValues);
  if (mergedPropertyNames !== undefined) out.propertyNames = mergedPropertyNames;
  if (patternMap.size > 0) out.patternProperties = mergeSubschemaMap(patternMap);
  if (additionalFalse) out.additionalProperties = false;
  else if (additionalSchemas.length > 0) {
    out.additionalProperties = combineConjoinedSchemas(additionalSchemas);
  }
  return out;
}

function isObjectBranch(branch: Record<string, unknown>, rootIsObject: boolean): boolean {
  if (branch.type === 'object') return true;
  if (isNonObjectNode(branch)) return false;
  if (isRecord(branch.properties) || isRecord(branch.patternProperties)) return true;
  return rootIsObject && hasObjectKeywords(branch);
}

function flattenAllOfThenUnion(
  node: Record<string, unknown>,
  root: Record<string, unknown>,
  seen: ReadonlySet<string>,
): Record<string, unknown> {
  const joined = joinTopLevelAllOf(node, root, seen);
  return Array.isArray(joined.oneOf) || Array.isArray(joined.anyOf)
    ? joinTopLevelUnion(joined, root, seen)
    : joined;
}

function resolveUnionBranch(
  entry: unknown,
  root: Record<string, unknown>,
  keyword: 'oneOf' | 'anyOf',
  seen: ReadonlySet<string>,
): Record<string, unknown> {
  if (!isRecord(entry)) throw nonObjectError(keyword);
  if (typeof entry.$ref === 'string') {
    const { target, nextSeen } = derefLocal(root, entry.$ref, seen, `Top-level ${keyword}`);
    const siblings = withoutKeys(entry, new Set(['$ref']));
    if (Object.keys(siblings).length > 0) {
      return flattenAllOfThenUnion({ allOf: [target, siblings] }, root, nextSeen);
    }
    return resolveUnionBranch(target, root, keyword, nextSeen);
  }
  if (Array.isArray(entry.allOf)) return flattenAllOfThenUnion(entry, root, seen);
  if (Array.isArray(entry.oneOf) || Array.isArray(entry.anyOf)) {
    return joinTopLevelUnion(entry, root, seen);
  }
  return entry;
}

/**
 * Join a top-level `oneOf` or `anyOf` of object branches into one object schema while
 * preserving Draft 2020-12 `$ref` siblings and all sibling root keywords (`minProperties`,
 * `maxProperties`, `propertyNames`, `patternProperties`, schema-valued `additionalProperties`,
 * `$schema`, `$defs`/`definitions`).
 */
export function joinTopLevelUnion(
  schema: Record<string, unknown>,
  root: Record<string, unknown> = schema,
  seen: ReadonlySet<string> = new Set(),
): Record<string, unknown> {
  if (Array.isArray(schema.oneOf) && Array.isArray(schema.anyOf)) {
    throw new Error(
      'Top-level oneOf and anyOf together cannot be mounted as one tool object schema',
    );
  }
  const keyword = Array.isArray(schema.oneOf)
    ? 'oneOf'
    : Array.isArray(schema.anyOf)
      ? 'anyOf'
      : undefined;
  if (keyword === undefined) return schema;
  const rawBranches = schema[keyword];
  if (!Array.isArray(rawBranches) || rawBranches.length === 0) {
    throw new Error(`Top-level ${keyword} must declare at least one object branch`);
  }
  if (isNonObjectNode(schema)) throw nonObjectError(keyword);
  const rootIsObject = schema.type === 'object' || hasObjectKeywords(schema);
  const branches = rawBranches.map((entry) => {
    const flattened = resolveUnionBranch(entry, root, keyword, seen);
    if (!isObjectBranch(flattened, rootIsObject)) throw nonObjectError(keyword);
    return flattened;
  });

  const byProp = new Map<string, VariantProperty[]>();
  const addProps = (source: unknown, label: string, req: ReadonlySet<string>): void => {
    if (!isRecord(source)) return;
    for (const [name, propSchema] of Object.entries(source)) {
      const list = byProp.get(name) ?? [];
      list.push({
        schema: isRecord(propSchema) ? propSchema : {},
        labels: [label],
        required: req.has(name),
      });
      byProp.set(name, list);
    }
  };
  const rootRequired = new Set(stringList(schema.required));
  addProps(schema.properties, 'base', rootRequired);
  let allStrict = true;
  const requiredSets: Set<string>[] = [];
  for (let idx = 0; idx < branches.length; idx++) {
    const branch = branches[idx];
    if (!branch) continue;
    if (branch.additionalProperties !== false) allStrict = false;
    const req = new Set(stringList(branch.required));
    requiredSets.push(req);
    addProps(branch.properties, `branch_${idx}`, req);
  }
  const properties: Record<string, unknown> = {};
  for (const [name, variants] of byProp) {
    properties[name] =
      variants.length === 1 && variants[0]
        ? variants[0].schema
        : mergePropertySchemas(variants, 'variant');
  }
  const firstRequired = requiredSets[0] ?? new Set<string>();
  const branchRequired = [...firstRequired].filter((name) =>
    requiredSets.every((set) => set.has(name)),
  );
  const required = [...new Set([...rootRequired, ...branchRequired])];
  const strict = schema.additionalProperties === false || allStrict;

  const out = withoutKeys(
    schema,
    new Set([keyword, 'type', 'properties', 'required', 'additionalProperties']),
  );
  out.type = 'object';
  out.properties = properties;
  if (required.length > 0) out.required = required;
  if (strict) out.additionalProperties = false;
  else if (isRecord(schema.additionalProperties)) {
    out.additionalProperties = schema.additionalProperties;
  }
  return out;
}
