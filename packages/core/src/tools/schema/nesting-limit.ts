/**
 * Keep a tool's input document within a provider's nesting limit.
 *
 * Some providers refuse the whole tool set when one input document is nested deeper than a fixed
 * number of levels, counted as the steps `properties → property` and `items`; `anyOf`, `oneOf`,
 * `allOf` and `additionalProperties` cost nothing, and a property named after one of those two
 * keywords costs two. The limit leaves a document at or under it untouched. Deeper, the node whose
 * next step would cross the limit becomes an open node that accepts any value — the projection
 * widens, it never narrows (ADR 0050) — and the handler still validates with the authored schema.
 */
import { assertInputNestingDepth } from '../../contract/define-validation';
import { isRecord } from '../../internal/typed';
import type { ToolPresentationSchema } from './flatten';

/** A property with one of these names costs two levels: providers read it as the keyword too. */
const KEYWORD_PROPERTY_NAMES = new Set(['items', 'properties']);
const FREE_BRANCHES = ['anyOf', 'oneOf', 'allOf'] as const;

interface Step {
  readonly child: Record<string, unknown>;
  readonly cost: number;
}

function steps(node: Record<string, unknown>): Step[] {
  const found: Step[] = [];
  if (isRecord(node.properties))
    for (const [name, child] of Object.entries(node.properties))
      if (isRecord(child))
        found.push({ child, cost: KEYWORD_PROPERTY_NAMES.has(name) ? 2 : 1 });
  const items = node.items;
  if (isRecord(items)) found.push({ child: items, cost: 1 });
  // draft-07 spells a tuple `items: [...]`.
  if (Array.isArray(items))
    for (const entry of items) if (isRecord(entry)) found.push({ child: entry, cost: 1 });
  for (const key of FREE_BRANCHES)
    if (Array.isArray(node[key]))
      for (const branch of node[key])
        if (isRecord(branch)) found.push({ child: branch, cost: 0 });
  if (isRecord(node.additionalProperties))
    found.push({ child: node.additionalProperties, cost: 0 });
  return found;
}

/** The deepest level any step below `node` reaches, counted from `node` itself. */
function reach(node: Record<string, unknown>): number {
  let deepest = 0;
  for (const { child, cost } of steps(node)) deepest = Math.max(deepest, cost + reach(child));
  return deepest;
}

function openNode(node: Record<string, unknown>): ToolPresentationSchema {
  return typeof node.description === 'string' ? { description: node.description } : {};
}

/**
 * Return `schema` with every node whose subtree would cross `limit` levels replaced by an open
 * node, placed as deep as the limit allows. `onOpened` receives each opened property's dotted path
 * (the form `findUntypedProperties` reports), so a typed-property check can accept it.
 */
export function limitInputNesting(
  schema: ToolPresentationSchema,
  limit: number,
  onOpened?: (path: string) => void,
): ToolPresentationSchema {
  assertInputNestingDepth('inputNestingDepth', limit);
  const visit = (node: Record<string, unknown>, depth: number, path: string): unknown => {
    if (depth + reach(node) <= limit) return node;
    // A step out of this node lands past the limit: it is the deepest node that may stand.
    if (steps(node).some(({ cost }) => depth + cost > limit)) {
      onOpened?.(path);
      return openNode(node);
    }
    const rewritten: Record<string, unknown> = { ...node };
    if (isRecord(node.properties)) {
      const properties: Record<string, unknown> = {};
      for (const [name, child] of Object.entries(node.properties)) {
        const cost = KEYWORD_PROPERTY_NAMES.has(name) ? 2 : 1;
        properties[name] = isRecord(child)
          ? visit(child, depth + cost, path === '' ? name : `${path}.${name}`)
          : child;
      }
      rewritten.properties = properties;
    }
    if (isRecord(node.items)) rewritten.items = visit(node.items, depth + 1, path);
    if (Array.isArray(node.items))
      rewritten.items = node.items.map((entry) =>
        isRecord(entry) ? visit(entry, depth + 1, path) : entry,
      );
    for (const key of FREE_BRANCHES)
      if (Array.isArray(node[key]))
        rewritten[key] = node[key].map((branch) =>
          isRecord(branch) ? visit(branch, depth, path) : branch,
        );
    if (isRecord(node.additionalProperties))
      rewritten.additionalProperties = visit(node.additionalProperties, depth, path);
    return rewritten;
  };
  const limited = visit(schema, 0, '');
  return isRecord(limited) ? limited : schema;
}
