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

function descriptorsEqual(
  left: PropertyDescriptor | undefined,
  right: PropertyDescriptor | undefined,
): boolean {
  if (!left || !right) return left === right;
  if (
    left.enumerable !== right.enumerable ||
    left.configurable !== right.configurable ||
    left.writable !== right.writable
  ) {
    return false;
  }
  if ('value' in left || 'value' in right) {
    return 'value' in left && 'value' in right && Object.is(left.value, right.value);
  }
  return left.get === right.get && left.set === right.set;
}

/**
 * Return the application-owned fields changed on an isolated context. The
 * descriptors are preserved so the regular contribution validator can reject
 * accessors and symbols without invoking consumer code.
 */
export function contextContributionDelta(
  original: RuntimeContext,
  shadow: RuntimeContext,
  scope: string,
): Record<string, unknown> {
  if (Object.getPrototypeOf(shadow) !== Object.getPrototypeOf(original)) {
    throw contributionError(scope, 'context prototype changes are not supported');
  }

  const originalKeys = Reflect.ownKeys(original);
  const shadowKeys = Reflect.ownKeys(shadow);
  const shadowKeySet = new Set(shadowKeys);
  for (const key of originalKeys) {
    if (!shadowKeySet.has(key)) {
      const printable = typeof key === 'string' ? JSON.stringify(key) : 'a symbol key';
      throw contributionError(scope, `context key ${printable} may not be deleted`);
    }
  }

  const contribution: Record<string, unknown> = Object.create(null);
  for (const key of shadowKeys) {
    const originalDescriptor = Object.getOwnPropertyDescriptor(original, key);
    const shadowDescriptor = Object.getOwnPropertyDescriptor(shadow, key);
    if (!shadowDescriptor || descriptorsEqual(originalDescriptor, shadowDescriptor)) continue;
    Object.defineProperty(contribution, key, shadowDescriptor);
  }
  return contribution;
}

/** Validate and copy a contribution without mutating a runtime context. */
export function prepareContextContribution(
  value: unknown,
  scope: string,
): Record<string, unknown> {
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

  return prepared;
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
  Object.assign(ctx, prepareContextContribution(value, scope));
}
