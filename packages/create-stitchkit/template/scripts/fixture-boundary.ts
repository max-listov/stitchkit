import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Glob } from 'bun';

/** The prefix of every row id in `features/admin/fixture`: data, so a bundler cannot drop it. */
const FIXTURE_MARKER = 'stitchkit-admin-fixture';

/**
 * The fixture has to be absent from what a deployment serves, and only the built
 * files can say so: a guard in the source proves intent, and a bundler that keeps
 * the branch would still ship the rows. A build with no files is a wrong build,
 * not a clean one.
 */
export async function assertNoFixtureInBuild(webRoot: string): Promise<void> {
  const root = join(webRoot, '.next');
  if (!existsSync(root)) throw new Error(`${root} holds no built files to inspect`);
  let inspected = 0;
  for await (const path of new Glob('{server,static}/**/*.{js,map,json,html,rsc}').scan(root)) {
    inspected += 1;
    if ((await Bun.file(join(root, path)).text()).includes(FIXTURE_MARKER)) {
      throw new Error(`.next/${path} carries the admin fixture`);
    }
  }
  if (inspected === 0) throw new Error(`${root} holds no built files to inspect`);
}
