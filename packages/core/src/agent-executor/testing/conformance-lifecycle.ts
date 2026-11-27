import type { AgentEngineSession } from '../engine';
import type { ExecutorStartupPhase } from '../vocabulary';
import type { AgentEngineConformanceConfig } from './conformance';
import {
  collectTurn,
  conformanceFailure,
  isConformanceFailure,
  rejects,
  settlesInTime,
  startTextTurn,
} from './conformance-support';
import type { FakeEngineScenario } from './fake-engine';

type Harness = Awaited<ReturnType<AgentEngineConformanceConfig['open']>>;

/** A reason no driver produces by itself: a failure equal to it came from the caller's signal. */
function callerAbort(name: string): Error {
  return new Error(`Agent engine conformance: ${name}: the caller aborted`);
}

/** The outcome of a promise as a value, so a rejection can be compared by identity. */
function outcomeOf<T>(
  promise: Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

function describeFailure(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** Run one lifecycle check on a fresh harness; a failure that is not its own is named for it. */
async function lifecycleCase(
  config: AgentEngineConformanceConfig,
  name: string,
  scenario: FakeEngineScenario,
  check: (harness: Harness) => Promise<void>,
): Promise<void> {
  const harness = await config.open(scenario);
  try {
    await check(harness);
  } catch (error) {
    if (isConformanceFailure(error)) throw error;
    conformanceFailure(name, describeFailure(error));
  } finally {
    await harness.cleanup();
  }
}

/** A stopped session refuses a new turn, and an interrupt of its old turn is a no-op, not an error. */
async function expectStopped(
  name: string,
  session: AgentEngineSession,
  turn: { interrupt(): Promise<void>; respond(interactionId: string): Promise<void> },
  asked: string,
): Promise<void> {
  if (!(await rejects(settlesInTime(name, 'respond after the stop', turn.respond(asked)))))
    conformanceFailure(name, 'an answer was accepted after the session stopped');
  if (await rejects(settlesInTime(name, 'interrupt after the stop', turn.interrupt())))
    conformanceFailure(name, 'interrupt after the session stopped rejected; it is a no-op');
  if (
    !(await rejects(settlesInTime(name, 'startTurn after the stop', startTextTurn(session))))
  )
    conformanceFailure(name, 'a turn was started after the session stopped');
}

/** `open` given an already aborted signal refuses with that signal's reason. */
async function checkOpenAborted(config: AgentEngineConformanceConfig): Promise<void> {
  const name = 'open with an aborted signal';
  await lifecycleCase(config, name, config.scenarios.text('never sent'), async (harness) => {
    const reason = callerAbort(name);
    const controller = new AbortController();
    controller.abort(reason);
    const opened = await settlesInTime(
      name,
      'open',
      outcomeOf(
        harness.driver.open({
          profile: harness.profile,
          cwd: harness.cwd,
          signal: controller.signal,
        }),
      ),
    );
    if (opened.ok) {
      await opened.value.close();
      conformanceFailure(name, 'open resolved although its signal was already aborted');
    }
    if (opened.error !== reason)
      conformanceFailure(
        name,
        `open rejected with ${describeFailure(opened.error)}, not with the signal's reason`,
      );
  });
}

/**
 * A signal aborted while `open` runs — from the startup observer, the one moment a caller can
 * name — refuses the open with the signal's reason, and the observer hears nothing afterwards.
 * A driver that reports no startup phase before it resolves gives no such moment and is not asked.
 */
async function checkAbortDuringOpen(config: AgentEngineConformanceConfig): Promise<void> {
  const name = 'abort during open';
  await lifecycleCase(config, name, config.scenarios.text('never sent'), async (harness) => {
    const reason = callerAbort(name);
    const controller = new AbortController();
    const phases: ExecutorStartupPhase[] = [];
    const opened = await settlesInTime(
      name,
      'open',
      outcomeOf(
        harness.driver.open({
          profile: harness.profile,
          cwd: harness.cwd,
          signal: controller.signal,
          onStartupPhase(phase) {
            phases.push(phase);
            controller.abort(reason);
          },
        }),
      ),
    );
    if (opened.ok) {
      await settlesInTime(name, 'close', opened.value.close());
      if (phases.length === 0) return;
      conformanceFailure(name, 'open resolved although its signal aborted while it started');
    }
    if (opened.error !== reason)
      conformanceFailure(
        name,
        `open rejected with ${describeFailure(opened.error)}, not with the signal's reason`,
      );
    // The abort came with the first phase: any other, before the refusal or right after it, was
    // told to a caller who had already stopped the open.
    await new Promise((resolve) => setImmediate(resolve));
    if (phases.length > 1)
      conformanceFailure(
        name,
        `the startup observer was called after the abort (${phases.slice(1).join(', ')})`,
      );
  });
}

/**
 * The caller's abort while a turn holds a request fails the turn's stream with the caller's
 * reason, and from then on `respond` and `startTurn` refuse with it; `close()` still closes.
 */
async function checkAbortInTurn(config: AgentEngineConformanceConfig): Promise<void> {
  const name = 'abort in a turn';
  await lifecycleCase(config, name, config.scenarios.approval(), async (harness) => {
    const reason = callerAbort(name);
    const controller = new AbortController();
    const session = await harness.driver.open({
      profile: harness.profile,
      cwd: harness.cwd,
      signal: controller.signal,
    });
    try {
      const running = await startTextTurn(session);
      let asked: string | undefined;
      const stream = await settlesInTime(
        name,
        "the aborted turn's stream",
        outcomeOf(
          collectTurn(running, async (delta) => {
            if (asked !== undefined || delta.type !== 'request') return;
            asked = delta.interactionId;
            controller.abort(reason);
          }),
        ),
      );
      if (asked === undefined) conformanceFailure(name, 'no request was emitted to abort at');
      if (stream.ok) conformanceFailure(name, 'the aborted turn ended as if it had completed');
      if (stream.error !== reason)
        conformanceFailure(
          name,
          `the turn failed with ${describeFailure(stream.error)}, not with the signal's reason`,
        );
      const answered = await settlesInTime(
        name,
        'respond after the abort',
        outcomeOf(running.respond(asked, { kind: 'approve' })),
      );
      if (answered.ok) conformanceFailure(name, 'an answer was accepted after the abort');
      if (answered.error !== reason)
        conformanceFailure(
          name,
          `respond rejected with ${describeFailure(answered.error)}, not with the signal's reason`,
        );
      if (await rejects(settlesInTime(name, 'interrupt after the abort', running.interrupt())))
        conformanceFailure(name, 'interrupt after the abort rejected; it is a no-op');
      const restarted = await settlesInTime(
        name,
        'startTurn after the abort',
        outcomeOf(startTextTurn(session)),
      );
      if (restarted.ok) conformanceFailure(name, 'a turn was started after the abort');
      if (restarted.error !== reason)
        conformanceFailure(
          name,
          `startTurn rejected with ${describeFailure(restarted.error)}, not with the signal's reason`,
        );
    } finally {
      await settlesInTime(name, 'close after the abort', session.close());
    }
  });
}

/** Once a turn ended, `interrupt` has nothing to stop: it resolves, and the session closes as usual. */
async function checkInterruptAfterEnd(config: AgentEngineConformanceConfig): Promise<void> {
  const name = 'interrupt after the end';
  await lifecycleCase(config, name, config.scenarios.text('done'), async (harness) => {
    const session = await harness.driver.open({ profile: harness.profile, cwd: harness.cwd });
    let interrupt: (() => Promise<void>) | undefined;
    const expectNoOp = async (when: string) => {
      if (interrupt === undefined) return;
      const interrupted = await settlesInTime(
        name,
        `interrupt ${when}`,
        outcomeOf(interrupt()),
      );
      if (!interrupted.ok)
        conformanceFailure(
          name,
          `interrupt ${when} rejected with ${describeFailure(interrupted.error)}; it is a no-op`,
        );
    };
    try {
      const running = await startTextTurn(session);
      const deltas = await settlesInTime(name, "the turn's stream", collectTurn(running));
      if (deltas.at(-1)?.type !== 'turn-end')
        conformanceFailure(name, 'the turn did not end with turn-end');
      interrupt = () => running.interrupt();
      await expectNoOp('of an ended turn');
    } finally {
      await settlesInTime(name, 'close', session.close());
    }
    await expectNoOp('of an ended turn of a closed session');
  });
}

/**
 * `close()` while a turn holds a request: two concurrent calls and a third all resolve, the
 * turn's stream fails instead of hanging or ending as completed, `respond` and `startTurn` refuse,
 * `interrupt` is a no-op, and the startup observer hears nothing after the close.
 */
async function checkClose(config: AgentEngineConformanceConfig): Promise<void> {
  const name = 'close in a turn';
  await lifecycleCase(config, name, config.scenarios.approval(), async (harness) => {
    const phases: ExecutorStartupPhase[] = [];
    const session = await harness.driver.open({
      profile: harness.profile,
      cwd: harness.cwd,
      onStartupPhase: (phase) => {
        phases.push(phase);
      },
    });
    let heardAtClose = 0;
    try {
      const running = await startTextTurn(session);
      let asked: string | undefined;
      const stream = await settlesInTime(
        name,
        "the closed turn's stream",
        outcomeOf(
          collectTurn(running, async (delta) => {
            if (asked !== undefined || delta.type !== 'request') return;
            asked = delta.interactionId;
            heardAtClose = phases.length;
            const closed = await settlesInTime(
              name,
              'two concurrent close() calls',
              outcomeOf(Promise.all([session.close(), session.close()])),
            );
            if (!closed.ok)
              conformanceFailure(
                name,
                `close() rejected with ${describeFailure(closed.error)}`,
              );
          }),
        ),
      );
      if (asked === undefined) conformanceFailure(name, 'no request was emitted to close at');
      if (stream.ok) conformanceFailure(name, 'the closed turn ended as if it had completed');
      if (isConformanceFailure(stream.error)) throw stream.error;
      await expectStopped(
        name,
        session,
        {
          interrupt: () => running.interrupt(),
          respond: (id) => running.respond(id, { kind: 'approve' }),
        },
        asked,
      );
    } catch (error) {
      // The check already failed: the session is still closed, and its failure stays the one told.
      await rejects(settlesInTime(name, 'close', session.close()));
      throw error;
    }
    const again = await settlesInTime(name, 'close() again', outcomeOf(session.close()));
    if (!again.ok)
      conformanceFailure(
        name,
        `a repeated close() rejected with ${describeFailure(again.error)}`,
      );
    if (phases.length !== heardAtClose)
      conformanceFailure(
        name,
        `the startup observer was called after close (${phases.slice(heardAtClose).join(', ')})`,
      );
  });
}

/**
 * The life of a session, for every driver alike: `open` given an aborted signal, or one aborted
 * while it starts, refuses with the caller's reason; an abort in a turn fails its stream with
 * that reason and refuses `respond` and `startTurn` with it; `interrupt` after the turn's end, an
 * abort or a close is a no-op; `close()` in a turn fails the turn, is one close however often it
 * is called, and leaves the startup observer silent. Every wait is bounded, so a driver that hangs
 * fails the check by name.
 */
export async function checkAbortAndTeardown(
  config: AgentEngineConformanceConfig,
): Promise<void> {
  await checkOpenAborted(config);
  await checkAbortDuringOpen(config);
  await checkAbortInTurn(config);
  await checkInterruptAfterEnd(config);
  await checkClose(config);
}
