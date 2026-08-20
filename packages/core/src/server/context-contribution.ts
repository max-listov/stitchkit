import type { RuntimeContext } from '../contract';
import { isUnsafeKey } from '../internal/safe-json';

/** Keys whose value is owned by a transport/runtime boundary, never by application enrichment. */
export const RUNTIME_CONTEXT_RESERVED_KEYS = new Set([
  'params',
  'input',
  'files',
  'rawBody',
  'source',
  'req',
  'url',
  'headers',
  'traceId',
  'spanId',
  'ipAddress',
  'userAgent',
  'signal',
  'mcp',
]);

function contributionError(scope: string, reason: string): TypeError {
  return new TypeError(
    `[stitchkit] auth: invalid context contribution for scope ${JSON.stringify(scope)}: ${reason}`,
  );
}

/**
 * Validate the complete contribution before mutating the runtime context.
 * Accessors, exotic prototypes and transport-owned keys fail closed so a
 * rejected contribution can never leave a partial or poisoned context.
 */
export function mergeContextContribution(
  ctx: RuntimeContext,
  value: unknown,
  scope: string,
): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw contributionError(scope, 'expected a plain record');
  }

  let prototype: object | null;
  let descriptors: Record<string, PropertyDescriptor>;
  let keys: Array<string | symbol>;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
    keys = Reflect.ownKeys(value);
  } catch {
    throw contributionError(scope, 'record inspection failed');
  }

  if (prototype !== Object.prototype && prototype !== null) {
    throw contributionError(scope, 'expected Object.prototype or null prototype');
  }

  const prepared: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (typeof key !== 'string') {
      throw contributionError(scope, 'symbol keys are not supported');
    }
    if (isUnsafeKey(key)) {
      throw contributionError(scope, `unsafe key ${JSON.stringify(key)}`);
    }
    if (RUNTIME_CONTEXT_RESERVED_KEYS.has(key)) {
      throw contributionError(scope, `reserved key ${JSON.stringify(key)}`);
    }
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      throw contributionError(scope, `key ${JSON.stringify(key)} must be enumerable data`);
    }
    prepared[key] = descriptor.value;
  }

  Object.assign(ctx, prepared);
}
