import { isRecord } from '../internal/typed';

export function isObjectSchemaType(typeValue: unknown): boolean {
  return typeValue === 'object' || (Array.isArray(typeValue) && typeValue.includes('object'));
}

export function unwrapSingletonAllOf(node: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(node.allOf) && node.allOf.length === 1 && isRecord(node.allOf[0])) {
    const { allOf: _dropped, ...rest } = node;
    return { ...node.allOf[0], ...rest };
  }
  return node;
}

function decodePointerSegment(segment: string): string {
  return segment.replace(/~1/gu, '/').replace(/~0/gu, '~');
}

export function encodePointerSegment(segment: string): string {
  return segment.replace(/~/gu, '~0').replace(/\//gu, '~1');
}

export function resolveJsonPointer(
  root: Record<string, unknown>,
  ref: string,
): Record<string, unknown> | undefined {
  if (ref === '#') return root;
  if (!ref.startsWith('#/')) return undefined;
  const segments = ref.slice(2).split('/').map(decodePointerSegment);
  let cursor: unknown = root;
  for (const segment of segments) {
    if (!isRecord(cursor) || !Object.hasOwn(cursor, segment)) return undefined;
    cursor = cursor[segment];
  }
  return isRecord(cursor) ? cursor : undefined;
}

export function resolveSchemaNode(
  node: Record<string, unknown>,
  root: Record<string, unknown>,
  seen: Set<string> = new Set(),
): Record<string, unknown> {
  const unwrapped = unwrapSingletonAllOf(node);
  if (typeof unwrapped.$ref === 'string' && !seen.has(unwrapped.$ref)) {
    const resolved = resolveJsonPointer(root, unwrapped.$ref);
    if (resolved) {
      seen.add(unwrapped.$ref);
      return resolveSchemaNode(resolved, root, seen);
    }
  }
  return unwrapped;
}

function schemaAllowsNull(
  node: Record<string, unknown>,
  root: Record<string, unknown>,
  visitedRefs: ReadonlySet<string>,
): boolean {
  const unwrapped = unwrapSingletonAllOf(node);
  if (typeof unwrapped.$ref === 'string') {
    if (visitedRefs.has(unwrapped.$ref)) return false;
    const resolved = resolveJsonPointer(root, unwrapped.$ref);
    if (!resolved) return false;
    const nextVisited = new Set(visitedRefs);
    nextVisited.add(unwrapped.$ref);
    return schemaAllowsNull(resolved, root, nextVisited);
  }
  if (unwrapped.type === 'null') return true;
  if (Array.isArray(unwrapped.type)) return unwrapped.type.includes('null');
  if (unwrapped.const === null) return true;
  if (Array.isArray(unwrapped.enum)) return unwrapped.enum.includes(null);
  if (Array.isArray(unwrapped.anyOf)) {
    return unwrapped.anyOf.some(
      (branch) => isRecord(branch) && schemaAllowsNull(branch, root, visitedRefs),
    );
  }
  if (Array.isArray(unwrapped.oneOf)) {
    return unwrapped.oneOf.some(
      (branch) => isRecord(branch) && schemaAllowsNull(branch, root, visitedRefs),
    );
  }
  if (Array.isArray(unwrapped.allOf)) {
    return (
      unwrapped.allOf.length > 0 &&
      unwrapped.allOf.every(
        (branch) => isRecord(branch) && schemaAllowsNull(branch, root, visitedRefs),
      )
    );
  }
  if (
    typeof unwrapped.type === 'string' ||
    unwrapped.const !== undefined ||
    isRecord(unwrapped.properties) ||
    unwrapped.items !== undefined ||
    Array.isArray(unwrapped.prefixItems)
  ) {
    return false;
  }
  return true;
}

function valueMatchesPrimitiveType(value: unknown, typeField: unknown): boolean {
  if (value === null || typeField === undefined) return true;
  const types = Array.isArray(typeField) ? typeField : [typeField];
  if (typeof value === 'string') return types.includes('string');
  if (typeof value === 'number') return types.includes('number') || types.includes('integer');
  if (typeof value === 'boolean') return types.includes('boolean');
  if (Array.isArray(value)) return types.includes('array');
  return isRecord(value) ? types.includes('object') : true;
}

function objectMatchesDiscriminators(
  value: Record<string, unknown>,
  branch: Record<string, unknown>,
  root: Record<string, unknown>,
): boolean {
  const resolved = resolveSchemaNode(branch, root);
  if (resolved.type !== undefined && !isObjectSchemaType(resolved.type)) return false;
  if (!isRecord(resolved.properties)) return true;
  if (resolved.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(resolved.properties, key)) return false;
    }
  }
  const req = new Set(
    Array.isArray(resolved.required)
      ? resolved.required.filter((k): k is string => typeof k === 'string')
      : [],
  );
  for (const [key, rawProp] of Object.entries(resolved.properties)) {
    if (!isRecord(rawProp) || !Object.hasOwn(value, key)) continue;
    if (value[key] === null) {
      if (req.has(key) && !schemaAllowsNull(rawProp, root, new Set())) return false;
      continue;
    }
    const prop = resolveSchemaNode(rawProp, root);
    if (prop.const !== undefined && value[key] !== prop.const) return false;
    if (Array.isArray(prop.enum) && !prop.enum.includes(value[key])) return false;
    if (!valueMatchesPrimitiveType(value[key], prop.type)) return false;
  }
  return true;
}

function selectBestObjectBranches(
  branches: readonly Record<string, unknown>[],
  value: Record<string, unknown>,
  root: Record<string, unknown>,
): Record<string, unknown>[] {
  if (branches.length <= 1) return [...branches];
  const keys = Object.keys(value);
  const scored = branches.map((branch) => {
    const resolved = resolveSchemaNode(branch, root);
    const props = isRecord(resolved.properties) ? resolved.properties : undefined;
    const req = Array.isArray(resolved.required)
      ? resolved.required.filter((k): k is string => typeof k === 'string')
      : [];
    const missingReq = req.filter((k) => !Object.hasOwn(value, k)).length;
    const matched = props ? keys.filter((k) => Object.hasOwn(props, k)).length : 0;
    const unrecognized = props ? keys.length - matched : 0;
    return { branch, missingReq, unrecognized, matched };
  });
  const cmp = (a: (typeof scored)[number], b: (typeof scored)[number]) =>
    a.missingReq - b.missingReq || a.unrecognized - b.unrecognized || b.matched - a.matched;
  scored.sort(cmp);
  const best = scored[0];
  return best ? scored.filter((s) => cmp(s, best) === 0).map((s) => s.branch) : [];
}

function collectArraySchemas(
  schema: Record<string, unknown>,
  root: Record<string, unknown>,
  seen: Set<string> = new Set(),
): Record<string, unknown>[] {
  const resolved = resolveSchemaNode(schema, root, seen);
  const collected: Record<string, unknown>[] = [];
  if (isRecord(resolved.items) || Array.isArray(resolved.prefixItems))
    collected.push(resolved);
  for (const key of ['allOf', 'anyOf', 'oneOf'] as const) {
    const branches = resolved[key];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      if (isRecord(branch))
        collected.push(...collectArraySchemas(branch, root, new Set(seen)));
    }
  }
  return collected;
}

function collectObjectSchemas(
  schema: Record<string, unknown>,
  value: Record<string, unknown>,
  root: Record<string, unknown>,
): Record<string, unknown>[] {
  const resolved = resolveSchemaNode(schema, root);
  const collected: Record<string, unknown>[] = [];
  if (isRecord(resolved.properties) || isRecord(resolved.additionalProperties)) {
    collected.push(resolved);
  }
  if (Array.isArray(resolved.allOf)) {
    for (const branch of resolved.allOf) {
      if (isRecord(branch)) collected.push(...collectObjectSchemas(branch, value, root));
    }
  }
  const unionBranches = Array.isArray(resolved.anyOf)
    ? resolved.anyOf
    : Array.isArray(resolved.oneOf)
      ? resolved.oneOf
      : undefined;
  if (unionBranches) {
    const matching = selectBestObjectBranches(
      unionBranches.filter(
        (branch): branch is Record<string, unknown> =>
          isRecord(branch) && objectMatchesDiscriminators(value, branch, root),
      ),
      value,
      root,
    );
    for (const branch of matching) {
      collected.push(...collectObjectSchemas(branch, value, root));
    }
  }
  return collected;
}

/** Recursively strip strict-synthesized `null` properties using the pre-strict JSON Schema. */
export function stripWithSchema(
  value: unknown,
  schema: Record<string, unknown>,
  root: Record<string, unknown>,
): unknown {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  const resolved = resolveSchemaNode(schema, root);

  if (Array.isArray(value)) {
    const arraySchemas = collectArraySchemas(resolved, root);
    if (arraySchemas.length === 0) return value;
    return value.map((entry, index) => {
      const targets: Record<string, unknown>[] = [];
      for (const arr of arraySchemas) {
        const prefixItems = Array.isArray(arr.prefixItems) ? arr.prefixItems : undefined;
        const target =
          prefixItems && index < prefixItems.length && isRecord(prefixItems[index])
            ? prefixItems[index]
            : isRecord(arr.items)
              ? arr.items
              : undefined;
        if (target) targets.push(target);
      }
      if (targets.length === 0) return entry;
      const chosen = targets.length === 1 ? targets[0] : { anyOf: targets };
      return chosen ? stripWithSchema(entry, chosen, root) : entry;
    });
  }

  if (!isRecord(value)) return value;
  const objectSchemas = collectObjectSchemas(resolved, value, root);
  if (objectSchemas.length === 0) return value;

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    let sawDeclaredProp = false;
    let isRequired = false;
    let allowsNull = false;
    let propSchema: Record<string, unknown> | undefined;
    let additionalSchema: Record<string, unknown> | undefined;

    for (const objSchema of objectSchemas) {
      const req = Array.isArray(objSchema.required) ? objSchema.required : [];
      if (isRecord(objSchema.properties) && Object.hasOwn(objSchema.properties, key)) {
        const rawProp = objSchema.properties[key];
        if (isRecord(rawProp)) {
          sawDeclaredProp = true;
          propSchema ??= rawProp;
          if (req.includes(key)) isRequired = true;
          if (schemaAllowsNull(rawProp, root, new Set())) allowsNull = true;
        }
      } else if (isRecord(objSchema.additionalProperties)) {
        additionalSchema ??= objSchema.additionalProperties;
      }
    }

    if (entry === null) {
      if (sawDeclaredProp && !isRequired && !allowsNull) continue;
      out[key] = null;
      continue;
    }

    const childSchema = propSchema ?? additionalSchema;
    out[key] = childSchema ? stripWithSchema(entry, childSchema, root) : entry;
  }
  return out;
}
