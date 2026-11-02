/**
 * The shared contained-file capability and its platform descriptor adapters.
 * Darwin native calls return numeric descriptors; Linux also exposes descriptor paths.
 */
import { close as closeDescriptor, fstat, read as readDescriptor, type Stats } from 'node:fs';

export interface ContainedFileHandle {
  readonly fd: number;
  close(): Promise<void>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  stat(): Promise<Stats>;
}

export function descriptorPath(handle: ContainedFileHandle): string {
  if (process.platform === 'linux') return `/proc/self/fd/${handle.fd}`;
  throw new Error('Descriptor paths are available only in the Linux contained-files backend');
}

const FILE_TYPE_MASK = 0o170000;
export const FILE_TYPE_DIRECTORY = 0o040000;
export const FILE_TYPE_REGULAR = 0o100000;
export const FILE_TYPE_SYMLINK = 0o120000;

export function modeIs(mode: number, type: number): boolean {
  return (mode & FILE_TYPE_MASK) === type;
}

export class NumericFileHandle implements ContainedFileHandle {
  private closed = false;

  constructor(readonly fd: number) {}

  /** Once only: the number may already name another file, and a walk's cleanup can repeat this. */
  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    return new Promise((resolve, reject) => {
      closeDescriptor(this.fd, (error) => (error ? reject(error) : resolve()));
    });
  }

  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }> {
    return new Promise((resolve, reject) => {
      readDescriptor(this.fd, buffer, offset, length, position, (error, bytesRead) =>
        error ? reject(error) : resolve({ bytesRead }),
      );
    });
  }

  stat(): Promise<Stats> {
    return new Promise((resolve, reject) => {
      fstat(this.fd, (error, metadata) => (error ? reject(error) : resolve(metadata)));
    });
  }
}
