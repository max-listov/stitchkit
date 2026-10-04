import { createHash } from 'node:crypto';
import { lstat, mkdir, open, opendir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { writeAtomicFileData } from '../internal/atomic-file';
import { publishAtomicFile } from '../internal/atomic-publication';
import {
  BoundedFileReadError,
  type FileObservation,
  readBoundedFile,
} from '../internal/bounded-file-read';
import { isJsonData } from '../internal/json-data';
import {
  type DirectoryInboxIdentity,
  DirectoryInboxIdentitySchema,
} from './directory-inbox-contract';
import type { StateStoreUpdateContext } from './state-store';

const ENTRY_NAME = /^[^.].*\.json$/;
const ACCEPTED_NAME = /^intake-[0-9a-f]{64}\.json$/;
const EnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    identity: DirectoryInboxIdentitySchema,
    entry: z.unknown(),
  })
  .strict();

export type InboxRead<TEntry> =
  | { entry: TEntry; identity?: DirectoryInboxIdentity; observation: FileObservation }
  | {
      reason: 'invalid' | 'too-large';
      detail: string;
      identity?: DirectoryInboxIdentity;
      observation?: FileObservation;
    }
  | null;

export const missingInboxFile = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

export function inboxFilename(identity: DirectoryInboxIdentity): string {
  return (
    'intake-' +
    createHash('sha256')
      .update(JSON.stringify([identity.source, identity.key]))
      .digest('hex') +
    '.json'
  );
}

export function sameInboxIdentity(
  a: DirectoryInboxIdentity | undefined,
  b: DirectoryInboxIdentity,
): boolean {
  return a?.source === b.source && a.key === b.key;
}

export function encodeInboxEntry<TEntry>(
  identity: DirectoryInboxIdentity,
  entry: TEntry,
  schema: z.ZodType<TEntry>,
  maxBytes: number,
): string {
  const envelope = { schemaVersion: 1, identity, entry: schema.parse(entry) };
  const snapshot: { value?: unknown } = {};
  if (
    !isJsonData(
      envelope,
      { maxDepth: 100, maxNodes: maxBytes, maxBytes, omitObjectUndefined: false },
      snapshot,
    )
  )
    throw new TypeError('Inbox entry must be lossless JSON within maxEntryBytes');
  const encoded = JSON.stringify(snapshot.value);
  if (encoded === undefined || new TextEncoder().encode(encoded).byteLength > maxBytes)
    throw new RangeError('Inbox entry exceeds maxEntryBytes');
  return encoded;
}

export async function createInboxFiles(directory: string, maxBytes: number) {
  const read = (name: string) =>
    readBoundedFile(join(directory, name), maxBytes, {
      rejectSymlinks: true,
      singleLink: true,
      stable: true,
    });
  const matches = async (key: string, observation?: FileObservation): Promise<boolean> => {
    if (!observation) return true;
    try {
      const current = await lstat(join(directory, key));
      return (
        current.isFile() &&
        current.nlink === 1 &&
        current.dev === observation.dev &&
        current.ino === observation.ino &&
        current.size === observation.size &&
        current.mtimeMs === observation.mtimeMs &&
        current.ctimeMs === observation.ctimeMs
      );
    } catch (error) {
      if (missingInboxFile(error)) return false;
      throw error;
    }
  };
  return {
    async names(limit?: number): Promise<string[]> {
      const names: string[] = [];
      for await (const entry of await opendir(directory)) {
        if (!entry.isFile() || !ENTRY_NAME.test(entry.name)) continue;
        names.push(entry.name);
        if (limit !== undefined && names.length >= limit) break;
      }
      return names.sort();
    },
    async read<TEntry>(key: string, schema: z.ZodType<TEntry>): Promise<InboxRead<TEntry>> {
      try {
        const source = await read(key);
        if (!source.observation)
          throw new Error('Inbox reader did not provide file observation');
        let json: unknown;
        try {
          json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(source.bytes));
        } catch (error) {
          return {
            reason: 'invalid',
            detail: String(error).slice(0, 1_000),
            observation: source.observation,
          };
        }
        let identity: DirectoryInboxIdentity | undefined;
        if (ACCEPTED_NAME.test(key)) {
          const envelope = EnvelopeSchema.safeParse(json);
          if (!envelope.success || inboxFilename(envelope.data.identity) !== key)
            return {
              reason: 'invalid',
              detail: 'Invalid programmatic inbox envelope',
              observation: source.observation,
            };
          identity = envelope.data.identity;
          json = envelope.data.entry;
        }
        const parsed = schema.safeParse(json);
        return parsed.success
          ? {
              entry: parsed.data,
              observation: source.observation,
              ...(identity && { identity }),
            }
          : {
              reason: 'invalid',
              detail: z.prettifyError(parsed.error).slice(0, 1_000),
              observation: source.observation,
              ...(identity && { identity }),
            };
      } catch (error) {
        if (missingInboxFile(error)) return null;
        if (
          error instanceof BoundedFileReadError &&
          error.code === 'FILE_TOO_LARGE' &&
          error.observation
        )
          return {
            reason: 'too-large',
            detail: error.message.slice(0, 1_000),
            observation: error.observation,
          };
        throw error;
      }
    },
    async existingIdentity(key: string): Promise<DirectoryInboxIdentity | undefined> {
      for (const name of [key, `rejected/${key}`]) {
        try {
          const source = await read(name);
          const envelope = EnvelopeSchema.parse(
            JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(source.bytes)),
          );
          return envelope.identity;
        } catch (error) {
          if (!missingInboxFile(error)) throw error;
        }
      }
      return undefined;
    },
    async publish(
      key: string,
      bytes: string,
      context: StateStoreUpdateContext,
    ): Promise<void> {
      await writeAtomicFileData(
        join(directory, key),
        bytes,
        { replace: false, durability: 'directory' },
        {
          open,
          unlink,
          async publish(staged, target, replace, directorySync) {
            await context.assertHeld();
            await publishAtomicFile(staged, target, replace, directorySync);
          },
        },
      );
    },
    async remove(
      key: string,
      context: StateStoreUpdateContext,
      observation?: FileObservation,
    ): Promise<void> {
      if (!(await matches(key, observation))) return;
      await context.assertHeld();
      try {
        await unlink(join(directory, key));
      } catch (error) {
        if (!missingInboxFile(error)) throw error;
      }
    },
    async setAside(
      key: string,
      context: StateStoreUpdateContext,
      observation?: FileObservation,
    ): Promise<void> {
      if (!(await matches(key, observation))) return;
      await mkdir(join(directory, 'rejected'), { recursive: true });
      await context.assertHeld();
      try {
        await publishAtomicFile(
          join(directory, key),
          join(directory, 'rejected', key),
          false,
          true,
        );
      } catch (error) {
        if (!missingInboxFile(error)) throw error;
      }
    },
  };
}

export type InboxFiles = Awaited<ReturnType<typeof createInboxFiles>>;
