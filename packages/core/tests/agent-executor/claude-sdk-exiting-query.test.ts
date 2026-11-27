/**
 * A Claude SDK turn binds only to the query that is running when it is sent: an idle query that
 * exits while `startTurn` awaits it no longer reads input, and a turn sent to it would hang.
 */
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { createClaudeSdkDriver } from '../../src/entrypoints/agent-executor/claude-sdk';
import {
  createFakeClaudeSdkQuery,
  type FakeClaudeSdkRunController,
} from '../../src/entrypoints/agent-executor/testing/claude-sdk';
import { ambientIn, drain, inScratch } from '../support/engine-driver-harness';
import { reapAfterEachTest } from '../support/process-reaper';

reapAfterEachTest();

function textTurn(turnId: string) {
  return {
    turnId,
    clientId: crypto.randomUUID(),
    input: [{ type: 'text' as const, text: 'hi' }],
  };
}

test('a turn started while the idle query exits runs on a fresh query, and the next turn is accepted', () =>
  inScratch('claude-sdk-exiting-query', async (root) => {
    const runs: FakeClaudeSdkRunController[] = [];
    const answer = (message: { uuid?: string | undefined }, run: FakeClaudeSdkRunController) =>
      run.emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 's',
        result: 'ok',
        uuid: message.uuid,
      });
    const fake = createFakeClaudeSdkQuery({
      onRun: (run) => {
        runs.push(run);
      },
      turns: [answer, answer],
    });
    const session = await createClaudeSdkDriver({
      sdkVersion: '0.3.332',
      ambient: ambientIn(root),
      query: fake.query,
    }).open({
      profile: { profileId: 'p', engine: 'claude-sdk', home: join(root, 'home') },
      cwd: root,
    });
    try {
      // A live control starts the first query's loop; it then ends while idle, exactly as
      // startTurn awaits the handle it already holds.
      await session.supportedModels();
      runs[0]?.end();
      const turn = await session.startTurn(textTurn('t-1'));
      const deltas = await drain(turn);
      expect(deltas.at(-1)).toMatchObject({ type: 'turn-end' });
      expect(runs).toHaveLength(2);
      const next = await session.startTurn(textTurn('t-2'));
      expect((await drain(next)).at(-1)).toMatchObject({ type: 'turn-end' });
    } finally {
      await session.close();
    }
  }));
