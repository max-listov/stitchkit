import { raceAbort } from '../internal/abort-race';
import { backoffDelay } from '../internal/backoff';
import {
  completeEntry,
  type DirectoryInboxClaim,
  type DirectoryInboxConfig,
  type DirectoryInboxRejection,
  ownsClaim,
  releaseEntry,
  renewEntry,
  withRejection,
} from './directory-inbox-contract';
import { InboxEntryError, type InboxFiles, type InboxRead } from './directory-inbox-files';
import { cleanupInboxEntry, type InboxStateAccess } from './directory-inbox-state';

const RETRY_BACKOFF = { minDelayMs: 1_000, maxDelayMs: 300_000, jitter: 0 };

export function createInboxDelivery<TEntry, TInput>(options: {
  config: DirectoryInboxConfig<TEntry, TInput>;
  access: InboxStateAccess;
  files: () => InboxFiles;
  clock: () => Date;
  forced: () => AbortSignal;
  leaseMs: number;
  retain: number;
  report: (error: unknown) => Promise<void>;
}) {
  const { access, clock, config } = options;
  return async (taken: DirectoryInboxClaim): Promise<boolean> => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, options.forced()]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let renewing: Promise<void> = Promise.resolve();
    const renew = (): void => {
      renewing = access
        .update((state) => {
          const next = renewEntry(state, taken, clock(), options.leaseMs);
          return { state: next, result: next !== state };
        })
        .then((held) => {
          if (!held) controller.abort(new Error('Inbox delivery lease was lost'));
          if (!signal.aborted)
            timer = setTimeout(renew, Math.max(10, Math.floor(options.leaseMs / 4)));
        })
        .catch(async (error: unknown) => {
          controller.abort(error);
          await options.report(error);
        });
    };
    if (!signal.aborted)
      timer = setTimeout(renew, Math.max(10, Math.floor(options.leaseMs / 4)));
    // The entry failed this time and is taken again after a backoff.
    const release = async (owned: DirectoryInboxClaim): Promise<void> => {
      await access.update((state) => ({
        state: signal.aborted
          ? state
          : releaseEntry(
              state,
              owned,
              clock(),
              new Date(clock().getTime() + backoffDelay(RETRY_BACKOFF, owned.attempts)),
            ),
        result: undefined,
      }));
    };
    try {
      const files = options.files();
      let read: InboxRead<TEntry>;
      try {
        read = await files.read(taken.key, config.schema);
      } catch (error) {
        // The entry changed under the read or cannot be read: a later attempt reads
        // it again, and the attempt limit settles one that never stabilises.
        if (!(error instanceof InboxEntryError)) throw error;
        await options.report(error.cause);
        await release(taken);
        return false;
      }
      if (read === null || signal.aborted) return false;
      const claim = { ...taken, ...(read.identity && { identity: read.identity }) };
      if ('reason' in read) {
        const rejection: DirectoryInboxRejection = {
          key: claim.key,
          ...(claim.identity && { identity: claim.identity }),
          reason: read.reason,
          detail: read.detail,
          rejectedAt: clock().toISOString(),
        };
        const settled = await access.update((state) => {
          if (signal.aborted || !ownsClaim(state, claim, clock()))
            return { state, result: false };
          return { state: withRejection(state, rejection, options.retain), result: true };
        });
        if (settled) {
          await cleanupInboxEntry(access, files, claim.key, rejection, read.observation);
          await config.onRejected?.(rejection);
        }
        return false;
      }
      // Persist full producer metadata on the live claim before exposing the entry.
      const held = await access.update((state) => {
        if (signal.aborted || !ownsClaim(state, claim, clock()))
          return { state, result: false };
        return {
          state: {
            ...state,
            claims: state.claims.map((item) =>
              item.key === claim.key
                ? { ...item, ...(claim.identity && { identity: claim.identity }) }
                : item,
            ),
          },
          result: true,
        };
      });
      if (!held || signal.aborted) return false;
      try {
        await raceAbort(
          Promise.resolve().then(() => {
            signal.throwIfAborted();
            return config.handle({
              key: claim.key,
              ...(claim.identity && { identity: claim.identity }),
              entry: read.entry,
              attempt: claim.attempts,
              signal,
            });
          }),
          signal,
        );
      } catch (error) {
        await options.report(error);
        await release(claim);
        return false;
      }
      const completedAt = clock();
      const completed = await access.update((state) => {
        const next = signal.aborted
          ? state
          : completeEntry(state, claim, completedAt, options.retain);
        return { state: next, result: next !== state };
      });
      if (!completed) return false;
      await cleanupInboxEntry(
        access,
        files,
        claim.key,
        { completedAt: completedAt.toISOString() },
        read.observation,
      );
      return true;
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort(new Error('Inbox delivery ended'));
      await renewing;
    }
  };
}
