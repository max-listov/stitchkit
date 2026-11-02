/**
 * The client runs on every page of a storefront, so its weight is a contract:
 * under 8 KB gzip with the IndexedDB outbox, and no `zod` in the graph. Measured on
 * a real bundle, because an import that looks type-only is a claim until built.
 * The published files have their own check in `scripts/build-entrypoints.mjs`.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { $ } from 'bun';

const GZIP_LIMIT_BYTES = 8 * 1024;
const ENTRYPOINT = join(import.meta.dir, '../src/entrypoints');

async function measure(source: string) {
  const directory = (await $`mktemp -d`.text()).trim();
  const entry = join(directory, 'entry.ts');
  await Bun.write(entry, source);
  const built = await Bun.build({
    entrypoints: [entry],
    target: 'browser',
    minify: true,
    metafile: true,
  });
  await $`rm -rf ${directory}`;
  const [output] = built.outputs;
  if (!output) throw new Error('the bundle has no output');
  const inputs = Object.keys(built.metafile?.inputs ?? {});
  return {
    gzip: Bun.gzipSync(new TextEncoder().encode(await output.text())).byteLength,
    zod: inputs.filter((input) => input.includes('/zod/')).length,
    inputs: inputs.length,
  };
}

const CLIENT = `
  import { createTrackingClient, indexedDbOutboxStorage } from '${ENTRYPOINT}/tracking';
  console.log(createTrackingClient, indexedDbOutboxStorage);
`;

describe('the browser weight of tracking', () => {
  test('the client with its IndexedDB outbox stays small, with no zod', async () => {
    const client = await measure(CLIENT);
    expect(client.inputs).toBeGreaterThan(5);
    expect(client.zod).toBe(0);
    expect(client.gzip).toBeLessThanOrEqual(GZIP_LIMIT_BYTES);
  });

  test('the collector has no zod either', async () => {
    const collector = await measure(`
      import { createPerformanceCollector } from '${ENTRYPOINT}/tracking/performance';
      console.log(createPerformanceCollector);
    `);
    expect(collector.zod).toBe(0);
  });

  test('importing a schema in browser code is what brings zod back', async () => {
    const withSchema = await measure(`
      import { UtmDataSchema } from '${ENTRYPOINT}/tracking/contract';
      console.log(UtmDataSchema);
    `);
    expect(withSchema.zod).toBeGreaterThan(0);
    expect(withSchema.gzip).toBeGreaterThan(GZIP_LIMIT_BYTES);
  });
});
