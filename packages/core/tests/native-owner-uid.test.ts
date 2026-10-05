import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  installedConsumerProofs,
  runInstalledConsumerProofs,
} from '../scripts/consumer-lane/installed-proofs';

const capable = process.platform === 'linux' && process.getuid?.() === 0;
const helper = new URL(
  '../scripts/consumer-lane/fixtures/node/src/native-owner-uid.mjs',
  import.meta.url,
).href;
const files = new URL('../src/entrypoints/files.ts', import.meta.url).href;

function fixture(name: string) {
  const program = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  const result = spawnSync(process.execPath, [program, helper, files], {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 16 * 1024,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

test.skipIf(!capable)(
  'native mixed UID validates Node from PATH, outsider EACCES and SIGKILL reclaim',
  () => {
    expect(fixture('native-uid-mixed.mjs').trim()).toBe('native mixed UID: ok');
  },
);

test.skipIf(!capable)(
  'a Bun parent selects actual Node outside /usr/bin and refuses Bun disguised as node',
  () => {
    expect(fixture('native-uid-node-path.mjs').trim()).toBe(
      'validated Node PATH controls: ok',
    );
  },
);

test.skipIf(!capable)(
  'UID holder readiness and post-acquisition assertion failures kill and reap their exact child',
  () => {
    expect(fixture('native-uid-holder-controls.mjs').trim()).toBe(
      'UID owned holder controls: ok',
    );
  },
);

test('UID proof capability is separate from generic ownership and mandatory qualification cannot skip', async () => {
  const proof = installedConsumerProofs.find((entry) => entry.id === 'native-owner-uid');
  expect(proof?.marker).toBe('packed Linux mixed UID: ok');
  expect(proof?.capability).toBe('linux-root');
  const results: string[] = [];
  let invoked = 0;
  const input = {
    ids: ['native-owner-uid'],
    platform: 'linux' as const,
    uid: 1000,
    run: async () => {
      invoked++;
      return 'packed Linux mixed UID: ok';
    },
    verdict: (_proof: unknown, runtime: string, state: string) =>
      results.push(`${runtime}:${state}`),
  };
  await runInstalledConsumerProofs(input);
  expect(results).toEqual(['platform:not-applicable']);
  expect(invoked).toBe(0);
  await expect(
    runInstalledConsumerProofs({
      ...input,
      platform: 'darwin',
      uid: 0,
      requireCapabilities: true,
    }),
  ).rejects.toThrow('requires Linux UID0');
  expect(invoked).toBe(0);
  await expect(
    runInstalledConsumerProofs({ ...input, requireCapabilities: true }),
  ).rejects.toThrow('requires Linux UID0');
  expect(invoked).toBe(0);
  await expect(
    runInstalledConsumerProofs({
      ...input,
      uid: 0,
      run: async () => 'packed native owners: ok',
    }),
  ).rejects.toThrow('no exact success marker');
});
