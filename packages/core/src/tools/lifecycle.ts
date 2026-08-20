import type { ToolLifecycle } from './execute';

/** Compose tool lifecycle hooks without inventing HTTP-only phases. */
export function composeToolLifecycle(
  ...hooks: readonly (ToolLifecycle | undefined)[]
): ToolLifecycle {
  return {
    beforeHandle: async (ctx, endpoint) => {
      for (const hook of hooks) await hook?.beforeHandle?.(ctx, endpoint);
    },
    afterHandle: async (ctx, result, endpoint) => {
      let current = result;
      for (const hook of hooks) {
        const transformed = await hook?.afterHandle?.(ctx, current, endpoint);
        if (transformed !== undefined) current = transformed;
      }
      return current;
    },
  };
}
