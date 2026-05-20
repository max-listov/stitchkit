import { sep } from 'node:path';

/**
 * True when `target` (an already-`resolve`d absolute path) stays inside `root`.
 * Blocks `..`, absolute and otherwise-escaping paths — the shared containment
 * check behind `staticRoute` and `view_file`'s local-file branch.
 */
export function isWithinDir(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}
