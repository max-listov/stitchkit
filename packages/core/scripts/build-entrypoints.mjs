/**
 * Build every published entrypoint, in one pass.
 *
 * There used to be two `bun build` runs — a browser lane and a server lane —
 * with byte-identical flags and different entry lists. The split bought nothing
 * (neither run configured anything differently) and cost two things: the entry
 * lists became a second place to declare what is browser-safe, and two
 * `--splitting` runs into one `--outdir` produce two chunk graphs, so `dist`
 * shipped the contract layer twice.
 *
 * One run, one chunk graph. Which entries a browser may import is metadata now,
 * declared in `entrypoints.mjs` and read by the gates — not implied by which of
 * two command lines a file was listed on.
 */
import { spawnSync } from 'node:child_process';
import { SOURCES } from '../entrypoints.mjs';

// Passthrough goes BEFORE the pinned flags, so a later duplicate cannot win.
// Appended after them, `-- --target browser` silently overrode `--target node`
// and the build produced something no gate describes.
const passthrough = process.argv.slice(2);
const args = [
  'build',
  ...SOURCES,
  ...passthrough,
  '--outdir',
  'dist',
  '--target',
  'node',
  '--packages',
  'external',
  '--splitting',
  '--root',
  'src',
];

const built = spawnSync('bun', args, { stdio: 'inherit' });
process.exit(built.status ?? 1);
