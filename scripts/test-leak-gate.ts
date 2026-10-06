/**
 * Run a command and fail it if anything it started is still alive once it has finished.
 *
 * A test that leaves a process behind is invisible to the test run itself: the suite is green, the
 * process lives on with `PPID=1` and keeps a CPU, a descriptor or a temporary directory, and they
 * accumulate on a developer machine and a CI runner. Whether a process "belongs to" a run is not
 * guessed from its command line, working directory, environment or session: a command started by
 * `runNativeCommand` leads a session and a group of its own and has an empty environment, and a
 * holder may call `setsid` itself. The gate makes itself the *subreaper* of the run
 * (`prctl(PR_SET_CHILD_SUBREAPER)`), so the kernel reparents every process whose parent died to
 * the gate instead of to init. When the command has exited, whatever is still alive and is a child
 * of the gate, other than the command itself, was left behind by it. The gate names those
 * processes, kills them, and fails.
 *
 * Usage: `bun scripts/test-leak-gate.ts <command> [args...]`. Linux only; elsewhere the command runs
 * unchecked and the line says the leak check could not be measured.
 */
import { dlopen, FFIType } from 'bun:ffi';
import { readdirSync, readFileSync } from 'node:fs';

const PR_SET_CHILD_SUBREAPER = 36;

export interface ProcessInfo {
  pid: number;
  args: string;
}

/** Fields of `/proc/<pid>/stat`; `comm` may contain spaces and parentheses, so split after the last one. */
export function parseProcessStat(text: string): { state: string; ppid: number } {
  const [state, ppid] = text.slice(text.lastIndexOf(')') + 2).split(' ');
  if (state === undefined || ppid === undefined)
    throw new Error(`Unreadable process stat: ${text.slice(0, 80)}`);
  return { state, ppid: Number(ppid) };
}

/** Whether this process now adopts every orphan of its descendants; false where the kernel cannot. */
export function becomeSubreaper(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    const { symbols } = dlopen('libc.so.6', {
      prctl: {
        args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64],
        returns: FFIType.i32,
      },
    });
    return symbols.prctl(PR_SET_CHILD_SUBREAPER, 1n, 0n, 0n, 0n) === 0;
  } catch {
    return false;
  }
}

/** Live (not zombie) children of `parent`. A process that vanishes while being read is gone. */
export function liveChildren(parent: number, proc = '/proc'): ProcessInfo[] {
  const children: ProcessInfo[] = [];
  for (const entry of readdirSync(proc)) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try {
      const stat = parseProcessStat(readFileSync(`${proc}/${entry}/stat`, 'utf8'));
      if (stat.ppid !== parent || stat.state === 'Z') continue;
      const args = readFileSync(`${proc}/${entry}/cmdline`, 'utf8')
        .replaceAll('\0', ' ')
        .trim();
      children.push({ pid, args });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
  return children;
}

/**
 * The window a process that a test just stopped gets to disappear. A leader killed with SIGKILL is
 * reaped at once, but its members need a moment to be signalled and reaped in turn.
 */
export const SETTLE_MS = 3000;

/** How many generations of one orphan's descendants the sweep follows. */
const MAX_TREE_DEPTH = 16;

export interface LeakCheckedRun {
  exitCode: number;
  /** Processes still running after the command exited and the settle window passed. */
  leaked: ProcessInfo[];
}

/** Runs `argv`, then reports and kills what it left behind. Requires `becomeSubreaper()` to have succeeded. */
export async function runWithLeakCheck(
  argv: readonly string[],
  options: { settleMs?: number; proc?: string } = {},
): Promise<LeakCheckedRun> {
  const { settleMs = SETTLE_MS, proc = '/proc' } = options;
  const child = Bun.spawn([...argv], { stdio: ['inherit', 'inherit', 'inherit'] });
  // A terminal delivers SIGINT to the command itself; the gate must outlive it to do its check.
  const forward = (name: NodeJS.Signals) => () => child.kill(name);
  const handlers = [
    { name: 'SIGINT', handler: () => undefined },
    { name: 'SIGTERM', handler: forward('SIGTERM') },
    { name: 'SIGHUP', handler: forward('SIGHUP') },
  ] as const;
  for (const { name, handler } of handlers) process.on(name, handler);
  const exitCode = await child.exited;
  for (const { name, handler } of handlers) process.off(name, handler);
  const others = () => liveChildren(process.pid, proc).filter(({ pid }) => pid !== child.pid);
  const deadline = performance.now() + settleMs;
  let pending = others();
  while (pending.length > 0 && performance.now() < deadline) {
    await Bun.sleep(50);
    pending = others();
  }
  // Killing an orphan reparents its own children to the gate, so one pass leaves a tree's lower
  // levels alive. The sweep repeats until nothing is adopted any more.
  const leaked = new Map<number, ProcessInfo>();
  for (let level = 0; pending.length > 0 && level < MAX_TREE_DEPTH; level += 1) {
    for (const member of pending) {
      leaked.set(member.pid, member);
      try {
        process.kill(member.pid, 'SIGKILL');
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH'))
          throw error;
      }
    }
    await Bun.sleep(50);
    pending = others();
  }
  return { exitCode, leaked: [...leaked.values()] };
}

if (import.meta.main) {
  // Bun consumes a leading `--`, so the command is everything after the script.
  const argv = process.argv.slice(2);
  if (argv.length === 0) throw new Error('Usage: test-leak-gate.ts <command> [args...]');
  if (!becomeSubreaper()) {
    process.stderr.write(
      `[test-gate] leak check not measurable on ${process.platform}: cannot become a subreaper; running the command unchecked\n`,
    );
    process.exit(await Bun.spawn(argv, { stdio: ['inherit', 'inherit', 'inherit'] }).exited);
  }
  const { exitCode, leaked } = await runWithLeakCheck(argv);
  if (leaked.length > 0) {
    process.stderr.write(
      `[test-gate] ${leaked.length} process(es) outlived \`${argv.join(' ')}\`; they were killed, and the run fails because a test left them behind:\n`,
    );
    for (const { pid, args } of leaked)
      process.stderr.write(`  pid ${pid}: ${args.slice(0, 200)}\n`);
  }
  process.exit(exitCode !== 0 ? exitCode : leaked.length > 0 ? 1 : 0);
}
