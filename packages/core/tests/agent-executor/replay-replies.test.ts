import { expect, test } from 'bun:test';
import {
  createReplayExecutorDriver,
  formatReplayTranscript,
} from '../../src/entrypoints/agent-executor/testing';

test.each([
  ['same', true, true],
  ['same', false, true],
  ['different', false, true],
  ['same', false, false],
] as const)(
  'replay accounts for the second turn separately (%s, answered=%s, required=%s)',
  async (secondId, answer, required) => {
    const script = (id: string, mandatory: boolean) =>
      formatReplayTranscript([
        { kind: 'request', interactionId: id, requestKind: 'approval' },
        { kind: 'expectReply', interactionId: id, required: mandatory },
        { kind: 'emit', block: 'turn-end', outcome: 'completed' },
      ]);
    const driver = createReplayExecutorDriver({
      turns: [script('same', true), script(secondId, required)],
      assertCompleteOnClose: true,
    });
    const session = await driver.open({
      profile: { engine: 'acp', profileId: 'p', home: '/tmp' },
      cwd: '/tmp',
    });
    for (const [index, respond] of [true, answer].entries()) {
      const turn = await session.startTurn({
        turnId: `turn-${index}`,
        clientId: String(index),
        input: [{ type: 'text', text: 'go' }],
      });
      for await (const delta of turn.deltas) {
        if (delta.type !== 'request') continue;
        if (respond) await turn.respond(delta.interactionId, { kind: 'approve' });
        else await turn.interrupt();
      }
    }
    if (required && !answer) {
      const reason = new RegExp(`turn 2 step 2.*expectReply:${secondId}`);
      expect(() => driver.assertComplete()).toThrow(reason);
      await expect(session.close()).rejects.toThrow(reason);
    } else {
      expect(() => driver.assertComplete()).not.toThrow();
      await session.close();
    }
  },
);
