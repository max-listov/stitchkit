import { realpath } from 'node:fs/promises';
import { sep } from 'node:path';

/**
 * True when `target` (an already-`resolve`d absolute path) stays inside `root`.
 * Blocks `..`, absolute and otherwise-escaping paths — the shared containment
 * check behind `staticRoute` and `view_file`'s local-file branch.
 */
export function isWithinDir(root: string, target: string): boolean {
  // A trailing separator on `root` makes `root + sep` end in a doubled
  // separator (`'/'` → `'//'`), which no real path starts with — silently
  // turning the check into allow-nothing. Normalise it off so containment is
  // enforced by intent, not a string-concat coincidence: with `root` normalised
  // to `'/'` (base `''`), every absolute path is correctly within it.
  const base = root.endsWith(sep) ? root.slice(0, -sep.length) : root;
  return target === root || target === base || target.startsWith(base + sep);
}

/**
 * Resolve both paths through the filesystem and return the real target only
 * when it remains inside the real root. The lexical check must run first at a
 * URL boundary; this second check closes symlink escapes.
 */
export async function realPathWithinDir(root: string, target: string): Promise<string | null> {
  const [realRoot, realTarget] = await Promise.all([
    realpath(root).catch(() => null),
    realpath(target).catch(() => null),
  ]);
  if (realRoot === null || realTarget === null) return null;
  return isWithinDir(realRoot, realTarget) ? realTarget : null;
}
