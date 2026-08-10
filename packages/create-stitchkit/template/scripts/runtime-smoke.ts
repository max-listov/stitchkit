import { z } from 'zod';
import { runSurfaceConformance } from './surface-conformance';
import { toolingEnv } from './tooling-env';

const apiOrigin = toolingEnv.NEXT_PUBLIC_API_URL;

async function json(path: string): Promise<unknown> {
  const response = await fetch(`${apiOrigin}${path}`);
  if (!response.ok) throw new Error(`GET ${path} returned ${response.status}`);
  return response.json();
}

z.object({ status: z.literal('ok') }).parse(await json('/health'));
const openApi = z
  .object({ paths: z.record(z.string(), z.unknown()) })
  .parse(await json('/openapi.json'));
if (Object.keys(openApi.paths).some((path) => path.startsWith('/api/'))) {
  throw new Error('Blank starter unexpectedly publishes application contracts');
}

await runSurfaceConformance({ apiOrigin });

console.log('Blank runtime HTTP, OpenAPI and MCP smoke passed');
