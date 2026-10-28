import { z } from 'zod';

// Public entrypoints are bundled independently but share the same schema
// objects. A global symbol keeps the provenance attached across those bundle
// boundaries without turning it into user-authored JSON Schema metadata.
const JSON_SCHEMA_OBJECT_GUARD = Symbol.for(
  'stitchkit.tools.json-schema-object-guard-origin.v1',
);

function mark(schema: z.core.$ZodType): void {
  if (Reflect.get(schema, JSON_SCHEMA_OBJECT_GUARD) === true) return;
  const marked = Reflect.defineProperty(schema, JSON_SCHEMA_OBJECT_GUARD, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  if (!marked) throw new Error('Cannot mark a restored JSON Schema object guard');
}

function markObjectGuard(schema: z.ZodPipe): boolean {
  if (
    schema.in instanceof z.ZodTransform &&
    schema.out instanceof z.ZodObject &&
    schema.in.def.checks?.length
  ) {
    mark(schema);
    return true;
  }
  return false;
}

/**
 * Record which structural pipes came from the one foreign JSON Schema boundary.
 * The walk runs once after `z.fromJSONSchema`; coercion later reads only this
 * provenance and never guesses from a transform's public shape or metadata.
 */
export function markJsonSchemaObjectGuards(schema: z.core.$ZodType): void {
  const visited = new WeakMap<z.core.$ZodType, boolean>();
  const visit = (current: z.core.$ZodType): boolean => {
    const known = visited.get(current);
    if (known !== undefined) return known;
    // Break a possible lazy cycle. The final value is replaced before return.
    visited.set(current, false);

    if (current instanceof z.ZodPipe) {
      const guarded = markObjectGuard(current);
      visit(current.out);
      visited.set(current, guarded);
      return guarded;
    }
    if (current instanceof z.ZodObject) {
      for (const field of Object.values(current.shape)) visit(field);
      const catchall = current.def.catchall;
      if (catchall) visit(catchall);
      return false;
    }
    if (current instanceof z.ZodArray) {
      visit(current.element);
      return false;
    }
    if (current instanceof z.ZodTuple) {
      for (const item of current.def.items) visit(item);
      if (current.def.rest) visit(current.def.rest);
      return false;
    }
    if (current instanceof z.ZodRecord) {
      visit(current.keyType);
      visit(current.valueType);
      return false;
    }
    if (current instanceof z.ZodUnion) {
      for (const option of current.def.options) visit(option);
      return false;
    }
    if (current instanceof z.ZodIntersection) {
      const leftGuarded = visit(current.def.left);
      const rightGuarded = visit(current.def.right);
      const guarded = leftGuarded || rightGuarded;
      if (guarded) mark(current);
      visited.set(current, guarded);
      return guarded;
    }
    if (
      current instanceof z.ZodOptional ||
      current instanceof z.ZodExactOptional ||
      current instanceof z.ZodNullable ||
      current instanceof z.ZodDefault ||
      current instanceof z.ZodPrefault ||
      current instanceof z.ZodNonOptional ||
      current instanceof z.ZodCatch ||
      current instanceof z.ZodReadonly ||
      current instanceof z.ZodLazy
    ) {
      const guarded = visit(current.unwrap());
      if (guarded) mark(current);
      visited.set(current, guarded);
      return guarded;
    }
    return false;
  };
  visit(schema);
}

const REMOTE_SCHEMA_VERDICT = Symbol.for('stitchkit.tools.json-schema-remote-verdict.v1');

/**
 * Record that a foreign schema leaves unions and string formats to its remote owner.
 *
 * A foreign tool schema is the remote's presentation, and a presentation may join a
 * discriminated union into one object whose shared field is an unlabelled `anyOf` (a stitchkit
 * server with `flattenUnionInput` does, ADR 0205). Every value the remote accepts still passes
 * such a union; which branch a value was meant for does not survive. Judged here, a wrong value
 * can only be refused with every branch listed, while the remote, which holds the original
 * schema, names the one field that is wrong. JSON Schema also carries string formats and
 * patterns without the author's error messages; only the remote can report those faithfully.
 */
export function markRemoteSchemaVerdict(schema: z.ZodObject): void {
  Reflect.defineProperty(schema, REMOTE_SCHEMA_VERDICT, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
}

/**
 * Retain every reported issue except foreign unions and string formats. `null` means that
 * every refusal belongs to the remote, whose answer carries the original schema's wording.
 * A schema that is not a restored foreign one keeps its own verdict whole.
 */
export function localVerdict(schema: z.core.$ZodType, error: z.ZodError): z.ZodError | null {
  if (Reflect.get(schema, REMOTE_SCHEMA_VERDICT) !== true) return error;
  const local = localIssues(error.issues);
  if (local.length === 0) return null;
  return sameIssues(local, error.issues) ? error : new z.ZodError(local);
}

function sameIssues(
  left: readonly z.core.$ZodIssue[],
  right: readonly z.core.$ZodIssue[],
): boolean {
  return left.length === right.length && left.every((issue, index) => issue === right[index]);
}

function localIssues(issues: readonly z.core.$ZodIssue[]): z.core.$ZodIssue[] {
  return issues.flatMap((issue) => {
    if (issue.code === 'invalid_union' || issue.code === 'invalid_format') return [];
    // Record keys wrap their own issues. Keep reported bounds/type/enum failures,
    // and defer a key only when every reason inside its wrapper belongs to the remote.
    if (issue.code === 'invalid_key') {
      const children = localIssues(issue.issues);
      if (children.length === 0) return [];
      if (!sameIssues(children, issue.issues)) return [{ ...issue, issues: children }];
    }
    return [issue];
  });
}

/**
 * Schemas that can guide coercion at a proven foreign object boundary.
 * Intersections need both branches: one carries the key guard, while another
 * can carry nested object fields that also need recursive coercion.
 */
export function jsonSchemaObjectCoercionMembers(
  schema: z.core.$ZodType,
): readonly z.core.$ZodType[] | undefined {
  if (Reflect.get(schema, JSON_SCHEMA_OBJECT_GUARD) !== true) return undefined;
  if (schema instanceof z.ZodPipe && schema.out instanceof z.ZodObject) {
    return [schema.out];
  }
  if (schema instanceof z.ZodIntersection) {
    return [schema.def.left, schema.def.right];
  }
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodExactOptional ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodDefault ||
    schema instanceof z.ZodPrefault ||
    schema instanceof z.ZodNonOptional ||
    schema instanceof z.ZodCatch ||
    schema instanceof z.ZodReadonly ||
    schema instanceof z.ZodLazy
  ) {
    return [schema.unwrap()];
  }
  return undefined;
}
