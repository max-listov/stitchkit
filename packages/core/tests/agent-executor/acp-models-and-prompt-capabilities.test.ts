/**
 * An ACP probe can read every model's own options without inference and without leaving a session
 * behind, and an open ACP session carries what its agent declared in `initialize`.
 */
import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createAcpDriver } from '../../src/entrypoints/agent-executor/acp';
import { ambientIn, inScratch } from '../support/engine-driver-harness';
import { reapAfterEachTest } from '../support/process-reaper';

reapAfterEachTest();

const AGENT = resolve(import.meta.dir, '../fixtures/acp-models-peer.ts');

function driver(root: string, mode: 'text' | 'images') {
  writeFileSync(join(root, 'sessions.json'), JSON.stringify(['user-session']));
  return createAcpDriver({
    executable: process.execPath,
    args: [AGENT, root, mode],
    ambient: ambientIn(root),
  });
}

const profile = (root: string) => ({
  profileId: 'p',
  engine: 'acp' as const,
  home: join(root, 'h'),
});

test('eachModel reads every model its own options in the ephemeral session and deletes it', () =>
  inScratch('acp-each-model', async (root) => {
    const probe = await driver(root, 'text').probeCapabilities({
      profile: profile(root),
      cwd: root,
      eachModel: true,
    });
    const thinking = (model: string) =>
      probe.optionsByModel?.[model]
        ?.find((option) => option.category === 'thought_level')
        ?.options?.map((option) => ('value' in option ? option.value : undefined));
    expect(thinking('m-a')).toEqual(['low', 'high']);
    expect(thinking('m-b')).toEqual(['off', 'max']);
    // Only the active model's levels are in the plain answer; the probe left no session behind.
    expect(JSON.parse(readFileSync(join(root, 'sessions.json'), 'utf8'))).toEqual([
      'user-session',
    ]);
    const plain = await driver(root, 'text').probeCapabilities({
      profile: profile(root),
      cwd: root,
    });
    expect(plain.optionsByModel).toBeUndefined();
  }));

test.each(['images', 'text'] as const)(
  'an open session carries the image input its agent declared (%s)',
  (mode) =>
    inScratch(`acp-prompt-capabilities-${mode}`, async (root) => {
      const session = await driver(root, mode).open({ profile: profile(root), cwd: root });
      try {
        expect(session.initialized.agentCapabilities?.promptCapabilities?.image).toBe(
          mode === 'images',
        );
      } finally {
        await session.close();
      }
    }),
);
