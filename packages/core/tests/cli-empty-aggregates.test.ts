import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { renderCliView } from '../src/entrypoints/cli';
import { runNativeCommand } from '../src/process/command';
import { reapAfterEachTest, trackGroupLeader } from './support/process-reaper';

reapAfterEachTest();

test('every view control of the installed proof holds on source', async () => {
  const result = await runNativeCommand({
    executable: process.execPath,
    args: [
      fileURLToPath(
        new URL(
          '../scripts/consumer-lane/fixtures/minimal/src/cli-empty-aggregates.mjs',
          import.meta.url,
        ),
      ),
      new URL('../src/entrypoints/cli.ts', import.meta.url).href,
      new URL('../src/entrypoints/contract.ts', import.meta.url).href,
    ],
    envPolicy: 'ambient',
    capture: true,
    timeoutMs: 20_000,
    maxOutputBytes: 64 * 1024,
    onLeaderStarted: trackGroupLeader,
  });
  expect(new TextDecoder().decode(result.stderr)).toBe('');
  expect(result.exitCode).toBe(0);
  expect(new TextDecoder().decode(result.stdout)).toContain('packed CLI empty aggregates: ok');
}, 25_000);

// `--top` refuses zero, so only a direct caller of the exported renderer reaches an empty cut.
test('an empty cut of a nonempty collection still refuses an unknown column', () => {
  const view = { kind: 'records', top: 0, table: ['missing'] } as const;
  expect(() => renderCliView([{ a: 1 }], view)).toThrow(
    'no record carries the field "missing"',
  );
  expect(renderCliView([{ a: 1 }], { ...view, table: ['a'] })).toEqual({
    kind: 'text',
    text: 'a\n-\n',
  });
});
