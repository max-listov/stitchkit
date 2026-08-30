import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { forbidden } from '../contract';
import {
  type AgentCodingToolAuthorization,
  AgentCodingToolAuthorizationSchema,
  type AgentCodingToolConfig,
} from './coding-tool-contract';

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function inputPath(root: string, requested: string, maxPathBytes: number): string {
  if (new TextEncoder().encode(requested).byteLength > maxPathBytes) {
    throw new Error('Coding tool path exceeds maxPathBytes');
  }
  if (path.isAbsolute(requested)) throw new Error('Coding tool paths must be relative');
  const resolved = path.resolve(root, requested);
  if (!within(root, resolved)) throw new Error('Coding tool path escapes its root');
  return resolved;
}

export function boundedCodingRelativePath(requested: string, maxPathBytes: number): string {
  inputPath(path.parse(process.cwd()).root, requested, maxPathBytes);
  return requested;
}

export async function existingCodingPath(
  root: string,
  requested: string,
  maxPathBytes: number,
) {
  const resolved = await realpath(inputPath(root, requested, maxPathBytes));
  if (!within(root, resolved)) throw new Error('Coding tool path resolves outside its root');
  return { absolute: resolved, relative: path.relative(root, resolved) || '.' };
}

export async function writableCodingPath(
  root: string,
  requested: string,
  maxPathBytes: number,
) {
  const candidate = inputPath(root, requested, maxPathBytes);
  const parent = await realpath(path.dirname(candidate));
  if (!within(root, parent)) throw new Error('Coding tool parent resolves outside its root');
  const target = path.join(parent, path.basename(candidate));
  const metadata = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (metadata?.isSymbolicLink())
    throw new Error('Coding tools do not write through symlinks');
  return { absolute: target, relative: path.relative(root, target) || '.' };
}

export async function editableCodingPath(
  root: string,
  requested: string,
  maxPathBytes: number,
) {
  const candidate = inputPath(root, requested, maxPathBytes);
  const metadata = await lstat(candidate);
  if (metadata.isSymbolicLink()) throw new Error('Coding tools do not edit symlinks');
  const resolved = await realpath(candidate);
  if (!within(root, resolved)) throw new Error('Coding tool path resolves outside its root');
  return { absolute: resolved, relative: path.relative(root, resolved) || '.' };
}

export async function authorizeCodingTool(
  config: AgentCodingToolConfig,
  request: AgentCodingToolAuthorization,
): Promise<void> {
  const parsed = AgentCodingToolAuthorizationSchema.parse(request);
  if (!(await config.authorize(parsed))) forbidden('Coding tool permission denied');
}

const codingPathLocks = new Map<string, Promise<void>>();

/** Serialize framework-owned compare-and-replace transactions for one canonical target. */
export async function withCodingPathLock<T>(
  target: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = codingPathLocks.get(target) ?? Promise.resolve();
  let release = (): void => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  codingPathLocks.set(target, queued);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (codingPathLocks.get(target) === queued) codingPathLocks.delete(target);
  }
}

export function textOccurrences(source: string, search: string): number {
  let count = 0;
  let offset = 0;
  while (offset <= source.length - search.length) {
    const found = source.indexOf(search, offset);
    if (found < 0) break;
    count += 1;
    offset = found + search.length;
  }
  return count;
}
