import { createHash } from 'node:crypto';
import { lstat, mkdir, open, opendir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { writeAtomicFileData } from '../internal/atomic-file';
import { publishAtomicFile } from '../internal/atomic-publication';
import {
  BoundedFileReadError,
  openRegularFile,
  readBoundedFile,
} from '../internal/bounded-file-read';
import { closeAfter } from '../internal/close-after';
import type { FileObservation } from '../internal/file-observation';
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

/**
 * A failure of one entry's own file. The pass reports it and moves on to the
 * next entry; any other failure belongs to the state store or the directory and
 * ends the pass.
 */
export class InboxEntryError extends Error {
  constructor(
    readonly key: string,
    cause: unknown,
  ) {
    super(`Inbox entry ${key} failed`, { cause });
    this.name = 'InboxEntryError';
  }
}

const entryFile = async <T>(key: string, run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    throw new InboxEntryError(key, error);
  }
};

const existsAlready = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'EEXIST';

const ignoreMissing = (error: unknown): undefined => {
  if (!missingInboxFile(error)) throw error;
};

/** Move `source` to `destination` without replacing anything there: `taken` when the name is occupied, `gone` when the source vanished. */
async function moveAside(
  source: string,
  destination: string,
): Promise<'moved' | 'taken' | 'gone'> {
  try {
    await publishAtomicFile(source, destination, { replace: false, durability: 'directory' });
    return 'moved';
  } catch (error) {
    if (missingInboxFile(error)) return 'gone';
    if (existsAlready(error)) return 'taken';
    throw error;
  }
}

/** SHA-256 of a regular file read through its descriptor in fixed chunks, whatever its size. */
async function digestFile(path: string): Promise<string> {
  const { handle } = await openRegularFile(path, { rejectSymlinks: true });
  return closeAfter(handle, async () => {
    const hash = createHash('sha256');
    const chunk = new Uint8Array(64 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength);
      if (bytesRead === 0) return hash.digest('hex');
      hash.update(chunk.subarray(0, bytesRead));
    }
  });
}

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

/**
 * The envelope of a programmatic entry. The schema validates the entry, and
 * what is stored is the entry itself — the schema's input — because delivery
 * parses the stored file with the schema again and a transforming schema would
 * not accept its own output.
 */
export function encodeInboxEntry<TEntry, TInput>(
  identity: DirectoryInboxIdentity,
  entry: TInput,
  schema: z.ZodType<TEntry, TInput>,
  maxBytes: number,
): string {
  schema.parse(entry);
  const envelope = { schemaVersion: 1, identity, entry };
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
        current.nlink === observation.nlink &&
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
        if (error instanceof BoundedFileReadError && error.observation) {
          if (error.code === 'FILE_TOO_LARGE')
            return {
              reason: 'too-large',
              detail: error.message.slice(0, 1_000),
              observation: error.observation,
            };
          // A hard-linked entry can still be rewritten through its other name, so it is never trusted.
          if (error.code === 'FILE_UNSAFE_LINK')
            return {
              reason: 'invalid',
              detail: error.message.slice(0, 1_000),
              observation: error.observation,
            };
        }
        throw new InboxEntryError(key, error);
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
          async publish(staged, target, publication) {
            await context.assertHeld();
            await publishAtomicFile(staged, target, publication);
          },
        },
      );
    },
    async remove(
      key: string,
      context: StateStoreUpdateContext,
      observation?: FileObservation,
    ): Promise<void> {
      if (!(await entryFile(key, () => matches(key, observation)))) return;
      await context.assertHeld();
      await entryFile(key, () => unlink(join(directory, key)).catch(ignoreMissing));
    },
    async setAside(
      key: string,
      context: StateStoreUpdateContext,
      observation?: FileObservation,
    ): Promise<void> {
      if (!(await entryFile(key, () => matches(key, observation)))) return;
      const aside = join(directory, 'rejected');
      await entryFile(key, () => mkdir(aside, { recursive: true }));
      await context.assertHeld();
      const source = join(directory, key);
      if ((await entryFile(key, () => moveAside(source, join(aside, key)))) !== 'taken')
        return;
      // The name is taken in rejected/. Identical bytes are the entry already set
      // aside, so the source is only removed. Different bytes (the producer reused
      // the name) keep both files, the new one under a name derived from its
      // content, so the same file set aside twice lands on the same name.
      const settled = await entryFile(key, async () => {
        const digest = await digestFile(source).catch(ignoreMissing);
        if (digest === undefined) return false;
        if ((await digestFile(join(aside, key)).catch(() => undefined)) === digest)
          return true;
        const named = join(aside, `${key}.${digest.slice(0, 16)}`);
        return (await moveAside(source, named)) === 'taken';
      });
      if (!settled) return;
      await context.assertHeld();
      await entryFile(key, () => unlink(source).catch(ignoreMissing));
    },
  };
}

export type InboxFiles = Awaited<ReturnType<typeof createInboxFiles>>;
