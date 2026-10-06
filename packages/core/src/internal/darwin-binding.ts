/** One lazy Node-API boundary for the packaged Darwin operating-system primitives. */
import loadDarwinAddon from '#stitchkit-darwin-native';
import { DarwinBackendError, darwinLoadStage } from './darwin-binding-error';

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
  if (process.arch !== 'arm64' && process.arch !== 'x64') {
    throw new DarwinBackendError('architecture');
  }
  let loaded: unknown;
  try {
    loaded = loadDarwinAddon();
  } catch (cause) {
    throw new DarwinBackendError(darwinLoadStage(cause), cause);
  }
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
    throw new DarwinBackendError('surface');
  }
  // Native Node-API is an untyped external boundary; every callable was checked above.
  darwinBinding = loaded as DarwinBinding;
  return darwinBinding;
}
