import { systemContract } from '@app/shared';
import { createClient, createHttpClient } from 'stitchkit';
import { z } from 'zod';
import { runSurfaceConformance } from './surface-conformance';
import { loadToolingEnv } from './tooling-env';
import { assertArtifactIsPlacementFree, assertPublicWebSurface } from './web-surface-smoke';

const toolingEnv = loadToolingEnv();
const apiOrigin = toolingEnv.SMOKE_API_ORIGIN;

async function json(path: string): Promise<unknown> {
  const response = await fetch(`${apiOrigin}${path}`);
  if (!response.ok) throw new Error(`GET ${path} returned ${response.status}`);
  return response.json();
}

z.object({ status: z.literal('ok') }).parse(await json('/health'));
const system = createClient(
  systemContract,
  createHttpClient({ baseUrl: `${apiOrigin}/api`, credentials: 'omit' }),
);
z.object({ status: z.literal('ok') }).parse(await system.status());
const openApi = z
  .object({ paths: z.record(z.string(), z.unknown()) })
  .parse(await json('/openapi.json'));
if (!Object.keys(openApi.paths).includes('/api/system/status')) {
  throw new Error('System status contract is missing from OpenAPI');
}

await runSurfaceConformance({ apiOrigin });
await assertPublicWebSurface(toolingEnv.SMOKE_WEB_ORIGIN);
await assertArtifactIsPlacementFree(toolingEnv.SMOKE_WEB_ORIGIN);

console.log(
  'Runtime HTTP, typed client, OpenAPI, MCP, public web and placement-free artifact smoke passed',
);
