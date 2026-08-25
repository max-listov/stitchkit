import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * One green run of one gate, remembered by what it actually checked.
 *
 * The gate is expensive and it is bound to an EVENT — a push — rather than to
 * its subject. That is how the same tree, byte for byte, paid the full price
 * twice within minutes of itself. A record keyed by tree content fixes the
 * binding without weakening anything: a different tree has a different key and
 * runs in full.
 */
export interface GreenGateRecord {
  /** Content hash of the working tree the run started from. */
  tree: string;
  /** Toolchain the run happened on — the same source on another Bun is another run. */
  toolchain: string;
  /** When it went green, for the line a skip prints. */
  at: string;
  /** HEAD at the time. Never part of the key: a commit is not what was checked. */
  commit: string;
}

/** How many green runs one gate remembers. */
export const GREEN_GATE_HISTORY = 8;

/**
 * The identity of a run: what was checked, and what checked it.
 *
 * Nothing else belongs here. Not the branch — the same tree on another branch
 * is the same tree. Not the commit — an amend that changes no file changes no
 * answer. Not the clock — a gate does not go stale on its own.
 */
export function greenGateKey(record: Pick<GreenGateRecord, 'tree' | 'toolchain'>): string {
  return `${record.tree} ${record.toolchain}`;
}

/** The newest-first history with `record` at its front and no duplicate key. */
export function rememberGreenGate(
  history: readonly GreenGateRecord[],
  record: GreenGateRecord,
  limit: number = GREEN_GATE_HISTORY,
): GreenGateRecord[] {
  const key = greenGateKey(record);
  const rest = history.filter((entry) => greenGateKey(entry) !== key);
  return [record, ...rest].slice(0, Math.max(1, limit));
}

/** The remembered green run for this exact tree and toolchain, if there is one. */
export function findGreenGate(
  history: readonly GreenGateRecord[],
  key: string,
): GreenGateRecord | undefined {
  return history.find((entry) => greenGateKey(entry) === key);
}

function isRecord(value: unknown): value is GreenGateRecord {
  if (typeof value !== 'object' || value === null) return false;
  for (const field of ['tree', 'toolchain', 'at', 'commit']) {
    if (typeof Reflect.get(value, field) !== 'string') return false;
  }
  return true;
}

/** Every well-formed record for `gate`; a damaged or foreign file reads as empty. */
export function parseGateMemo(source: string, gate: string): GreenGateRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  const gates = Reflect.get(parsed, 'gates');
  if (typeof gates !== 'object' || gates === null) return [];
  const history: unknown = Reflect.get(gates, gate);
  return Array.isArray(history) ? history.filter(isRecord) : [];
}

/**
 * Where the memo lives: the machine's cache, never the repository.
 *
 * Inside the tree it would be either a tracked file that changes the very hash
 * it records, or one more ignored path to ship by accident. Outside it is what
 * it is — a machine-local note about work that machine already did.
 */
export function gateMemoPath(
  environment: Record<string, string | undefined> = Bun.env,
  home: string = homedir(),
): string {
  const override = environment.STITCHKIT_GATE_MEMO_DIR?.trim();
  if (override) return join(override, 'green-gates.json');
  const cache = environment.XDG_CACHE_HOME?.trim();
  const base = cache && cache.length > 0 ? cache : join(home, '.cache');
  return join(base, 'stitchkit', 'green-gates.json');
}

export async function readGreenGates(gate: string, path: string): Promise<GreenGateRecord[]> {
  try {
    return parseGateMemo(await readFile(path, 'utf8'), gate);
  } catch {
    return [];
  }
}

export async function writeGreenGate(
  gate: string,
  record: GreenGateRecord,
  path: string,
): Promise<void> {
  let document: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null) document = { ...parsed };
  } catch {
    // No memo yet, or one this version cannot read. Either way it is rewritten.
  }
  const gates = Reflect.get(document, 'gates');
  const existing: Record<string, unknown> =
    typeof gates === 'object' && gates !== null ? { ...gates } : {};
  const previous: unknown = Reflect.get(existing, gate);
  const history = Array.isArray(previous) ? previous.filter(isRecord) : [];
  Reflect.set(existing, gate, rememberGreenGate(history, record));
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify({ ...document, gates: existing }, null, 2)}\n`);
}

async function git(
  root: string,
  args: string[],
  env?: Record<string, string>,
): Promise<string> {
  const child = Bun.spawn(['git', ...args], {
    cwd: root,
    env: env ? { ...Bun.env, ...env } : Bun.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const text = await new Response(child.stdout).text();
  const code = await child.exited;
  if (code !== 0) {
    const reason = await new Response(child.stderr).text();
    throw new Error(`git ${args[0] ?? ''} exited with ${code}: ${reason.trim()}`);
  }
  return text.trim();
}

/**
 * The content hash of the WORKING TREE — what the gate reads — through a
 * throwaway index.
 *
 * `git write-tree` needs an index, and the real one belongs to the owner: it is
 * the set of changes they reviewed and chose, and a tool has no business
 * writing to it, not even transiently. `GIT_INDEX_FILE` points the same
 * plumbing at a scratch file instead, so the answer is exactly as good and the
 * owner's staging area is never opened. Ignored paths are excluded by `git add`
 * itself, which is the right rule: a build output does not change what the gate
 * checked.
 */
export async function worktreeTreeHash(root: string): Promise<string> {
  const scratch = join(
    Bun.env.TMPDIR ?? '/tmp',
    `stitchkit-gate-index-${process.pid}-${Bun.nanoseconds().toString(36)}`,
  );
  try {
    await git(root, ['add', '--all', '.'], { GIT_INDEX_FILE: scratch });
    return await git(root, ['write-tree'], { GIT_INDEX_FILE: scratch });
  } finally {
    await Bun.file(scratch)
      .delete()
      .catch(() => undefined);
  }
}

/** HEAD, for the human line a skip prints. A repository without one is not an error. */
export async function headCommit(root: string): Promise<string> {
  try {
    return await git(root, ['rev-parse', '--short', 'HEAD']);
  } catch {
    return '(no commit)';
  }
}

/**
 * What ran the gate. The same source on a different Bun is a different answer —
 * the runtime is under test as much as the code is.
 */
export async function toolchainFingerprint(): Promise<string> {
  let node = 'node:absent';
  try {
    const child = Bun.spawn(['node', '--version'], { stdout: 'pipe', stderr: 'ignore' });
    const text = (await new Response(child.stdout).text()).trim();
    if ((await child.exited) === 0 && text) node = `node:${text}`;
  } catch {
    // A machine without Node still gates; `smoke:node` is what would fail there.
  }
  return `bun:${Bun.version} ${node} ${process.platform}/${process.arch}`;
}

/**
 * What the LANES talk to — the half a tree hash and a runtime version cannot see.
 *
 * `lint`, `check` and `test` read only the tree, so for the fast profile the
 * toolchain is the whole story. The heavy steps do not: the agent-store lane and
 * both starter lanes talk to a PostgreSQL server, and the starter lanes drive
 * real browsers. Upgrade either and the tree is unchanged, the toolchain is
 * unchanged, the key is unchanged — and the memo would answer for a run that
 * happened under different conditions.
 *
 * Deliberately cheap and deliberately fail-safe. Anything that cannot be
 * measured becomes a marker of its own, so an unreachable database produces a
 * DIFFERENT key rather than the same one: the failure mode is a redundant full
 * run, never a skip that should not have happened.
 *
 * The supervisor needs no entry here: it is a pinned devDependency, so it lives
 * in the lockfile, and the lockfile is part of the tree.
 */
export async function laneEnvironmentFingerprint(
  environment: Record<string, string | undefined> = Bun.env,
): Promise<string> {
  return `${await postgresFingerprint(environment)} ${await browserFingerprint(environment)}`;
}

/**
 * Asked the same two ways the lanes ask.
 *
 * `starter-database.ts` uses `STARTER_TEST_DATABASE_ADMIN_URL` when it is set
 * and falls back to a local `sudo -u postgres` socket otherwise. Fingerprinting
 * only the first would have read `pg:unset` for ever on a machine that uses the
 * second — a constant, which is the same as not measuring at all.
 */
async function postgresFingerprint(
  environment: Record<string, string | undefined>,
): Promise<string> {
  const url = environment.STARTER_TEST_DATABASE_ADMIN_URL?.trim();
  const command = url
    ? ['psql', url, '-tAc', 'select version()']
    : ['sudo', '-n', '-u', 'postgres', 'psql', '-tAc', 'select version()'];
  try {
    const child = Bun.spawn(command, { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' });
    const text = (await new Response(child.stdout).text()).trim();
    if ((await child.exited) !== 0 || !text) return 'pg:unreachable';
    // The server version only — the rest of the banner carries a build string
    // that moves without the behaviour moving.
    return `pg:${/PostgreSQL (\S+)/.exec(text)?.[1] ?? 'unknown'}`;
  } catch {
    return 'pg:unmeasurable';
  }
}

async function browserFingerprint(
  environment: Record<string, string | undefined>,
): Promise<string> {
  const root =
    environment.PLAYWRIGHT_BROWSERS_PATH?.trim() || join(homedir(), '.cache', 'ms-playwright');
  try {
    const { readdir } = await import('node:fs/promises');
    const entries = (await readdir(root)).filter((name) => !name.startsWith('.')).sort();
    return entries.length === 0 ? 'browsers:none' : `browsers:${entries.join(',')}`;
  } catch {
    return 'browsers:absent';
  }
}
