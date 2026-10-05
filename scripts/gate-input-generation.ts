import { createHash } from 'node:crypto';
import { type FSWatcher, watch } from 'node:fs';
import { lstat, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { git } from './local-git';

async function inputPaths(root: string): Promise<string[]> {
  const listing = await git(root, [
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
    '-z',
  ]);
  return listing.split('\0').filter(Boolean);
}

function inputDirectories(names: string[]): Set<string> {
  const directories = new Set(['.']);
  for (const name of names) {
    for (let parent = dirname(name); parent !== '.'; parent = dirname(parent))
      directories.add(parent);
  }
  return directories;
}

/** Content restoration cannot restore inode change time. Ignored output churn is not an input. */
export async function worktreeInputGeneration(root: string): Promise<string> {
  const names = await inputPaths(root);
  const paths = new Set(names);
  let symlinkInputs = false;
  const generations = await Promise.all(
    [...paths].sort().map(async (path) => {
      try {
        const link = await lstat(join(root, path), { bigint: true });
        if (link.isSymbolicLink()) symlinkInputs = true;
        const info = link.isSymbolicLink()
          ? await stat(join(root, path), { bigint: true })
          : link;
        return `${path}\0${link.dev}:${link.ino}:${link.size}:${link.ctimeNs}:${link.mtimeNs}\0${info.dev}:${info.ino}:${info.size}:${info.ctimeNs}:${info.mtimeNs}`;
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
          return `${path}\0absent`;
        throw error;
      }
    }),
  );
  const fingerprint = createHash('sha256').update(generations.join('\0')).digest('hex');
  // Git hashes link text, not the target read by tools. No prior memo attests that target.
  return symlinkInputs ? `unattested-symlinks:${fingerprint}` : fingerprint;
}

/** Watch input directories without traversing ignored build/dependency trees. */
export async function watchWorktreeInputs(
  root: string,
  createWatcher: (
    path: string,
    listener: (event: string, filename: string | Buffer | null) => void,
  ) => FSWatcher = watch,
) {
  const names = await inputPaths(root);
  const known = new Set(names);
  const ignored = new Map<string, Promise<boolean>>();
  const pending = new Set<Promise<void>>();
  let changed = false;
  let closed = false;
  const watchers: ReturnType<typeof watch>[] = [];
  const observe = (path: string) => {
    if (path === '.git' || path.startsWith('.git/')) return;
    if (known.has(path)) {
      changed = true;
      return;
    }
    let check = ignored.get(path);
    if (!check) {
      check = (async () => {
        const child = Bun.spawn(['git', 'check-ignore', '--no-index', '-q', '--', path], {
          cwd: root,
          stdout: 'ignore',
          stderr: 'ignore',
        });
        const code = await child.exited;
        return code === 0;
      })().catch(() => false);
      ignored.set(path, check);
    }
    const observation = check.then((isIgnored) => {
      if (!isIgnored) changed = true;
    });
    pending.add(observation);
    void observation.finally(() => pending.delete(observation));
  };
  try {
    for (const directory of inputDirectories(names)) {
      try {
        await stat(join(root, directory));
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
        throw error;
      }
      const watcher = createWatcher(join(root, directory), (_event, filename) => {
        if (filename === null) {
          changed = true;
          return;
        }
        observe(directory === '.' ? String(filename) : join(directory, String(filename)));
      });
      watcher.on('error', () => {
        changed = true;
      });
      watchers.push(watcher);
    }
  } catch (error) {
    for (const watcher of watchers) watcher.close();
    throw error;
  }
  return {
    async finish(): Promise<boolean> {
      if (!closed) {
        closed = true;
        for (const watcher of watchers) watcher.close();
      }
      await Promise.all(pending);
      return changed;
    },
  };
}
