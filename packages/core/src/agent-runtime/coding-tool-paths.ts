import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { forbidden } from '../contract';
import {
  type AgentCodingToolAuthorization,
  AgentCodingToolAuthorizationSchema,
  type AgentCodingToolConfig,
  AgentCodingToolPathAuthorizationSchema,
} from './coding-tool-contract';
import { codingRefusal } from './coding-tool-refusals';

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function inputPath(root: string, requested: string, maxPathBytes: number): string {
  if (new TextEncoder().encode(requested).byteLength > maxPathBytes) {
    codingRefusal('BAD_REQUEST', `Path exceeds the ${maxPathBytes}-byte limit`, {
      details: { maxPathBytes },
      hint: 'Use a shorter workspace-relative path.',
    });
  }
  if (path.isAbsolute(requested)) {
    codingRefusal('BAD_REQUEST', 'Paths must be relative to the workspace root', {
      details: { path: requested },
      hint: 'Drop the leading slash and pass a path relative to the workspace root.',
    });
  }
  const resolved = path.resolve(root, requested);
  if (!within(root, resolved)) {
    codingRefusal('FORBIDDEN', 'Path escapes the workspace root', {
      details: { path: requested },
      hint: 'Stay inside the workspace; `..` segments that leave the root are refused.',
    });
  }
  return resolved;
}

export function boundedCodingRelativePath(requested: string, maxPathBytes: number): string {
  inputPath(path.parse(process.cwd()).root, requested, maxPathBytes);
  // A BACKSLASH IS A SEPARATOR TO THE WALK AND A LETTER TO THE POLICY.
  //
  // `contained-files` splits on `[\\/]`, so `a\\b` reaches `openat` as two
  // segments — while every authorization callback was handed the string whole
  // and read it as one name. Both policies were bypassable by changing one
  // character, including the REQUIRED `authorize({ operation, path })` that
  // every consumer has had since 0.70.0: a rule denying `credentials/token.txt`
  // refused that spelling and served — and overwrote — `credentials\\token.txt`.
  //
  // Refused rather than normalised, the way `isManagedFilePath` already refuses
  // it for managed files. Normalising would silently redefine a path that is a
  // legal filename on Linux; refusing costs nothing, because the walk has
  // treated `\\` as a separator all along and such a file was never reachable
  // through these tools anyway.
  if (requested.includes('\\')) {
    codingRefusal('FORBIDDEN', 'Path separators must be `/`', {
      details: { path: requested },
      hint: 'Use `/` between segments; a backslash is refused because the workspace walk reads it as a separator.',
    });
  }
  // Segment shape is checked HERE, in the tool layer, and not where the walk
  // happens: `contained-files` is the shared containment layer and stays
  // `AppError`-free, so a `..` reaching it came back to the model as an empty
  // internal error — a probe of a wrong path taught it nothing, and the refusal
  // it most needs to understand was the one refusal with no words.
  const segments = requested.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    codingRefusal('FORBIDDEN', 'Path segments must name real entries under the root', {
      details: { path: requested },
      hint: 'Pass a plain workspace-relative path — `.`, `..` and empty segments are refused.',
    });
  }
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

export async function isCodingPathAuthorized(
  config: AgentCodingToolConfig,
  path: string,
): Promise<boolean> {
  if (!config.authorizePath) return true;
  const parsed = AgentCodingToolPathAuthorizationSchema.parse({ path });
  return await config.authorizePath(parsed);
}

export async function authorizeCodingPath(
  config: AgentCodingToolConfig,
  path: string,
): Promise<void> {
  if (!(await isCodingPathAuthorized(config, path))) {
    // NAMED. Every refusal in the chain used to return the identical body, so
    // neither the model nor the host could tell whether an ancestor or the leaf
    // was refused — and "the broadest refusal is the one the caller is told
    // about" told the caller nothing that identified it.
    codingRefusal('FORBIDDEN', 'Coding tool path permission denied', {
      details: { path },
      hint: 'The host policy refused this path or a directory above it.',
    });
  }
}

/**
 * Ask the policy about the target AND every directory above it.
 *
 * A denied directory means two different things until this exists. The walk
 * refuses to descend into one, so denial is recursive during discovery; direct
 * access asked only about the leaf, so a host writing the obvious rule —
 * `path !== 'credentials'` — got a listing that hid the directory and a
 * `read_file` that served the secret inside it, plus a `write_file` that
 * created directories under it and an `edit_file` that rewrote it.
 *
 * Outermost first, so the broadest refusal is the one the caller is told about
 * and nothing below a denied directory is ever asked about. Segment-wise, not
 * `startsWith`: a rule denying `credentials` must not also deny
 * `credentials-backup`.
 *
 * The chain asks about the ANCESTORS OF THE PATH, and `.` is one only when the
 * path itself is `.`. Asking about `.` unconditionally looks symmetrical with
 * the walk — `search_files` and `list_directory('.')` do ask it — but there `.`
 * is the base path the caller named, not an ancestor of it. Asked on every
 * direct access it silently inverts every ALLOW-list: a host exposing one
 * subtree with `p => p.startsWith('src/')` answers `false` for `.` and loses
 * `src/index.ts` too, having denied nothing.
 *
 * The cost is stated rather than hidden: a path of depth N costs N questions,
 * and a policy that keeps an audit no longer sees the leaf once an ancestor has
 * refused.
 */
export async function authorizeCodingPathChain(
  config: AgentCodingToolConfig,
  relative: string,
): Promise<void> {
  if (!config.authorizePath) return;
  const segments = relative === '.' ? ['.'] : relative.split('/');
  for (let depth = 1; depth <= segments.length; depth += 1) {
    await authorizeCodingPath(config, segments.slice(0, depth).join('/'));
  }
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
