/**
 * ACP `steerMode: 'prompt'` against an agent that runs one prompt at a time: the refused steer is
 * told as a non-terminal error, and the turn stays with the first prompt until that one ends.
 */
import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ExecutorDelta } from '../../src/entrypoints/agent-executor';
import { createAcpDriver } from '../../src/entrypoints/agent-executor/acp';
import { ambientIn, inScratch } from '../support/engine-driver-harness';
import { reapAfterEachTest } from '../support/process-reaper';

reapAfterEachTest();

const AGENT = resolve(import.meta.dir, '../fixtures/acp-steer-refusing-agent.ts');

function turnInput(id: string) {
  return { turnId: id, clientId: `c-${id}`, input: [{ type: 'text' as const, text: id }] };
}

for (const mode of ['hold', 'burst'] as const)
  test(`a refused steer prompt keeps the turn with the first prompt (${mode})`, () =>
    inScratch(`acp-steer-refusal-${mode}`, async (root) => {
      const session = await createAcpDriver({
        executable: process.execPath,
        args: [AGENT, root, mode],
        ambient: ambientIn(root),
        steerMode: 'prompt',
      }).open({
        profile: { profileId: 'p', engine: 'acp', home: join(root, 'h') },
        cwd: root,
      });
      try {
        const turn = await session.startTurn(turnInput('t-1'));
        const iterator = turn.deltas[Symbol.asyncIterator]();
        expect((await iterator.next()).value).toMatchObject({ type: 'text' });
        expect(await session.steerTurn({ input: turnInput('steer').input })).toEqual({
          turnId: 't-1',
        });
        const deltas: ExecutorDelta[] = [];
        for (;;) {
          const next = await iterator.next();
          if (next.done) break;
          deltas.push(next.value);
          if (next.value.type === 'error' && mode === 'hold') {
            // The first prompt still runs: the session is still busy with this turn.
            await expect(session.startTurn(turnInput('t-2'))).rejects.toThrow(
              /already running/,
            );
            writeFileSync(join(root, 'release'), '1');
          }
        }
        expect(deltas).toEqual([
          expect.objectContaining({
            type: 'error',
            itemId: 'steer-refused:2',
            message: expect.stringContaining('a prompt is already running'),
          }),
          expect.objectContaining({ type: 'text' }),
          expect.objectContaining({ type: 'turn-end', outcome: 'completed' }),
        ]);
      } finally {
        await session.close();
      }
    }));
