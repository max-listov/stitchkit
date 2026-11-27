/** The one owner of a session's liveness and the guards every driver's turn handle goes through. */
import { describe, expect, test } from 'bun:test';
import {
  abandonEngineTurn,
  type EngineRequestTurn,
  endEngineTurn,
  interruptEngineTurn,
  loseEngineTurn,
  respondToEngineRequest,
} from '../../src/agent-executor/engine-requests';
import {
  createTurnDeltaChannel,
  sessionLiveness,
} from '../../src/agent-executor/session-primitives';

function session(within?: ReturnType<typeof sessionLiveness>) {
  const caller = new AbortController();
  const linked = new AbortController();
  const liveness = sessionLiveness({
    closedMessage: 'The session is closed',
    caller: caller.signal,
    linked: linked.signal,
    within,
  });
  return { caller, linked, liveness };
}

function thrownBy(act: () => void): unknown {
  try {
    act();
  } catch (error) {
    return error;
  }
  return undefined;
}

function turnHolding(interactionId: string) {
  const answers: string[] = [];
  const turn: EngineRequestTurn<string, { tool: string }> = {
    state: { turnId: 't', interruptRequested: false },
    channel: createTurnDeltaChannel(),
    pending: new Map(),
    settled: false,
  };
  turn.pending.set(interactionId, {
    detail: { tool: 'Write' },
    answeredBy: { source: 'test', type: 'answer' },
    resolve: (answer) => answers.push(answer),
  });
  return { turn, answers };
}

describe('sessionLiveness', () => {
  test('is alive until something stops it, and then names the reason in one order', () => {
    const { caller, linked, liveness } = session();
    expect(liveness.isAlive()).toBe(true);
    expect(liveness.stopped()).toBeUndefined();
    expect(thrownBy(() => liveness.ensureAlive())).toBeUndefined();

    // The session's own abort is the last reason asked.
    linked.abort(new Error('own abort'));
    expect(liveness.isAlive()).toBe(false);
    expect(thrownBy(() => liveness.ensureAlive())).toMatchObject({ message: 'own abort' });
    // The caller's abort is named before it.
    const callerReason = new Error('caller abort');
    caller.abort(callerReason);
    expect(liveness.abortedByCaller).toBe(true);
    expect(thrownBy(() => liveness.ensureAlive())).toBe(callerReason);
    // A recorded loss before both; the first loss is the one kept.
    const lost = new Error('engine lost');
    liveness.markLost(lost);
    liveness.markLost(new Error('a later loss'));
    expect(liveness.lost).toEqual({ reason: lost });
    expect(thrownBy(() => liveness.ensureAlive())).toBe(lost);
    expect(liveness.terminated()).toEqual({ reason: lost });
    // Closing before everything, with the session's own message.
    liveness.markClosing();
    expect(liveness.closing).toBe(true);
    expect(thrownBy(() => liveness.ensureAlive())).toMatchObject({
      message: 'The session is closed',
    });
    // What ended the engine is still told apart from the close.
    expect(liveness.terminated()).toEqual({ reason: lost });
  });

  test('a signal aborted without a reason stops the session with an AbortError', () => {
    const { caller, liveness } = session();
    caller.abort();
    expect(thrownBy(() => liveness.ensureAlive())).toMatchObject({ name: 'AbortError' });
  });

  test('closing gracefully lasts while the closing session still has its engine', () => {
    const { linked, liveness } = session();
    expect(liveness.closingGracefully).toBe(false);
    liveness.markClosing();
    expect(liveness.closingGracefully).toBe(true);
    expect(liveness.terminated()).toBeUndefined();
    linked.abort();
    expect(liveness.closingGracefully).toBe(false);
  });

  test('a session inside an owner stops with the owner, after its own close and loss', () => {
    const server = session();
    const thread = session(server.liveness);
    const serverLost = new Error('server lost');
    server.liveness.markLost(serverLost);
    expect(thrownBy(() => thread.liveness.ensureAlive())).toBe(serverLost);
    // The owner's reason comes before the thread's own signals.
    thread.caller.abort(new Error('thread caller abort'));
    expect(thrownBy(() => thread.liveness.ensureAlive())).toBe(serverLost);
    const threadLost = new Error('thread lost');
    thread.liveness.markLost(threadLost);
    expect(thrownBy(() => thread.liveness.ensureAlive())).toBe(threadLost);
    thread.liveness.markClosing();
    expect(thrownBy(() => thread.liveness.ensureAlive())).toMatchObject({
      message: 'The session is closed',
    });
  });
});

describe('interruptEngineTurn', () => {
  test('marks the turn, answers what it holds, then tells the engine — in that order', async () => {
    const { liveness } = session();
    const { turn, answers } = turnHolding('r1');
    const order: string[] = [];
    await interruptEngineTurn(turn, liveness, {
      refusal: () => {
        order.push(`refused:${turn.state.interruptRequested}`);
        return 'refused';
      },
      tell: () => {
        order.push(`told:${turn.pending.size}`);
      },
    });
    expect(order).toEqual(['refused:true', 'told:0']);
    expect(answers).toEqual(['refused']);
  });

  test('is a no-op on a settled turn and on a stopped session: the engine is told nothing', async () => {
    const told: string[] = [];
    const stop = { refusal: () => 'refused', tell: () => told.push('told') };

    const ended = turnHolding('r1');
    endEngineTurn(ended.turn, () => 'ended', []);
    await interruptEngineTurn(ended.turn, session().liveness, stop);
    expect(ended.turn.state.interruptRequested).toBe(false);

    const stopped = session();
    stopped.liveness.markClosing();
    const held = turnHolding('r1');
    await interruptEngineTurn(held.turn, stopped.liveness, stop);
    expect(held.turn.state.interruptRequested).toBe(false);
    expect(held.answers).toEqual([]);
    expect(told).toEqual([]);
  });

  test('awaits what telling the engine returns, and rejects with its failure', async () => {
    const { turn } = turnHolding('r1');
    const refused = new Error('the engine refused the interrupt');
    await expect(
      interruptEngineTurn(turn, session().liveness, {
        refusal: () => 'refused',
        tell: () => Promise.reject(refused),
      }),
    ).rejects.toBe(refused);
  });
});

describe('respondToEngineRequest', () => {
  test('answers a held request from its detail and closes it on the stream', () => {
    const { turn, answers } = turnHolding('r1');
    respondToEngineRequest(turn, session().liveness, 'r1', (detail) => `allow ${detail.tool}`);
    expect(answers).toEqual(['allow Write']);
    expect(turn.pending.size).toBe(0);
  });

  test("refuses with the session's reason first, the turn's loss second, an unknown request last", () => {
    const answer = () => 'never built';
    const alive = session().liveness;

    const unknown = turnHolding('r1');
    expect(
      thrownBy(() => respondToEngineRequest(unknown.turn, alive, 'r2', answer)),
    ).toBeInstanceOf(TypeError);

    const lostTurn = turnHolding('r1');
    const loss = new Error('the query ended');
    loseEngineTurn(lostTurn.turn, () => 'lost', loss);
    expect(thrownBy(() => respondToEngineRequest(lostTurn.turn, alive, 'r1', answer))).toBe(
      loss,
    );

    const stopped = session();
    const reason = new Error('caller abort');
    stopped.caller.abort(reason);
    expect(
      thrownBy(() => respondToEngineRequest(lostTurn.turn, stopped.liveness, 'r1', answer)),
    ).toBe(reason);
  });
});

describe('a settled turn', () => {
  test('is settled by its end, its loss and its abandonment, and only an abandonment answers nothing', async () => {
    const ended = turnHolding('r1');
    endEngineTurn(ended.turn, () => 'ended', []);
    expect(ended.turn.settled).toBe(true);
    expect(ended.turn.lost).toBeUndefined();
    expect(ended.answers).toEqual(['ended']);

    const lost = turnHolding('r1');
    const loss = new Error('lost');
    loseEngineTurn(lost.turn, () => 'lost', loss);
    expect(lost.turn.settled).toBe(true);
    expect(lost.turn.lost).toEqual({ error: loss });
    expect(lost.answers).toEqual(['lost']);

    const abandoned = turnHolding('r1');
    const gone = new Error('the engine exited');
    abandonEngineTurn(abandoned.turn, gone);
    expect(abandoned.turn.settled).toBe(true);
    expect(abandoned.turn.lost).toEqual({ error: gone });
    expect(abandoned.answers).toEqual([]);
    expect(abandoned.turn.pending.size).toBe(0);
    const read = async () => {
      for await (const _ of abandoned.turn.channel) {
        // Nothing was offered: the stream only fails.
      }
    };
    await expect(read()).rejects.toBe(gone);
    await expect(
      (async () => {
        for await (const _ of lost.turn.channel) {
          // The request-resolved delta, then the failure.
        }
      })(),
    ).rejects.toBe(loss);
  });
});
