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
