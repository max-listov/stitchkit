import type { LifecycleHooks } from './types';

/** Compose ordinary HTTP lifecycle hooks inside each existing phase slot. */
export function composeLifecycleHooks(
  ...hooks: readonly (LifecycleHooks | undefined)[]
): LifecycleHooks {
  return {
    onRequest: async (request) => {
      for (const hook of hooks) {
        const response = await hook?.onRequest?.(request);
        if (response instanceof Response) return response;
      }
      return undefined;
    },
    authorize: async (ctx, endpoint) => {
      for (const hook of hooks) await hook?.authorize?.(ctx, endpoint);
    },
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
    onError: async (ctx, error, endpoint) => {
      for (const hook of hooks) {
        const response = await hook?.onError?.(ctx, error, endpoint);
        if (response instanceof Response) return response;
      }
      return undefined;
    },
  };
}
