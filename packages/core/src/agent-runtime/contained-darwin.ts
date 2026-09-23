/**
 * The Darwin half of contained file access: the optional native binding for
 * `openat`-style calls, and a file handle over its numeric descriptor. Loaded
 * lazily and only on darwin, where Node offers no directory-relative open.
 */
import {
  close as closeDescriptor,
  existsSync,
  fstat,
  read as readDescriptor,
  type Stats,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ContainedFileHandle } from './contained-files';

export interface DarwinEntry {
  name: string;
  mode: number;
  size: number;
}

export interface DarwinBinding {
  openDirectoryAt(directory: number, name: string): number;
  openFileAt(directory: number, name: string): number;
  createFileAt(directory: number, name: string, mode: number): number;
  createDirectoryAt(directory: number, name: string, mode: number): boolean;
  statAt(directory: number, name: string): Omit<DarwinEntry, 'name'> | null;
  listAt(directory: number): readonly DarwinEntry[];
  renameAt(directory: number, source: string, target: string): void;
  unlinkAt(directory: number, name: string): void;
}

const FILE_TYPE_MASK = 0o170000;
export const FILE_TYPE_DIRECTORY = 0o040000;
export const FILE_TYPE_REGULAR = 0o100000;
export const FILE_TYPE_SYMLINK = 0o120000;

export function modeIs(mode: number, type: number): boolean {
  return (mode & FILE_TYPE_MASK) === type;
}

export function hasFunctions(value: unknown, names: readonly string[]): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    names.every((name) => typeof Reflect.get(value, name) === 'function')
  );
}

let darwinBinding: DarwinBinding | undefined;

export function loadDarwinBinding(): DarwinBinding {
  if (darwinBinding) return darwinBinding;
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const binary = `darwin-${process.arch}.node`;
  const candidates = [
    path.resolve(directory, '../native', binary),
    path.resolve(directory, '../../native', binary),
  ];
  const selected = candidates.find((candidate) => existsSync(candidate));
  if (!selected) {
    throw new Error(
      `Contained filesystem operations need the packaged Darwin ${process.arch} backend`,
    );
  }
  const loaded: unknown = createRequire(import.meta.url)(selected);
  const methods = [
    'openDirectoryAt',
    'openFileAt',
    'createFileAt',
    'createDirectoryAt',
    'statAt',
    'listAt',
    'renameAt',
    'unlinkAt',
  ];
  if (!hasFunctions(loaded, methods)) {
    throw new Error('The packaged Darwin contained-files backend has an invalid surface');
  }
  // Native Node-API is an untyped external boundary; every callable was checked above.
  darwinBinding = loaded as DarwinBinding;
  return darwinBinding;
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
