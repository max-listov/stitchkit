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
import type { InboxFiles } from './directory-inbox-files';
import { cleanupInboxEntry, type InboxStateAccess } from './directory-inbox-state';

const RETRY_BACKOFF = { minDelayMs: 1_000, maxDelayMs: 300_000, jitter: 0 };

export function createInboxDelivery<TEntry>(options: {
  config: DirectoryInboxConfig<TEntry>;
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
    try {
      const files = options.files();
      const read = await files.read(taken.key, config.schema);
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
        await access.update((state) => ({
          state: signal.aborted
            ? state
            : releaseEntry(
                state,
                claim,
                clock(),
                new Date(clock().getTime() + backoffDelay(RETRY_BACKOFF, claim.attempts)),
              ),
          result: undefined,
        }));
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
