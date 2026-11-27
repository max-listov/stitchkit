/**
 * The lifecycle block of the conformance kit can fail: every defect below is a driver that passes
 * every other check and breaks exactly one rule of a session's life, and the kit names that rule.
 * The drivers that pass are proven in their own conformance tests; the unbroken replay driver is
 * the positive control here.
 */
import { describe, expect, test } from 'bun:test';
import type {
  AgentEngineDriver,
  AgentEngineSession,
  AgentEngineTurn,
} from '../../src/agent-executor/engine';
import {
  createReplayExecutorDriver,
  replayDialectScenarios,
  runAgentEngineConformance,
  unpackReplayScenario,
} from '../../src/entrypoints/agent-executor/testing';

type OpenInput = Parameters<AgentEngineDriver['open']>[0];
type Defect = (driver: AgentEngineDriver) => AgentEngineDriver;

function conformanceOf(defect: Defect = (driver) => driver): Promise<void> {
  return runAgentEngineConformance({
    scenarios: replayDialectScenarios(),
    async open(scenario) {
      const replay = createReplayExecutorDriver({ turns: [unpackReplayScenario(scenario)] });
      return {
        driver: defect(replay),
        profile: { profileId: 'lifecycle', engine: 'acp', home: '/tmp' },
        cwd: '/tmp',
        inputs: async (threadId) => replay.inputsFor(threadId),
        answered: async (request) => replay.wasAnswered(request.interactionId),
        cleanup: async () => undefined,
      };
    },
  });
}

/** The driver with every session it opens rewritten by `rewrite`. */
function withSessions(
  driver: AgentEngineDriver,
  rewrite: (session: AgentEngineSession, input: OpenInput) => AgentEngineSession,
): AgentEngineDriver {
  return { ...driver, open: async (input) => rewrite(await driver.open(input), input) };
}

/** The session with every turn it starts rewritten by `rewrite`. */
function withTurns(
  session: AgentEngineSession,
  rewrite: (turn: AgentEngineTurn) => AgentEngineTurn,
): AgentEngineSession {
  return {
    nativeThreadId: session.nativeThreadId,
    close: () => session.close(),
    startTurn: async (input) => rewrite(await session.startTurn(input)),
  };
}

/**
 * A driver that keeps the caller's signal from its engine: it refuses an open the caller aborted,
 * as the kit asks, and then stops following the signal.
 */
function deafAfterOpen(driver: AgentEngineDriver): AgentEngineDriver {
  return {
    ...driver,
    async open(input) {
      const session = await driver.open({ ...input, signal: undefined });
      if (input.signal?.aborted) {
        await session.close();
        throw input.signal.reason;
      }
      return session;
    },
  };
}

const DEFECTS: ReadonlyArray<{ rule: string; refusal: string; defect: Defect }> = [
  {
    rule: 'an open given an aborted signal that resolves',
    refusal:
      'open with an aborted signal: open resolved although its signal was already aborted',
    defect: (driver) => ({
      ...driver,
      open: (input) => driver.open({ ...input, signal: undefined }),
    }),
  },
  {
    rule: 'an open aborted with a reason of its own',
    refusal: 'open with an aborted signal: open rejected with Error: the engine stopped',
    defect: (driver) => ({
      ...driver,
      async open(input) {
        if (input.signal?.aborted) throw new Error('the engine stopped');
        return driver.open(input);
      },
    }),
  },
  {
    rule: 'an open that resolves although its signal aborted while it started',
    refusal: 'abort during open: open resolved although its signal aborted while it started',
    defect: (driver) => ({
      ...driver,
      async open(input) {
        input.signal?.throwIfAborted();
        return driver.open({ ...input, signal: undefined });
      },
    }),
  },
  {
    rule: 'a startup observer called after the abort',
    refusal: 'abort during open: the startup observer was called after the abort (verifying)',
    defect: (driver) => ({
      ...driver,
      async open(input) {
        try {
          return await driver.open(input);
        } catch (error) {
          if (input.signal?.aborted) input.onStartupPhase?.('verifying');
          throw error;
        }
      },
    }),
  },
  {
    rule: 'a turn that fails with its own error when the caller aborts',
    refusal: 'abort in a turn: the turn failed with Error: the engine stopped',
    defect: (driver) => ({
      ...driver,
      async open(input) {
        input.signal?.throwIfAborted();
        const own = new AbortController();
        input.signal?.addEventListener('abort', () =>
          own.abort(new Error('the engine stopped')),
        );
        try {
          return await driver.open({ ...input, signal: own.signal });
        } catch (error) {
          throw input.signal?.aborted ? input.signal.reason : error;
        }
      },
    }),
  },
  {
    rule: 'an answer accepted after the abort',
    refusal: 'abort in a turn: an answer was accepted after the abort',
    defect: (driver) =>
      withSessions(driver, (session, input) =>
        withTurns(session, (turn) => ({
          deltas: turn.deltas,
          interrupt: () => turn.interrupt(),
          respond: (interactionId, reply) =>
            turn.respond(interactionId, reply).catch((error: unknown) => {
              if (input.signal?.aborted !== true) throw error;
            }),
        })),
      ),
  },
  {
    rule: 'an interrupt that rejects once the turn ended',
    refusal:
      'interrupt after the end: interrupt of an ended turn rejected with Error: no turn',
    defect: (driver) =>
      withSessions(driver, (session) =>
        withTurns(session, (turn) => {
          let ended = false;
          async function* deltas() {
            for await (const delta of turn.deltas) {
              if (delta.type === 'turn-end') ended = true;
              yield delta;
            }
          }
          return {
            deltas: deltas(),
            respond: (interactionId, reply) => turn.respond(interactionId, reply),
            async interrupt() {
              if (ended) throw new Error('no turn');
              await turn.interrupt();
            },
          };
        }),
      ),
  },
  {
    rule: 'a second close() that rejects',
    refusal: 'close in a turn: close() rejected with Error: already closed',
    defect: (driver) =>
      withSessions(driver, (session) => {
        let closed = false;
        return {
          nativeThreadId: session.nativeThreadId,
          startTurn: (input) => session.startTurn(input),
          async close() {
            if (closed) throw new Error('already closed');
            closed = true;
            await session.close();
          },
        };
      }),
  },
  {
    rule: 'a turn started after close()',
    refusal: 'close in a turn: a turn was started after the session stopped',
    defect: (driver) =>
      withSessions(driver, (session) => {
        let closed = false;
        return {
          nativeThreadId: session.nativeThreadId,
          async close() {
            closed = true;
            await session.close();
          },
          async startTurn(input) {
            if (!closed) return session.startTurn(input);
            return {
              deltas: (async function* () {
                // A turn of nothing: the defect is that it was started at all.
              })(),
              interrupt: async () => undefined,
              respond: async () => undefined,
            };
          },
        };
      }),
  },
  {
    rule: 'capabilities info() reports differently from the driver',
    refusal: 'capabilities: info().capabilities is',
    defect: (driver) => ({
      ...driver,
      async info() {
        const info = await driver.info();
        return {
          ...info,
          ...(info.capabilities !== undefined && {
            capabilities: { ...info.capabilities, steer: !info.capabilities.steer },
          }),
        };
      },
    }),
  },
  {
    rule: 'capabilities the driver declares and info() leaves out',
    refusal: 'capabilities: info().capabilities is undefined',
    defect: (driver) => ({
      ...driver,
      async info() {
        const { capabilities: _left, ...info } = await driver.info();
        return info;
      },
    }),
  },
];

describe('the lifecycle block of runAgentEngineConformance', () => {
  test('passes the replay driver as it is: the positive control of every defect below', async () => {
    await conformanceOf();
  });

  for (const { rule, refusal, defect } of DEFECTS) {
    test(`fails a driver with ${rule}`, async () => {
      await expect(conformanceOf(defect)).rejects.toThrow(
        `Agent engine conformance: ${refusal}`,
      );
    });
  }

  // The defect the replay driver shipped with: nothing listened to the caller's signal, so the
  // stream of an aborted turn waited forever. The kit bounds the wait and names what hung.
  test('fails a driver whose aborted turn never settles, by name instead of hanging', async () => {
    await expect(conformanceOf(deafAfterOpen)).rejects.toThrow(
      "Agent engine conformance: abort in a turn: the aborted turn's stream did not settle within 10000 ms",
    );
  }, 30_000);
});
