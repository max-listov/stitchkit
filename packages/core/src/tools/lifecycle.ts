import { isRecord } from '../internal/typed';
import type { ToolGate } from './access';
import type { ToolLifecycle } from './execute-hooks';

/**
 * Compose tool lifecycle hooks without inventing HTTP-only phases.
 * The first argument must be a `ToolGate` (carrying `beforeHandle`), and every
 * subsequent argument must be a defined `ToolLifecycle`; `undefined` is refused
 * both at compile time and at runtime.
 */
export function composeToolLifecycle(
  gate: ToolGate,
  ...rest: readonly ToolLifecycle[]
): ToolGate {
  if (!isRecord(gate) || typeof gate.beforeHandle !== 'function') {
    throw new TypeError(
      'composeToolLifecycle: first argument must be a ToolGate with a beforeHandle function',
    );
  }
  if (gate.afterHandle !== undefined && typeof gate.afterHandle !== 'function') {
    throw new TypeError('composeToolLifecycle: argument 0 afterHandle must be a function');
  }
  const hooks: readonly ToolLifecycle[] = [gate, ...rest];
  for (let i = 1; i < hooks.length; i += 1) {
    const hook = hooks[i];
    if (!isRecord(hook)) {
      throw new TypeError(
        `composeToolLifecycle: argument ${i} must be a ToolLifecycle object, not ${hook === undefined ? 'undefined' : typeof hook}`,
      );
    }
    if (hook.beforeHandle !== undefined && typeof hook.beforeHandle !== 'function') {
      throw new TypeError(
        `composeToolLifecycle: argument ${i} beforeHandle must be a function`,
      );
    }
    if (hook.afterHandle !== undefined && typeof hook.afterHandle !== 'function') {
      throw new TypeError(
        `composeToolLifecycle: argument ${i} afterHandle must be a function`,
      );
    }
  }
  return {
    beforeHandle: async (ctx, endpoint) => {
      for (const hook of hooks) await hook.beforeHandle?.(ctx, endpoint);
    },
    afterHandle: async (ctx, result, endpoint) => {
      let current = result;
      for (const hook of hooks) {
        const transformed = await hook.afterHandle?.(ctx, current, endpoint);
        if (transformed !== undefined) current = transformed;
      }
      return current;
    },
  };
}
