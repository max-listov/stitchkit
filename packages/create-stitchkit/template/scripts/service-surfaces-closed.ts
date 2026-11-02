/**
 * What a production deployment does not show, checked on a running one with
 * `SERVICE_SURFACES=closed` and on the files it was built from.
 */
import { join, resolve } from 'node:path';
import { assertNoFixtureInBuild } from './fixture-boundary';
import { loadToolingEnv } from './tooling-env';
import { assertServiceSurfacesClosed } from './web-surface-smoke';

const toolingEnv = loadToolingEnv();
await assertServiceSurfacesClosed(toolingEnv.SMOKE_WEB_ORIGIN, toolingEnv.SMOKE_API_ORIGIN);
await assertNoFixtureInBuild(join(resolve(import.meta.dir, '..'), 'packages/frontend'));
console.log('Service surfaces are closed, and the build carries no fixture');
