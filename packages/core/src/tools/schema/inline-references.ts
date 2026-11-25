/**
 * Write a JSON Schema document out without a single reference.
 *
 * Zod writes a recursive schema (`z.lazy`, `z.json()`) as a definition that
 * refers to itself. Some model providers refuse a tool whose input carries a
 * reference cycle, and refuse the whole request with it; others accept the
 * document but never read a definition reached through an `allOf: [{ $ref }]`
 * wrapper, so the model is shown nothing. A document with no `$ref` is read the
 * same way by every reader.
 *
 * Each recursive definition is written out `depth` times along any path; the
 * reference that would write it once more becomes an open node accepting every
 * JSON type the definition can take. The projection only widens (→ ADR 0050):
 * every value the definition accepts is accepted by the document, and the
 * handler still parses the contract's own recursive schema. → ADR 0319.
 */
import { assertInputRecursionDepth } from '../../contract/define-validation';
import { isRecord } from '../../internal/typed';
import {
  JSON_SCHEMA_KEYWORDS,
  SCHEMA_KEYWORDS,
  SCHEMA_LIST_KEYWORDS,
  SCHEMA_MAP_KEYWORDS,
} from '../../json-schema/keywords';
import type { ToolPresentationSchema } from './flatten';

const DEFINITION_KEYWORDS = new Set(['definitions', '$defs']);

/** Keywords that only describe a value; they merge into a written-out reference. */
const ANNOTATION_KEYWORDS: ReadonlySet<string> = new Set(
  Object.entries(JSON_SCHEMA_KEYWORDS)
    .filter(([, row]) => row.kind === 'metadata')
    .map(([name]) => name)
    .concat('$comment'),
);

function unescapePointerSegment(segment: string): string {
  return decodeURIComponent(segment).replaceAll('~1', '/').replaceAll('~0', '~');
}

function resolvePointer(root: ToolPresentationSchema, pointer: string): unknown {
  if (pointer === '#' || pointer === '#/') return root;
  let node: unknown = root;
  for (const segment of pointer.slice(2).split('/').map(unescapePointerSegment)) {
    if (Array.isArray(node)) node = node[Number(segment)];
    else if (isRecord(node)) node = node[segment];
    else return undefined;
  }
  return node;
}

function localReference(node: Record<string, unknown>): string | undefined {
  const reference = node.$ref;
  if (typeof reference !== 'string') return undefined;
  if (!reference.startsWith('#')) {
    throw new Error(`Cannot write out the non-local reference "${reference}"`);
  }
  return reference;
}

/** Call `visit` for each subschema of `node`, chosen by the keyword table, never by a value's shape. */
function eachSubschema(node: Record<string, unknown>, visit: (child: unknown) => void): void {
  for (const [key, child] of Object.entries(node)) {
    if (DEFINITION_KEYWORDS.has(key)) continue;
    if (SCHEMA_KEYWORDS.includes(key)) {
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    } else if (SCHEMA_LIST_KEYWORDS.includes(key) && Array.isArray(child)) {
      child.forEach(visit);
    } else if (
      (SCHEMA_MAP_KEYWORDS.includes(key) || key === 'dependencies') &&
      isRecord(child)
    ) {
      for (const value of Object.values(child)) if (isRecord(value)) visit(value);
    }
  }
}

/** Rebuild `node` with every subschema replaced by `rewrite`; definition maps are dropped. */
function mapSubschemas(
  node: Record<string, unknown>,
  rewrite: (child: unknown) => unknown,
): ToolPresentationSchema {
  const result: ToolPresentationSchema = {};
  for (const [key, child] of Object.entries(node)) {
    if (DEFINITION_KEYWORDS.has(key)) continue;
    if (SCHEMA_KEYWORDS.includes(key)) {
      result[key] = Array.isArray(child) ? child.map(rewrite) : rewrite(child);
    } else if (SCHEMA_LIST_KEYWORDS.includes(key) && Array.isArray(child)) {
      result[key] = child.map(rewrite);
    } else if (
      (SCHEMA_MAP_KEYWORDS.includes(key) || key === 'dependencies') &&
      isRecord(child)
    ) {
      const map: ToolPresentationSchema = {};
      for (const [name, value] of Object.entries(child)) {
        map[name] = isRecord(value) ? rewrite(value) : value;
      }
      result[key] = map;
    } else {
      result[key] = child;
    }
  }
  return result;
}

/** The references each pointer reaches without passing through another reference. */
function referenceGraph(root: ToolPresentationSchema): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  const pending = ['#'];
  while (pending.length > 0) {
    const pointer = pending.pop();
    if (pointer === undefined || graph.has(pointer)) continue;
    const edges = new Set<string>();
    graph.set(pointer, edges);
    const collect = (node: unknown): void => {
      if (!isRecord(node)) return;
      const reference = localReference(node);
      if (reference !== undefined) {
        edges.add(reference);
        pending.push(reference);
      }
      eachSubschema(node, collect);
    };
    const target = resolvePointer(root, pointer);
    if (!isRecord(target)) throw new Error(`Cannot resolve the reference "${pointer}"`);
    collect(target);
  }
  return graph;
}

/** Pointers that can reach themselves — the definitions a depth applies to. */
function recursivePointers(graph: Map<string, Set<string>>): Set<string> {
  const recursive = new Set<string>();
  for (const start of graph.keys()) {
    const seen = new Set<string>();
    const pending = [...(graph.get(start) ?? [])];
    while (pending.length > 0) {
      const next = pending.pop();
      if (next === undefined || seen.has(next)) continue;
      if (next === start) {
        recursive.add(start);
        break;
      }
      seen.add(next);
      pending.push(...(graph.get(next) ?? []));
    }
  }
  return recursive;
}

type JsonTypes = Set<string> | 'any';

const JSON_TYPES = ['string', 'number', 'integer', 'boolean', 'null', 'array', 'object'];

function typeOfValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  return typeof value === 'number' ? 'number' : typeof value;
}

function intersect(left: JsonTypes, right: JsonTypes): JsonTypes {
  if (left === 'any') return right;
  if (right === 'any') return left;
  const kept = new Set<string>();
  for (const type of left) {
    if (right.has(type) || (type === 'integer' && right.has('number'))) kept.add(type);
    else if (type === 'number' && right.has('integer')) kept.add('integer');
  }
  return kept;
}

function union(left: JsonTypes, right: JsonTypes): JsonTypes {
  if (left === 'any' || right === 'any') return 'any';
  return new Set([...left, ...right]);
}

/**
 * The JSON types a schema can accept, read from `type`, `const`, `enum` and its
 * combinators. A reference cycle met on the way adds nothing to a union — the
 * definition accepts only what its other branches do — and anything unreadable
 * answers `any`, the widest open node.
 */
function admittedTypes(
  root: ToolPresentationSchema,
  node: unknown,
  visiting: ReadonlySet<string>,
): JsonTypes {
  if (!isRecord(node)) return node === false ? new Set() : 'any';
  let types: JsonTypes = 'any';
  const reference = localReference(node);
  if (reference !== undefined) {
    types = visiting.has(reference)
      ? new Set()
      : admittedTypes(
          root,
          resolvePointer(root, reference),
          new Set([...visiting, reference]),
        );
  }
  if (typeof node.type === 'string') types = intersect(types, new Set([node.type]));
  if (Array.isArray(node.type)) {
    types = intersect(types, new Set(node.type.filter((t) => typeof t === 'string')));
  }
  if ('const' in node) types = intersect(types, new Set([typeOfValue(node.const)]));
  if (Array.isArray(node.enum)) types = intersect(types, new Set(node.enum.map(typeOfValue)));
  for (const key of ['anyOf', 'oneOf']) {
    const branches = node[key];
    if (!Array.isArray(branches)) continue;
    let joined: JsonTypes = new Set();
    for (const branch of branches)
      joined = union(joined, admittedTypes(root, branch, visiting));
    types = intersect(types, joined);
  }
  if (Array.isArray(node.allOf)) {
    for (const branch of node.allOf) {
      types = intersect(types, admittedTypes(root, branch, visiting));
    }
  }
  return types;
}

function openNode(type: string): ToolPresentationSchema {
  // An array keeps an `items` entry: several providers refuse an array schema without one.
  return type === 'array' ? { type, items: {} } : { type };
}

/** The open node closing the last written level of a recursive definition. */
function terminal(root: ToolPresentationSchema, pointer: string): ToolPresentationSchema {
  const definition = resolvePointer(root, pointer);
  const types = admittedTypes(root, definition, new Set([pointer]));
  const ordered = types === 'any' ? [] : JSON_TYPES.filter((type) => types.has(type));
  const node: ToolPresentationSchema =
    ordered.length === 0
      ? {}
      : ordered.length === 1 && ordered[0] !== undefined
        ? openNode(ordered[0])
        : { anyOf: ordered.map(openNode) };
  if (isRecord(definition) && typeof definition.description === 'string') {
    node.description = definition.description;
  }
  return node;
}

/**
 * A written-out reference with sibling keywords. Annotations beside it merge in,
 * the use site winning; any other sibling keeps the conjunction as `allOf`.
 */
function withSiblings(written: unknown, siblings: ToolPresentationSchema): unknown {
  const keys = Object.keys(siblings);
  if (keys.length === 0) return written;
  if (isRecord(written) && keys.every((key) => ANNOTATION_KEYWORDS.has(key))) {
    return { ...written, ...siblings };
  }
  return { allOf: [written], ...siblings };
}

/** A single-branch `allOf` that only wrapped a reference, merged into its node. */
function unwrapReferenceWrapper(
  original: Record<string, unknown>,
  rewritten: ToolPresentationSchema,
): ToolPresentationSchema {
  const branches = original.allOf;
  if (!Array.isArray(branches) || branches.length !== 1) return rewritten;
  const [branch] = branches;
  if (!isRecord(branch) || localReference(branch) === undefined) return rewritten;
  if (Object.keys(branch).length !== 1) return rewritten;
  const [written] = Array.isArray(rewritten.allOf) ? rewritten.allOf : [];
  if (!isRecord(written)) return rewritten;
  const { allOf: _wrapper, ...siblings } = rewritten;
  return Object.keys(siblings).every((key) => ANNOTATION_KEYWORDS.has(key))
    ? { ...written, ...siblings }
    : rewritten;
}

/**
 * Return `schema` with every local reference written out in place, recursive
 * definitions unrolled `depth` levels, and no `definitions` / `$defs` left.
 */
export function inlineSchemaReferences(
  schema: ToolPresentationSchema,
  depth: number,
): ToolPresentationSchema {
  assertInputRecursionDepth('inputRecursionDepth', depth);
  const graph = referenceGraph(schema);
  if (graph.size === 1 && (graph.get('#')?.size ?? 0) === 0) return schema;
  const recursive = recursivePointers(graph);

  const write = (node: unknown, path: readonly string[]): unknown => {
    if (!isRecord(node)) return node;
    const reference = localReference(node);
    if (reference === undefined) {
      const rewritten = mapSubschemas(node, (child) => write(child, path));
      return unwrapReferenceWrapper(node, rewritten);
    }
    const { $ref: _reference, ...rest } = node;
    const siblings = mapSubschemas(rest, (child) => write(child, path));
    const occurrences = path.filter((entry) => entry === reference).length;
    if (recursive.has(reference) && occurrences >= depth) {
      return withSiblings(terminal(schema, reference), siblings);
    }
    const written = write(resolvePointer(schema, reference), [...path, reference]);
    // A reference to the root writes the document again; its dialect is stated once.
    if (isRecord(written) && '$schema' in written) {
      const { $schema: _dialect, ...body } = written;
      return withSiblings(body, siblings);
    }
    return withSiblings(written, siblings);
  };

  const written = write(schema, ['#']);
  return isRecord(written) ? written : {};
}
