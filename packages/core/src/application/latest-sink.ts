import { z } from 'zod';

const SnapshotRevisionSchema = z.number().int().nonnegative();

export const ApplicationSnapshotSinkStatusSchema = z
  .object({
    accepting: z.boolean(),
    received: z.number().int().nonnegative(),
    accepted: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    delivered: z.number().int().nonnegative(),
    coalesced: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    inFlight: z.boolean(),
    pending: z.boolean(),
    lastAcceptedRevision: SnapshotRevisionSchema.optional(),
    lastDeliveredRevision: SnapshotRevisionSchema.optional(),
  })
  .strict()
  .readonly();
export type ApplicationSnapshotSinkStatus = z.infer<
  typeof ApplicationSnapshotSinkStatusSchema
>;

export interface RevisionedApplicationSnapshot {
  readonly revision: number;
}

export interface ApplicationSnapshotSinkError<TSnapshot> {
  readonly error: unknown;
  readonly snapshot: TSnapshot;
}

export interface ApplicationSnapshotSinkConfig<
  TSnapshot extends RevisionedApplicationSnapshot,
> {
  write(snapshot: TSnapshot): void | Promise<void>;
  onSinkError?(failure: ApplicationSnapshotSinkError<TSnapshot>): void | Promise<void>;
}

export interface ApplicationSnapshotSink<TSnapshot extends RevisionedApplicationSnapshot> {
  /** Admit a newer absolute snapshot. Returns false after close or for a stale revision. */
  publish(snapshot: TSnapshot): boolean;
  getStatus(): ApplicationSnapshotSinkStatus;
  /** Close admission and deliver the newest snapshot accepted before this boundary. */
  close(): Promise<ApplicationSnapshotSinkStatus>;
}

/**
 * Deliver absolute state without growing a queue: one write runs while one newer
 * revision may wait, and that pending value is replaced by every still-newer one.
 */
export function createApplicationSnapshotSink<TSnapshot extends RevisionedApplicationSnapshot>(
  config: ApplicationSnapshotSinkConfig<TSnapshot>,
): ApplicationSnapshotSink<TSnapshot> {
  let accepting = true;
  let received = 0;
  let accepted = 0;
  let rejected = 0;
  let delivered = 0;
  let coalesced = 0;
  let failed = 0;
  let lastAcceptedRevision: number | undefined;
  let lastDeliveredRevision: number | undefined;
  let inFlight: Promise<void> | undefined;
  let pending: TSnapshot | undefined;
  let closePromise: Promise<ApplicationSnapshotSinkStatus> | undefined;
  let resolveClose: ((status: ApplicationSnapshotSinkStatus) => void) | undefined;

  const getStatus = (): ApplicationSnapshotSinkStatus =>
    ApplicationSnapshotSinkStatusSchema.parse({
      accepting,
      received,
      accepted,
      rejected,
      delivered,
      coalesced,
      failed,
      inFlight: inFlight !== undefined,
      pending: pending !== undefined,
      ...(lastAcceptedRevision !== undefined && { lastAcceptedRevision }),
      ...(lastDeliveredRevision !== undefined && { lastDeliveredRevision }),
    });

  const reportFailure = (error: unknown, snapshot: TSnapshot): void => {
    if (!config.onSinkError) return;
    void Promise.resolve()
      .then(() => config.onSinkError?.({ error, snapshot }))
      .catch(() => undefined);
  };

  const settleCloseIfIdle = (): void => {
    if (accepting || inFlight || pending || !resolveClose) return;
    const resolve = resolveClose;
    resolveClose = undefined;
    resolve(getStatus());
  };

  const startWrite = (snapshot: TSnapshot): void => {
    const write = Promise.resolve()
      .then(() => config.write(snapshot))
      .then(() => {
        delivered += 1;
        lastDeliveredRevision = snapshot.revision;
      })
      .catch((error) => {
        failed += 1;
        reportFailure(error, snapshot);
      })
      .finally(() => {
        inFlight = undefined;
        const next = pending;
        pending = undefined;
        if (next) startWrite(next);
        else settleCloseIfIdle();
      });
    inFlight = write;
  };

  return {
    publish(snapshot) {
      received += 1;
      const revision = SnapshotRevisionSchema.parse(snapshot.revision);
      if (
        !accepting ||
        (lastAcceptedRevision !== undefined && revision <= lastAcceptedRevision)
      ) {
        rejected += 1;
        return false;
      }
      accepted += 1;
      lastAcceptedRevision = revision;
      if (!inFlight) {
        startWrite(snapshot);
      } else {
        if (pending) coalesced += 1;
        pending = snapshot;
      }
      return true;
    },
    getStatus,
    close() {
      if (closePromise) return closePromise;
      accepting = false;
      closePromise = new Promise((resolve) => {
        resolveClose = resolve;
        settleCloseIfIdle();
      });
      return closePromise;
    },
  };
}
