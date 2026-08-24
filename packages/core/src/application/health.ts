import { z } from 'zod';
import type { ApplicationHandle } from './kernel';

export const ApplicationHealthHandlerOptionsSchema = z.object({
  kind: z.enum(['liveness', 'readiness']),
  retryAfterSeconds: z.number().int().nonnegative().default(5),
});
export type ApplicationHealthHandlerOptions = z.input<
  typeof ApplicationHealthHandlerOptionsSchema
>;

/** Fetch-clean liveness/readiness response with only the sanitized application snapshot. */
export function createApplicationHealthHandler(
  application: Pick<ApplicationHandle, 'getSnapshot'>,
  options: ApplicationHealthHandlerOptions,
): () => Response {
  const parsed = ApplicationHealthHandlerOptionsSchema.parse(options);
  return () => {
    const snapshot = application.getSnapshot();
    const healthy =
      parsed.kind === 'readiness'
        ? snapshot.ready
        : snapshot.lifecycle !== 'failed' && snapshot.lifecycle !== 'stopped';
    return Response.json(snapshot, {
      status: healthy ? 200 : 503,
      ...(healthy ? {} : { headers: { 'Retry-After': String(parsed.retryAfterSeconds) } }),
    });
  };
}
