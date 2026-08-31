import type { RuntimeContext } from '../contract';
import type { LifecycleHooks, MethodDef, StitchLogger } from './types';

/** Route-local policy gets the first response; fallback always sees the original error. */
export async function dispatchErrorHooks(config: {
  context: RuntimeContext;
  error: unknown;
  endpoint?: MethodDef;
  group?: LifecycleHooks;
  global?: LifecycleHooks;
  logger: StitchLogger | null;
  respond: (response: Response) => Response;
}): Promise<Response | undefined> {
  for (const [scope, hooks] of [
    ['group', config.group],
    ['global', config.global],
  ] satisfies Array<[string, LifecycleHooks | undefined]>) {
    if (!hooks?.onError) continue;
    try {
      const response = await hooks.onError(config.context, config.error, config.endpoint);
      if (response instanceof Response) return config.respond(response);
    } catch (error) {
      const message = `[stitchkit] ${scope} onError failed`;
      try {
        if (config.logger) {
          config.logger.error(message, { error, traceId: config.context.traceId });
        } else console.error(message, error);
      } catch {
        // A diagnostic sink cannot replace the original request failure.
      }
    }
  }
  return undefined;
}
