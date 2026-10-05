import { closeSync, fsyncSync, linkSync, openSync, renameSync, unlinkSync } from 'node:fs';
import { link, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { closeAfter, closeAfterSync } from './close-after';

/**
 * Thrown when the new file is already in place but a follow-up step (`phase`) failed; the
 * content is published, so do not treat this as a failed write.
 */
export class AtomicFilePublicationError extends Error {
  readonly published = true;
  constructor(
    public readonly phase: 'cleanup' | 'directory-sync' | 'directory-close',
    cause: unknown,
  ) {
    super(`File published but ${phase} failed`, { cause });
    this.name = 'AtomicFilePublicationError';
  }
}

/**
 * Native publication syscalls; injectable only at this internal IO boundary for fault
 * controls.
 */
export interface PublicationIO {
  rename(from: string, to: string): Promise<void>;
  link(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  open(path: string, flags: 'r'): Promise<{ sync(): Promise<void>; close(): Promise<void> }>;
}
const native: PublicationIO = { rename, link, unlink, open };

/**
 * The synchronous counterpart of {@link PublicationIO}, with the same fault-control role.
 */
export interface PublicationSyncIO {
  rename(from: string, to: string): void;
  link(from: string, to: string): void;
  unlink(path: string): void;
  open(path: string, flags: 'r'): { sync(): void; close(): void };
}
const nativeSync: PublicationSyncIO = {
  rename: renameSync,
  link: linkSync,
  unlink: unlinkSync,
  open(path, flags) {
    const descriptor = openSync(path, flags);
    return { sync: () => fsyncSync(descriptor), close: () => closeSync(descriptor) };
  },
};

/** Directory fsync needs a directory descriptor, which Windows does not provide. */
export function assertDirectoryDurability(): void {
  if (process.platform === 'win32')
    throw new Error('Directory durability is unsupported on Windows');
}

/** Make a rename, link or unlink inside `path` durable: the one directory fsync. */
export async function syncDirectory(path: string, io: PublicationIO = native): Promise<void> {
  assertDirectoryDurability();
  const directory = await io.open(path, 'r');
  await closeAfter(directory, () => directory.sync());
}

/**
 * How far an atomic write is made durable: `'none'` neither syncs the bytes nor the parent,
 * `'file'` syncs the staged bytes before publication, `'directory'` also syncs the parent after it.
 */
export type AtomicDurability = 'none' | 'file' | 'directory';

/**
 * How one staged file becomes the target: `replace` overwrites, otherwise an existing target
 * is refused.
 */
export interface AtomicPublishOptions {
  readonly replace: boolean;
  readonly durability: AtomicDurability;
}

export async function publishAtomicFile(
  staged: string,
  target: string,
  { replace, durability }: AtomicPublishOptions,
  io: PublicationIO = native,
): Promise<void> {
  const directorySync = durability === 'directory';
  if (directorySync) assertDirectoryDurability();
  // Admit the directory capability before changing the target. Filesystem-specific
  // fsync failures can still occur after publication and are reported as such.
  const directory = directorySync ? await io.open(dirname(target), 'r') : undefined;
  const publish = async (): Promise<void> => {
    if (replace) await io.rename(staged, target);
    else {
      await io.link(staged, target);
      try {
        await io.unlink(staged);
      } catch (error) {
        throw new AtomicFilePublicationError('cleanup', error);
      }
    }
    try {
      await directory?.sync();
    } catch (error) {
      throw new AtomicFilePublicationError('directory-sync', error);
    }
  };
  if (directory === undefined) return publish();
  await closeAfter(
    {
      close: async () => {
        try {
          await directory.close();
        } catch (error) {
          throw new AtomicFilePublicationError('directory-close', error);
        }
      },
    },
    publish,
  );
}

export function publishAtomicFileSync(
  staged: string,
  target: string,
  { replace, durability }: AtomicPublishOptions,
  io: PublicationSyncIO = nativeSync,
): void {
  const directorySync = durability === 'directory';
  if (directorySync) assertDirectoryDurability();
  const directory = directorySync ? io.open(dirname(target), 'r') : undefined;
  const publish = (): void => {
    if (replace) io.rename(staged, target);
    else {
      io.link(staged, target);
      try {
        io.unlink(staged);
      } catch (error) {
        throw new AtomicFilePublicationError('cleanup', error);
      }
    }
    try {
      directory?.sync();
    } catch (error) {
      throw new AtomicFilePublicationError('directory-sync', error);
    }
  };
  if (directory === undefined) {
    publish();
    return;
  }
  closeAfterSync(() => {
    try {
      directory.close();
    } catch (error) {
      throw new AtomicFilePublicationError('directory-close', error);
    }
  }, publish);
}
