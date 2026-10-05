import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from '../packages/core/src/internal/atomic-file';
import { withExclusiveLock } from '../packages/core/src/internal/with-exclusive-lock';
import { git } from './local-git';

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

const GreenGateRecordSchema = z.object({
  tree: z.string(),
  toolchain: z.string(),
  at: z.string(),
  commit: z.string(),
});
const GateMemoSchema = z.looseObject({
  gates: z.record(z.string(), z.array(GreenGateRecordSchema).catch([])).default({}),
});

/** Every well-formed record for `gate`; a damaged or foreign file reads as empty. */
export function parseGateMemo(source: string, gate: string): GreenGateRecord[] {
  try {
    return GateMemoSchema.parse(JSON.parse(source)).gates[gate] ?? [];
  } catch {
    return [];
  }
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

async function updateGreenGate(
  gate: string,
  path: string,
  update: (history: GreenGateRecord[]) => GreenGateRecord[],
): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await withExclusiveLock(
    `${path}.lock`,
    async () => {
      let document: z.infer<typeof GateMemoSchema> = { gates: {} };
      try {
        document = GateMemoSchema.parse(JSON.parse(await readFile(path, 'utf8')));
      } catch (error) {
        // A missing or malformed cache is a miss; an IO refusal cannot discard history.
        const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT';
        if (!missing && !(error instanceof SyntaxError) && !(error instanceof z.ZodError))
          throw error;
      }
      const gates = { ...document.gates, [gate]: update(document.gates[gate] ?? []) };
      await writeFileAtomic(path, `${JSON.stringify({ ...document, gates }, null, 2)}\n`, {
        durability: 'none',
      });
    },
    // An empty owner record is unknown, even when old: a live creator can pause
    // before recording itself. Cache RMW must never overlap on an age-only guess.
    { label: 'green gate memo', ownerlessGraceMs: null },
  );
}

export function writeGreenGate(
  gate: string,
  record: GreenGateRecord,
  path: string,
): Promise<void> {
  return updateGreenGate(gate, path, (history) => rememberGreenGate(history, record));
}

/**
 * The content hash of the WORKING TREE — what the gate reads — through a
 * throwaway index.
 *
 * `git write-tree` needs an index, and the real one belongs to the owner: it is
 * the set of changes they reviewed and chose, and a tool has no business
 * writing to it, not even transiently. `GIT_INDEX_FILE` points the same
 * plumbing at a scratch file instead, so the answer is exactly as good and the
 * owner's staging area is read only for tracked names and is never written.
 * Tracked inputs count even when matched by ignore rules; untracked ignored
 * build output does not change what the gate checked.
 */
export async function worktreeTreeHash(root: string): Promise<string> {
  const scratch = join(
    Bun.env.TMPDIR ?? '/tmp',
    `stitchkit-gate-index-${process.pid}-${Bun.nanoseconds().toString(36)}`,
  );
  try {
    const env = { GIT_INDEX_FILE: scratch };
    const tracked = await git(root, ['ls-files', '--cached', '-z']);
    await git(root, ['add', '--all', '.'], { env });
    if (tracked)
      await git(root, ['update-index', '--add', '--remove', '-z', '--stdin'], {
        env,
        input: tracked,
      });
    return (await git(root, ['write-tree'], { env })).trim();
  } finally {
    await Bun.file(scratch)
      .delete()
      .catch(() => undefined);
  }
}

/** HEAD, for the human line a skip prints. A repository without one is not an error. */
export async function headCommit(root: string): Promise<string> {
  try {
    return (await git(root, ['rev-parse', '--short', 'HEAD'])).trim();
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
