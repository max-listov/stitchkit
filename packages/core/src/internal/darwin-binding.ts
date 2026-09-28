/** One lazy Node-API boundary for the packaged Darwin operating-system primitives. */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface DarwinEntry {
  name: string;
  mode: number;
  size: number;
}

export interface DarwinBinding {
  processIdentity(pid: number): unknown;
  openDirectoryAt(directory: number, name: string): number;
  openFileAt(directory: number, name: string): number;
  createFileAt(directory: number, name: string, mode: number): number;
  createDirectoryAt(directory: number, name: string, mode: number): boolean;
  statAt(directory: number, name: string): Omit<DarwinEntry, 'name'> | null;
  listAt(directory: number): readonly DarwinEntry[];
  renameAt(directory: number, source: string, target: string): void;
  unlinkAt(directory: number, name: string): void;
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
    'processIdentity',
  ];
  if (!hasFunctions(loaded, methods)) {
    throw new Error('The packaged Darwin contained-files backend has an invalid surface');
  }
  // Native Node-API is an untyped external boundary; every callable was checked above.
  darwinBinding = loaded as DarwinBinding;
  return darwinBinding;
}
