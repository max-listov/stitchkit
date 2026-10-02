import { createHash } from 'node:crypto';
import { watch } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

async function inputPaths(root: string): Promise<string[]> {
  const child = Bun.spawn(
    ['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const names = (await new Response(child.stdout).text()).split('\0').filter(Boolean);
  const stderr = await new Response(child.stderr).text();
  if ((await child.exited) !== 0)
    throw new Error(`Cannot enumerate gate inputs: ${stderr.trim()}`);
  return names;
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
  const generations = await Promise.all(
    [...paths].sort().map(async (path) => {
      try {
        const info = await stat(join(root, path), { bigint: true });
        return `${path}\0${info.dev}:${info.ino}:${info.size}:${info.ctimeNs}:${info.mtimeNs}`;
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
          return `${path}\0absent`;
        throw error;
      }
    }),
  );
  return createHash('sha256').update(generations.join('\0')).digest('hex');
}

/** Watch input directories without traversing ignored build/dependency trees. */
export async function watchWorktreeInputs(root: string) {
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
      const watcher = watch(join(root, directory), (_event, filename) => {
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
