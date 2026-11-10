/**
 * Put the fixture support modules beside a materialized fixture's sources.
 *
 * Every path that copies a consumer-lane fixture out of the repository — the
 * lane, a packed proof, the universal native build, the installed-npm proofs —
 * calls this one function, because a fixture imports its support as a sibling
 * (`./listen-fetchable.mjs`) and is installed alone, away from this directory.
 */
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';

const here = import.meta.dirname;

/** The support modules a fixture may import as `./<name>`. */
export const FIXTURE_SUPPORT_FILES = ['listen-fetchable.mjs'];

/** Copy every support module into `directory`, the one holding the fixture's entry files. */
export function placeFixtureSupport(directory) {
  for (const file of FIXTURE_SUPPORT_FILES)
    copyFileSync(join(here, file), join(directory, file));
}
