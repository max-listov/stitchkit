/**
 * Pre-execution column verification for CLI aggregate/table/sort views.
 *
 * When a command's declared `output` schema unambiguously describes one
 * collection of closed object records, an unknown column is refused with exit
 * code 2 BEFORE the handler runs (even when the result would be empty). When
 * the schema is open or ambiguous (`z.unknown()`, `z.record`, `looseObject`,
 * union, multiple arrays, optional array), the existing post-call check in
 * `view.ts` remains in force.
 */
import { z } from 'zod';
import { isUnsafeKey } from '../../internal/safe-json';
import { unwrapZodWrappers } from '../schema/schema';
import type { CliResultView } from './args-view';
import { CliArgumentError } from './argument-error';

function unwrapReadonly(schema: z.core.$ZodType): z.core.$ZodType {
  return schema instanceof z.ZodReadonly ? unwrapReadonly(schema.unwrap()) : schema;
}

function hasOpenCatchall(objectSchema: z.ZodObject): boolean {
  const catchall = objectSchema.def.catchall;
  return catchall !== undefined && !(catchall instanceof z.ZodNever);
}

function couldBeArray(schema: z.core.$ZodType): boolean {
  const base = unwrapZodWrappers(schema);
  if (base instanceof z.ZodArray || base instanceof z.ZodTuple) return true;
  if (base instanceof z.ZodUnknown || base instanceof z.ZodAny) return true;
  if (base instanceof z.ZodUnion) return base.def.options.some(couldBeArray);
  if (base instanceof z.ZodIntersection) {
    return couldBeArray(base.def.left) || couldBeArray(base.def.right);
  }
  return false;
}

/**
 * Mirror `selectRecords` (`view.ts`) on the declared output schema.
 * Returns the closed record `ZodObject` only when the collection and its
 * element shape are unambiguous; otherwise returns `undefined`.
 */
function resolveUnambiguousRecordSchema(
  outputSchema: z.ZodType | undefined,
): z.ZodObject | undefined {
  if (outputSchema === undefined) return undefined;
  const root = unwrapReadonly(outputSchema);
  let element: z.core.$ZodType | undefined;

  if (root instanceof z.ZodArray) {
    element = root.element;
  } else if (root instanceof z.ZodObject) {
    if (hasOpenCatchall(root)) return undefined;
    let requiredArray: z.ZodArray | undefined;
    for (const field of Object.values(root.shape)) {
      const bare = unwrapReadonly(field);
      if (bare instanceof z.ZodArray) {
        if (requiredArray !== undefined) return undefined;
        requiredArray = bare;
        continue;
      }
      if (couldBeArray(field)) return undefined;
    }
    element = requiredArray?.element;
  }

  if (element === undefined) return undefined;
  const record = unwrapReadonly(element);
  if (!(record instanceof z.ZodObject) || hasOpenCatchall(record)) return undefined;
  return record;
}

/** Whether `path` may exist on `schema` (mirrors `describeSchemaPath` traversal). */
function pathExistsOnSchema(schema: z.core.$ZodType, path: readonly string[]): boolean {
  if (path.length === 0) return true;
  const base = unwrapZodWrappers(schema);
  if (base instanceof z.ZodUnknown || base instanceof z.ZodAny) return true;
  if (base instanceof z.ZodRecord) return pathExistsOnSchema(base.valueType, path.slice(1));
  if (base instanceof z.ZodUnion) {
    return base.def.options.some((branch) => pathExistsOnSchema(branch, path));
  }
  if (base instanceof z.ZodIntersection) {
    return pathExistsOnSchema(base.def.left, path) || pathExistsOnSchema(base.def.right, path);
  }
  if (base instanceof z.ZodObject) {
    const [head, ...rest] = path;
    if (head === undefined) return true;
    if (Object.hasOwn(base.shape, head)) {
      const child = base.shape[head];
      return child !== undefined && pathExistsOnSchema(child, rest);
    }
    if (hasOpenCatchall(base) && base.def.catchall !== undefined) {
      return pathExistsOnSchema(base.def.catchall, rest);
    }
    return false;
  }
  return false;
}

function requestedViewFields(view: CliResultView): readonly string[] {
  if (view.kind === 'records') {
    return [...(view.sort === undefined ? [] : [view.sort]), ...(view.table ?? [])];
  }
  if (view.kind === 'sum') {
    return [view.field, ...(view.by === undefined ? [] : [view.by])];
  }
  return [view.field];
}

/**
 * Refuse view columns absent from an unambiguous collection output schema
 * before the command handler runs.
 */
export function assertViewColumns(
  view: CliResultView,
  outputSchema: z.ZodType | undefined,
): void {
  const record = resolveUnambiguousRecordSchema(outputSchema);
  if (record === undefined) return;
  const available = Object.keys(record.shape).sort();
  for (const field of requestedViewFields(view)) {
    const path = field.split('.');
    if (path.some((segment) => segment.length === 0 || isUnsafeKey(segment))) {
      throw new CliArgumentError(`"${field}" is not a readable field path`);
    }
    if (!pathExistsOnSchema(record, path)) {
      throw new CliArgumentError(
        `no record carries the field "${field}"${
          available.length > 0 ? ` — available: ${available.join(', ')}` : ''
        }`,
      );
    }
  }
}
