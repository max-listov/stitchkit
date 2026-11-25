import { randomUUID } from 'node:crypto';
import type { StepDurabilityLedger } from '../../durability/contract';
import { createLocalStepDurability } from '../../durability/engine';
import type { AgentStoreEventEnvelope } from '../../durability/events';
import { dispatchTurn } from '../dispatch';
import type { AgentEngineDriver, AgentEngineSession, AgentEngineTurn } from '../engine';
import type { ExecutorProfileConfig } from '../profile';
import { projectExecutorDeltas } from '../projection';
import type { ExecutorDelta } from '../vocabulary';
import type { FakeEngineScenario } from './fake-engine';

/** One dialect's scripted engine turns, each named for the behaviour it proves. */
export interface AgentEngineDialectScenarios {
  text(value: string): FakeEngineScenario;
  approval(): FakeEngineScenario;
  failure(status: 401 | 429): FakeEngineScenario;
  interruptible(): FakeEngineScenario;
  interruptDuringApproval(): FakeEngineScenario;
  /** Text, then — once the interrupt arrived — an approval request, as an engine already deciding may send. */
  requestAfterInterrupt(): FakeEngineScenario;
  /** An approval request the engine leaves unanswered as it ends the turn. */
  requestAtTurnEnd(): FakeEngineScenario;
  /** An approval request, then — a moment later, unanswered — the engine dies. */
  requestThenCrash(): FakeEngineScenario;
  eofWithoutResult(): FakeEngineScenario;
  invalidLine(): FakeEngineScenario;
  unknownRecord(): FakeEngineScenario;
  crash(): FakeEngineScenario;
}

/** Configuration passed to the agent engine driver conformance test harness. */
export interface AgentEngineConformanceConfig {
  scenarios: AgentEngineDialectScenarios;
  /** A driver whose engine plays `scenario`, with the profile and directory it runs in. */
  open(scenario: FakeEngineScenario): Promise<{
    driver: AgentEngineDriver;
    profile: ExecutorProfileConfig;
    cwd: string;
    /** How many inputs the engine took, from its transcript. */
    inputs(nativeThreadId: string): Promise<number>;
    /** Whether the engine took an answer to the request it offered as `request`, from its own record. */
    answered(request: Extract<ExecutorDelta, { type: 'request' }>): Promise<boolean>;
    cleanup(): Promise<void>;
  }>;
}

function fail(name: string, message: string): never {
  throw new Error(`Agent engine conformance: ${name}: ${message}`);
}

async function collect(turn: AgentEngineTurn, act?: (delta: ExecutorDelta) => Promise<void>) {
  const deltas: ExecutorDelta[] = [];
  for await (const delta of turn.deltas) {
    deltas.push(delta);
    await act?.(delta);
  }
  return deltas;
}

/** Whether `check` comes true within `timeoutMs`: an engine records an answer after it arrives. */
async function eventually(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function rejects(promise: Promise<unknown>): Promise<boolean> {
  return promise.then(
    () => false,
    () => true,
  );
}

function ledger(): StepDurabilityLedger {
  const rows: AgentStoreEventEnvelope[] = [];
  return {
    appendEvent: async (event) => {
      const row: AgentStoreEventEnvelope = {
        schemaVersion: 1,
        eventId: randomUUID(),
        conversationId: event.conversationId,
        seq: rows.length + 1,
        kind: event.kind,
        occurredAt: new Date().toISOString(),
        payload: event.payload,
      };
      rows.push(row);
      return row;
    },
    readEvents: async (input) => ({
      items: rows.filter(
        (row) =>
          row.conversationId === input.conversationId && row.seq >= (input.fromSeq ?? 1),
      ),
    }),
  };
}

type ConformanceHarness = Awaited<ReturnType<AgentEngineConformanceConfig['open']>>;
/** Play one scenario in a fresh session and run its check; a failure names the check. */
type ConformanceTurn = (
  name: string,
  scenario: FakeEngineScenario,
  check: (session: AgentEngineSession, harness: ConformanceHarness) => Promise<void>,
) => Promise<void>;

function conformanceTurn(config: AgentEngineConformanceConfig): ConformanceTurn {
  return async (name, scenario, check) => {
    const harness = await config.open(scenario);
    const session = await harness.driver.open({ profile: harness.profile, cwd: harness.cwd });
    try {
      await check(session, harness);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Agent engine conformance'))
        throw error;
      fail(name, error instanceof Error ? error.message : String(error));
    } finally {
      await session.close();
      await harness.cleanup();
    }
  };
}

function start(session: AgentEngineSession, clientId: string = randomUUID()) {
  return session.startTurn({
    turnId: randomUUID(),
    clientId,
    input: [{ type: 'text', text: 'hello' }],
  });
}

/**
 * Prove a driver against its dialect's scripted engine: a text turn and the
 * reconcile of its input; an approval answered, an unknown or empty answer
 * refused; failures by kind; an interrupt that ends `interrupted` even when
 * the engine reports success after it, a request it answers closed with
 * `request-resolved`, and a request sent after it refused by the driver
 * rather than offered to the consumer; a request still held when the turn
 * ends is answered to the engine and closed with `request-resolved` before the end, and neither it nor
 * one held when the engine dies is left for the consumer to answer; an
 * engine that ends without a
 * result, writes an invalid line or dies is a failed turn, never a hang; an
 * unknown record is carried as `unhandled`; and a dispatch cut between its
 * intent and its acceptance is settled by reconcile and never sent twice.
 */
export async function runAgentEngineConformance(
  config: AgentEngineConformanceConfig,
): Promise<void> {
  const turn = conformanceTurn(config);
  for (const check of [
    checkText,
    checkApproval,
    checkFailures,
    checkInterrupts,
    checkHeldRequests,
    checkBrokenEngines,
    checkUnknownRecord,
    checkDispatchAtMostOnce,
  ]) {
    await check(turn, config.scenarios);
  }
}

/** A conformance check: the scenarios it plays and what each must show. */
type ConformanceCheck = (
  turn: ConformanceTurn,
  scenarios: AgentEngineDialectScenarios,
) => Promise<void>;

/** A text turn folds into its text and ends; a client-id driver finds the input it sent and no other. */
const checkText: ConformanceCheck = async (turn, scenarios) => {
  await turn('text', scenarios.text('hello back'), async (session, harness) => {
    const clientId = randomUUID();
    const deltas = await collect(await start(session, clientId));
    const parts = projectExecutorDeltas(deltas);
    if (JSON.stringify(parts) !== JSON.stringify([{ type: 'text', text: 'hello back' }])) {
      fail('text', `folded into ${JSON.stringify(parts)}`);
    }
    if (deltas.at(-1)?.type !== 'turn-end')
      fail('text', 'the last delta is not the end of the turn');
    if (harness.driver.reconcile === 'client-id') {
      const find = harness.driver.findInput;
      if (find === undefined) fail('text', 'a client-id driver has no findInput');
      const at = {
        profile: harness.profile,
        cwd: harness.cwd,
        nativeThreadId: session.nativeThreadId,
      };
      if (!(await find({ ...at, clientId }))) fail('text', 'the sent input is not found');
      if (await find({ ...at, clientId: randomUUID() }))
        fail('text', 'an input never sent is found');
    }
  });
};

/** An approval answered goes through; an answer to an unknown request or an empty deny is refused. */
const checkApproval: ConformanceCheck = async (turn, scenarios) => {
  await turn('approval', scenarios.approval(), async (session) => {
    const running = await start(session);
    const deltas = await collect(running, async (delta) => {
      if (delta.type !== 'request') return;
      if (!(await rejects(running.respond('no-such-request', { kind: 'approve' })))) {
        fail('approval', 'an answer to an unknown request was accepted');
      }
      if (
        !(await rejects(running.respond(delta.interactionId, { kind: 'deny', message: '' })))
      ) {
        fail('approval', 'a deny without a message was accepted');
      }
      await running.respond(delta.interactionId, { kind: 'approve' });
    });
    for (const type of ['tool-call', 'request', 'request-resolved', 'tool-result'] as const) {
      if (!deltas.some((delta) => delta.type === type)) fail('approval', `no ${type} delta`);
    }
    const result = deltas.find((delta) => delta.type === 'tool-result');
    if (result?.type === 'tool-result' && result.toolName === 'unknown') {
      fail('approval', 'the tool result lost the name of its call');
    }
  });
};

/** An engine's refusal is a typed error by kind and a failed turn. */
const checkFailures: ConformanceCheck = async (turn, scenarios) => {
  for (const [status, kind] of [
    [401, 'authRequired'],
    [429, 'rateLimited'],
  ] as const) {
    await turn(`failure ${status}`, scenarios.failure(status), async (session) => {
      const deltas = await collect(await start(session));
      const error = deltas.find((delta) => delta.type === 'error');
      if (error?.type !== 'error' || error.kind !== kind)
        fail(`failure ${status}`, `no ${kind} error`);
      const end = deltas.find((delta) => delta.type === 'turn-end');
      if (end?.type !== 'turn-end' || end.outcome !== 'failed')
        fail(`failure ${status}`, 'the turn did not fail');
    });
  }
};

/** An engine that ends without a result, writes an invalid line or dies fails the turn, never hangs it. */
const checkBrokenEngines: ConformanceCheck = async (turn, scenarios) => {
  for (const [name, scenario] of [
    ['end without a result', scenarios.eofWithoutResult()],
    ['an invalid line', scenarios.invalidLine()],
    ['a dying engine', scenarios.crash()],
  ] as const) {
    await turn(name, scenario, async (session) => {
      if (!(await rejects(collect(await start(session)))))
        fail(name, 'the turn ended as if it had completed');
    });
  }
};

/** A record the driver does not know is carried as an `unhandled` error, not dropped. */
const checkUnknownRecord: ConformanceCheck = async (turn, scenarios) => {
  await turn('unknown record', scenarios.unknownRecord(), async (session) => {
    const deltas = await collect(await start(session));
    const error = deltas.find((delta) => delta.type === 'error');
    if (error?.type !== 'error' || error.kind !== 'unhandled')
      fail('unknown record', 'no unhandled delta');
  });
};

/**
 * At most once: the send happens, the process dies before the acceptance is
 * recorded; the next attempt reconciles instead of sending again.
 */
const checkDispatchAtMostOnce: ConformanceCheck = async (turn, scenarios) => {
  await turn('dispatch at most once', scenarios.text('once'), async (session, harness) => {
    const store = ledger();
    const turnId = randomUUID();
    const dying: AgentEngineSession = {
      nativeThreadId: session.nativeThreadId,
      close: () => session.close(),
      async startTurn(input) {
        const running = await session.startTurn(input);
        await collect(running);
        throw new Error('the executor died after sending');
      },
    };
    const attempt = (target: AgentEngineSession) =>
      dispatchTurn({
        durability: createLocalStepDurability({
          store,
          conversationId: 'thread',
          runId: turnId,
        }),
        driver: harness.driver,
        session: target,
        profile: harness.profile,
        cwd: harness.cwd,
        turnId,
        input: [{ type: 'text', text: 'hello' }],
      });
    if (!(await rejects(attempt(dying))))
      fail('dispatch at most once', 'the cut dispatch did not fail');
    const second = await attempt(session);
    const expected =
      harness.driver.reconcile === 'client-id' ? 'delivered' : 'unknown_after_restart';
    if (second.phase !== expected)
      fail('dispatch at most once', `settled as ${second.phase}, expected ${expected}`);
    const inputs = await harness.inputs(session.nativeThreadId);
    if (inputs !== 1) fail('dispatch at most once', `the engine took ${inputs} inputs`);
  });
};

/**
 * A request the engine still waits on when its turn ends, or when the engine dies, is answered by
 * the driver: closed with `request-resolved` before the end of a turn that ended, and in either
 * case no longer open to an answer from the consumer, which would reach nobody.
 */
const checkHeldRequests: ConformanceCheck = async (turn, scenarios) => {
  await turn(
    'request held at the end',
    scenarios.requestAtTurnEnd(),
    async (session, harness) => {
      const running = await start(session);
      const deltas = await collect(running);
      const asked = deltas.find((delta) => delta.type === 'request');
      if (asked?.type !== 'request') fail('request held at the end', 'no request was emitted');
      const resolved = deltas.findIndex(
        (delta) =>
          delta.type === 'request-resolved' && delta.interactionId === asked.interactionId,
      );
      const end = deltas.findIndex((delta) => delta.type === 'turn-end');
      if (resolved === -1 || end === -1 || resolved > end)
        fail(
          'request held at the end',
          'the request the turn still held was not closed with request-resolved before its end',
        );
      if (!(await rejects(running.respond(asked.interactionId, { kind: 'approve' }))))
        fail(
          'request held at the end',
          'an answer to a request of an ended turn was accepted',
        );
      // An engine waits on its request; closing it on the stream alone would leave it waiting.
      if (!(await eventually(() => harness.answered(asked))))
        fail('request held at the end', 'the engine was never answered');
    },
  );

  await turn(
    'request held by a lost engine',
    scenarios.requestThenCrash(),
    async (session) => {
      const running = await start(session);
      let asked: string | undefined;
      const lost = await rejects(
        collect(running, async (delta) => {
          if (delta.type === 'request') asked ??= delta.interactionId;
        }),
      );
      if (!lost)
        fail('request held by a lost engine', 'the turn ended as if it had completed');
      if (asked === undefined) fail('request held by a lost engine', 'no request was emitted');
      if (!(await rejects(running.respond(asked, { kind: 'approve' }))))
        fail(
          'request held by a lost engine',
          'an answer to a request the lost engine held was accepted',
        );
    },
  );
};

/** An interrupt ends the turn `interrupted`, answers what it held, and refuses what follows it. */
const checkInterrupts: ConformanceCheck = async (turn, scenarios) => {
  await turn('interrupt', scenarios.interruptible(), async (session) => {
    const running = await start(session);
    let asked = false;
    const deltas = await collect(running, async (delta) => {
      if (!asked && delta.type === 'text') {
        asked = true;
        await running.interrupt();
      }
    });
    const end = deltas.find((delta) => delta.type === 'turn-end');
    if (end?.type !== 'turn-end' || end.outcome !== 'interrupted') {
      fail(
        'interrupt',
        `a turn asked to stop ended ${end?.type === 'turn-end' ? end.outcome : 'without an end'}`,
      );
    }
  });

  await turn(
    'interrupt during approval',
    scenarios.interruptDuringApproval(),
    async (session) => {
      const running = await start(session);
      let asked: string | undefined;
      const deltas = await collect(running, async (delta) => {
        if (asked === undefined && delta.type === 'request') {
          asked = delta.interactionId;
          await running.interrupt();
        }
      });
      if (asked === undefined)
        fail('interrupt during approval', 'no approval request was emitted');
      if (
        !deltas.some(
          (delta) => delta.type === 'request-resolved' && delta.interactionId === asked,
        )
      )
        fail(
          'interrupt during approval',
          'the request the interrupt answered was never closed with request-resolved',
        );
      const end = deltas.find((delta) => delta.type === 'turn-end');
      if (end?.type !== 'turn-end' || end.outcome !== 'interrupted') {
        fail(
          'interrupt during approval',
          `a turn interrupted during approval ended ${end?.type === 'turn-end' ? end.outcome : 'without an end'}`,
        );
      }
    },
  );

  // Nobody is left to answer a request that follows the interrupt: the driver refuses it itself.
  await turn('request after interrupt', scenarios.requestAfterInterrupt(), async (session) => {
    const running = await start(session);
    let interrupted = false;
    const deltas = await collect(running, async (delta) => {
      if (!interrupted && delta.type === 'text') {
        interrupted = true;
        await running.interrupt();
      } else if (interrupted && delta.type === 'request') {
        fail(
          'request after interrupt',
          'a request sent after the interrupt was offered to a consumer who already stopped the turn',
        );
      }
    });
    const end = deltas.find((delta) => delta.type === 'turn-end');
    if (end?.type !== 'turn-end' || end.outcome !== 'interrupted') {
      fail(
        'request after interrupt',
        `the turn ended ${end?.type === 'turn-end' ? end.outcome : 'without an end'}`,
      );
    }
  });
};
