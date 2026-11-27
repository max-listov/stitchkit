import { readFileSync, rmSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reapTrackedProcesses, trackPidFile, trackProcess } from './process-reaper';
import { observe } from './until';

const WORK_ENTRY = join(import.meta.dir, '../../src/entrypoints/service-host/work.ts');

/**
 * A command that builds a small process tree and publishes it: the root, a child, a grandchild
 * and a descendant that left the root's session and process group. Each writes its pid to a file
 * the reaper already tracks; the root also records the argument it was given, the origin
 * variable it holds and what `inheritedWork()` answers from inside.
 */
const TREE_SCRIPT = `
dir="$1"
printf '%s' "$2" > "$dir/arg"
printf '%s' "$STITCHKIT_WORK_ORIGIN" > "$dir/origin"
sleep 300 &
echo $! > "$dir/child.pid"
sh -c 'sleep 300 & echo $! > "$0/grandchild.pid"; wait' "$dir" &
setsid sh -c 'echo $$ > "$0/detached.pid"; exec sleep 300' "$dir" &
"$3" "$dir/inherited.ts" > "$dir/inherited.json"
echo $$ > "$dir/root.pid"
wait
`;

/** Prints what `inheritedWork()` answers for the process that runs it. */
const INHERITED_SCRIPT = `
import { inheritedWork } from ${JSON.stringify(WORK_ENTRY)};
console.log(JSON.stringify(await inheritedWork()));
`;

const directories = new Set<string>();

/** A scratch directory for pid files, removed by {@link removeWorkDirectories}. */
export async function createWorkDirectory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'stitchkit-work-'));
  directories.add(dir);
  return dir;
}

/**
 * Pass to `afterEach`: reaps first, because the reaper reads pid files from these directories,
 * and only then removes them — a test that failed early still has its processes found.
 */
export function removeWorkDirectories(): void {
  reapTrackedProcesses();
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
  directories.clear();
}

export const TREE_MEMBERS = ['root', 'child', 'grandchild', 'detached'] as const;

export interface WorkPayload {
  readonly dir: string;
  /** The script that prints `inheritedWork()`, for a run outside the boundary. */
  readonly inheritedScript: string;
  readonly command: {
    executable: string;
    args: string[];
    env: Record<string, string>;
    timeoutMs: number;
  };
  /** The pid a tree member published, once it has. */
  pid(member: (typeof TREE_MEMBERS)[number]): Promise<number>;
  /** The text of a file the root wrote. */
  text(name: 'arg' | 'origin' | 'inherited.json'): Promise<string>;
}

/** Prepares the tree command in a fresh directory, every pid file registered with the reaper. */
export async function createWorkPayload(argument = 'plain'): Promise<WorkPayload> {
  const dir = await createWorkDirectory();
  const inheritedScript = join(dir, 'inherited.ts');
  await writeFile(inheritedScript, INHERITED_SCRIPT);
  for (const member of TREE_MEMBERS) trackPidFile(join(dir, `${member}.pid`));
  const read = (name: string) =>
    observe(
      () => {
        try {
          const text = readFileSync(join(dir, name), 'utf8');
          return text.length > 0 ? text : undefined;
        } catch {
          return undefined;
        }
      },
      `${name} of the work payload`,
      20_000,
    );
  return {
    dir,
    inheritedScript,
    command: {
      executable: '/bin/sh',
      args: ['-c', TREE_SCRIPT, 'sh', dir, argument, process.execPath],
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' },
      timeoutMs: 60_000,
    },
    async pid(member) {
      const pid = Number((await read(`${member}.pid`)).trim());
      if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Unreadable ${member}.pid`);
      // The test may remove the directory before the reaper reads the file.
      trackProcess(pid);
      return pid;
    },
    text: read,
  };
}
