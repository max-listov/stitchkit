import { basename, join } from 'node:path';
import type { SystemdHostAdapter } from './systemd-inspect';
import { SystemdUnitError } from './systemd-render-shared';

/** Directories `enable` links a unit into, under each directory of `UnitPath`. */
const LINK_DIR_SUFFIXES = ['.wants', '.requires', '.upholds'];

/** The links on disk that make a unit enabled: link path → target. */
export type EnablementLinks = ReadonlyMap<string, string>;

const ALSO_LINE = /^[ \t]*Also[ \t]*=(.*)$/;

/**
 * The names whose links an `enable` of this unit can make: the unit, its file, and every
 * unit its `[Install]` sections name in `Also=` — in the candidate and in the bytes before.
 */
export function enablementNamesOf(
  unitName: string,
  unitPath: string,
  contents: readonly string[],
): ReadonlySet<string> {
  const names = new Set([unitName, basename(unitPath)]);
  for (const content of contents) {
    let install = false;
    for (const raw of content.split('\n')) {
      const line = raw.trim();
      if (line.startsWith('[')) install = line === '[Install]';
      const also = install ? ALSO_LINE.exec(line) : null;
      for (const name of also?.[1]?.split(/\s+/) ?? []) if (name.length > 0) names.add(name);
    }
  }
  return names;
}

/**
 * Every symbolic link in `dirs` that an `enable` of `names` makes: a `<target>.wants`,
 * `.requires` or `.upholds` entry or an alias, named for one of them or pointing at its file.
 * This is what `enable` writes and `UnitFileState` is read from.
 */
export async function readEnablementLinks(
  adapter: SystemdHostAdapter,
  dirs: readonly string[],
  names: ReadonlySet<string>,
): Promise<EnablementLinks> {
  const links = new Map<string, string>();
  const take = async (path: string, name: string) => {
    const standing = await adapter.inspectPath(path);
    if (standing.kind !== 'symlink') return;
    if (names.has(name) || names.has(basename(standing.target)))
      links.set(path, standing.target);
  };
  for (const dir of dirs) {
    for (const entry of (await adapter.listDir(dir)) ?? []) {
      const path = join(dir, entry);
      if (LINK_DIR_SUFFIXES.some((suffix) => entry.endsWith(suffix))) {
        for (const child of (await adapter.listDir(path)) ?? [])
          await take(join(path, child), child);
      } else {
        await take(path, entry);
      }
    }
  }
  return links;
}

/**
 * Make the unit's links what they were before an apply: remove each one `enable` added. A link
 * that went missing or now points elsewhere cannot be put back from here, and refuses the
 * rollback. Answers whether anything was removed, so the caller reloads the manager.
 */
export async function restoreEnablementLinks(
  adapter: SystemdHostAdapter,
  unitName: string,
  before: EnablementLinks,
  now: EnablementLinks,
): Promise<boolean> {
  const changed = [...before].filter(([path, target]) => now.get(path) !== target);
  if (changed.length > 0) {
    throw new SystemdUnitError(
      'COMMAND_FAILED',
      `cannot put back the enable links of ${unitName}: ${changed.map(([path, target]) => `${path} -> ${target}`).join(', ')} changed during the apply`,
    );
  }
  const added = [...now.keys()].filter((path) => !before.has(path));
  for (const path of added) await adapter.removeFile(path);
  return added.length > 0;
}

/** The links that differ between two readings, for a refusal that names them. */
export function differentLinks(a: EnablementLinks, b: EnablementLinks): string[] {
  const paths = new Set([...a.keys(), ...b.keys()]);
  return [...paths].filter((path) => a.get(path) !== b.get(path)).sort();
}
