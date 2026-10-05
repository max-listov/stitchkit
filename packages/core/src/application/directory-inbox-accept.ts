import type { z } from 'zod';
import {
  type DirectoryInboxAccept,
  type DirectoryInboxAcceptResult,
  DirectoryInboxIdentitySchema,
} from './directory-inbox-contract';
import {
  encodeInboxEntry,
  type InboxFiles,
  inboxFilename,
  sameInboxIdentity,
} from './directory-inbox-files';
import type { InboxStateAccess } from './directory-inbox-state';

export function createInboxAccept<TEntry, TInput>(options: {
  access: InboxStateAccess;
  files: () => InboxFiles;
  accepting: () => boolean;
  schema: z.ZodType<TEntry, TInput>;
  maxEntryBytes: number;
  maxPendingEntries: number;
}) {
  return async (input: DirectoryInboxAccept<TInput>): Promise<DirectoryInboxAcceptResult> => {
    if (!options.accepting()) throw new Error('Directory inbox is not accepting entries');
    const identity = DirectoryInboxIdentitySchema.parse({
      source: input.source,
      key: input.key,
    });
    const filename = inboxFilename(identity);
    const bytes = encodeInboxEntry(
      identity,
      input.entry,
      options.schema,
      options.maxEntryBytes,
    );
    return options.access.update<DirectoryInboxAcceptResult>(async (state, context) => {
      if (!options.accepting()) throw new Error('Directory inbox is not accepting entries');
      const files = options.files();
      const remembered = [...state.receipts, ...state.rejected, ...state.claims].find(
        (item) => item.key === filename,
      );
      const existing = remembered?.identity ?? (await files.existingIdentity(filename));
      if (remembered || existing) {
        if (!sameInboxIdentity(existing, identity))
          throw new Error('Inbox filename belongs to a different producer identity');
        return { state, result: { status: 'duplicate', filename } };
      }
      if ((await files.names(options.maxPendingEntries)).length >= options.maxPendingEntries)
        throw new RangeError('Directory inbox reached maxPendingEntries');
      if (!options.accepting()) throw new Error('Directory inbox is not accepting entries');
      await files.publish(filename, bytes, context);
      return { state, result: { status: 'accepted', filename } };
    });
  };
}
