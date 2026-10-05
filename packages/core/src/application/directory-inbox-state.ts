import type { FileObservation } from '../internal/file-observation';
import {
  type DirectoryInboxRejection,
  type DirectoryInboxState,
  DirectoryInboxStateSchema,
  emptyDirectoryInboxState,
} from './directory-inbox-contract';
import type { InboxFiles } from './directory-inbox-files';
import type { StateStore, StateStoreUpdate, StateStoreUpdateContext } from './state-store';

export interface InboxStateAccess {
  update<TResult>(
    transition: (
      state: DirectoryInboxState,
      context: StateStoreUpdateContext,
    ) =>
      | StateStoreUpdate<DirectoryInboxState, TResult>
      | Promise<StateStoreUpdate<DirectoryInboxState, TResult>>,
  ): Promise<TResult>;
  read(): Promise<DirectoryInboxState>;
}

export function inboxStateAccess(store: StateStore<DirectoryInboxState>): InboxStateAccess {
  const parse = (current: DirectoryInboxState | null) =>
    DirectoryInboxStateSchema.parse(current ?? emptyDirectoryInboxState());
  return {
    read: async () => parse(await store.read()),
    update: (transition) =>
      store.update(async (current, context) => {
        const parsed = parse(current);
        const next = await transition(parsed, context);
        // A store persists only a different object; an untouched parse is the stored state.
        return next.state === parsed && current !== null
          ? { state: current, result: next.result }
          : next;
      }),
  };
}

/** Durable settlement precedes cleanup; cleanup rechecks its fact and exact file generation. */
export async function cleanupInboxEntry(
  access: InboxStateAccess,
  files: InboxFiles,
  key: string,
  settlement: { completedAt: string } | DirectoryInboxRejection,
  observation?: FileObservation,
): Promise<void> {
  await access.update(async (state, context) => {
    if (state.claims.some((claim) => claim.key === key)) return { state, result: undefined };
    if ('completedAt' in settlement) {
      if (
        state.receipts.some(
          (receipt) => receipt.key === key && receipt.completedAt === settlement.completedAt,
        )
      )
        await files.remove(key, context, observation);
    } else if (
      state.rejected.some(
        (rejection) =>
          rejection.key === key &&
          rejection.rejectedAt === settlement.rejectedAt &&
          rejection.reason === settlement.reason,
      )
    ) {
      await files.setAside(key, context, observation);
    }
    return { state, result: undefined };
  });
}
