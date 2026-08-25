import { z } from 'zod';
import type { ApplicationHandle } from './kernel';
import { projectApplicationStatus } from './schemas';

export const ApplicationHealthHandlerOptionsSchema = z.object({
  kind: z.enum(['liveness', 'readiness']),
  retryAfterSeconds: z.number().int().nonnegative().default(5),
});
export type ApplicationHealthHandlerOptions = z.input<
  typeof ApplicationHealthHandlerOptionsSchema
>;

export const ApplicationOperationalHandlersOptionsSchema = z.object({
  retryAfterSeconds: z.number().int().nonnegative().default(5),
});
export type ApplicationOperationalHandlersOptions = z.input<
  typeof ApplicationOperationalHandlersOptionsSchema
>;

export interface ApplicationOperationalHandlers {
  /** Always-readable published projection of the application snapshot. */
  status(): Response;
  readiness(): Response;
  liveness(): Response;
}

/**
 * Fetch-clean liveness/readiness response carrying the published projection.
 *
 * Never the raw snapshot: it names every resource, its `dependsOn` edges, the
 * process epoch and live admission counters, and these handlers are documented
 * for public mounting. The full snapshot stays available in-process through
 * `getSnapshot()`.
 */
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
    return Response.json(projectApplicationStatus(snapshot), {
      status: healthy ? 200 : 503,
      ...(healthy ? {} : { headers: { 'Retry-After': String(parsed.retryAfterSeconds) } }),
    });
  };
}

/** Compose the canonical status and probe handlers without introducing another state model. */
export function createApplicationOperationalHandlers(
  application: Pick<ApplicationHandle, 'getSnapshot'>,
  options: ApplicationOperationalHandlersOptions = {},
): ApplicationOperationalHandlers {
  const parsed = ApplicationOperationalHandlersOptionsSchema.parse(options);
  return {
    status: () => Response.json(projectApplicationStatus(application.getSnapshot())),
    readiness: createApplicationHealthHandler(application, {
      kind: 'readiness',
      retryAfterSeconds: parsed.retryAfterSeconds,
    }),
    liveness: createApplicationHealthHandler(application, {
      kind: 'liveness',
      retryAfterSeconds: parsed.retryAfterSeconds,
    }),
  };
}
