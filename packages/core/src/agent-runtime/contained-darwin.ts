/**
 * The Darwin half of contained file access: the optional native binding for
 * `openat`-style calls, and a file handle over its numeric descriptor. Loaded
 * lazily and only on darwin, where Node offers no directory-relative open.
 */
import { close as closeDescriptor, fstat, read as readDescriptor, type Stats } from 'node:fs';

import type { ContainedFileHandle } from './contained-files';

const FILE_TYPE_MASK = 0o170000;
export const FILE_TYPE_DIRECTORY = 0o040000;
export const FILE_TYPE_REGULAR = 0o100000;
export const FILE_TYPE_SYMLINK = 0o120000;

export function modeIs(mode: number, type: number): boolean {
  return (mode & FILE_TYPE_MASK) === type;
}

export class NumericFileHandle implements ContainedFileHandle {
  constructor(readonly fd: number) {}

  close(): Promise<void> {
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
