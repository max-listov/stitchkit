import { describe, expect, test } from 'bun:test';
import {
  bindProcessSignals,
  type ProcessSignalName,
  type ProcessSignalsErrorPhase,
  type SignalSource,
} from '../src/server/process-signals';
import type { ShutdownOptions, ShutdownResult } from '../src/server/shutdown';

const cleanResult: ShutdownResult = {
  outcome: 'clean',
  acceptedRequests: 0,
  completedRequests: 0,
  pendingRequests: 0,
  pendingWebSockets: 0,
  pendingRequestsAtForce: 0,
  pendingWebSocketsAtForce: 0,
  abortedRequests: 0,
  forcedWebSockets: 0,
  durationMs: 1,
};

/** Yield past the microtask that ends the first signal's delivery turn. */
const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** A signal source under the test's control, plus the raises it was asked for. */
function createSource(options: { restorable?: boolean } = {}) {
  const listeners = new Map<ProcessSignalName, Set<() => void>>();
  const raised: ProcessSignalName[] = [];
  const source: SignalSource = {
    on: (signal, handler) => {
      const set = listeners.get(signal) ?? new Set();
      set.add(handler);
      listeners.set(signal, set);
    },
    off: (signal, handler) => {
      listeners.get(signal)?.delete(handler);
    },
    raiseDefault: (signal) => {
      raised.push(signal);
      return options.restorable ?? true;
    },
  };
  return {
    source,
    raised,
    listenerCount: (signal: ProcessSignalName) => listeners.get(signal)?.size ?? 0,
    send: (signal: ProcessSignalName) => {
      for (const handler of [...(listeners.get(signal) ?? [])]) handler();
    },
  };
}

/**
 * A handle whose shutdown resolves only when the test releases it. `release` /
 * `fail` await the call itself, so a test never races the microtask in which
 * `bindProcessSignals` reaches `shutdown()`.
 */
function createHandle() {
  const calls: ShutdownOptions[] = [];
  let release: (result: ShutdownResult) => void = () => undefined;
  let fail: (error: unknown) => void = () => undefined;
  let markCalled: () => void = () => undefined;
  const called = new Promise<void>((resolve) => {
    markCalled = resolve;
  });
  const handle = {
    shutdown: (options?: ShutdownOptions) => {
      calls.push(options ?? {});
      markCalled();
      return new Promise<ShutdownResult>((resolve, reject) => {
        release = resolve;
        fail = reject;
      });
    },
  };
  return {
    handle,
    calls,
    called,
    release: async (result: ShutdownResult = cleanResult) => {
      await called;
      release(result);
    },
    fail: async (error: unknown) => {
      await called;
      fail(error);
    },
  };
}

describe('bindProcessSignals', () => {
  test('forces a shutdown that is already in flight', async () => {
    const { source, send } = createSource();
    const { handle, calls, called, release } = createHandle();
    const phases: string[] = [];

    const binding = bindProcessSignals(handle, {
      signalSource: source,
      onRepeatedSignal: (signal, phase) => phases.push(`${signal}:${phase}`),
    });

    send('SIGTERM');
    await called;
    // The chain is genuinely running: `shutdown()` was entered with a live signal.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.signal?.aborted).toBe(false);

    await nextTurn();
    send('SIGINT');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.signal?.aborted).toBe(true);
    expect(phases).toEqual(['SIGINT:force']);

    await release();
    await expect(binding.promise).resolves.toEqual(cleanResult);
  });

  test('a signal during asynchronous preparation still forces the chain', async () => {
    const { source, send } = createSource();
    const { handle, calls, release } = createHandle();
    let releasePreparation: () => void = () => undefined;
    const prepared = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });

    const binding = bindProcessSignals(handle, {
      signalSource: source,
      onShutdown: () => prepared,
    });

    send('SIGTERM');
    await nextTurn();
    // `shutdown()` has not been called yet — preparation is still running.
    expect(calls).toHaveLength(0);

    send('SIGTERM');
    releasePreparation();
    await nextTurn();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.signal?.aborted).toBe(true);

    await release();
    await binding.promise;
  });

  test('two signals in the first delivery turn are one press, not a force', async () => {
    const { source, send } = createSource();
    const { handle, calls, called, release } = createHandle();
    const phases: string[] = [];

    const binding = bindProcessSignals(handle, {
      signalSource: source,
      onRepeatedSignal: (_signal, phase) => phases.push(phase),
    });

    // A supervisor that sends both at once must not collapse the grace period.
    send('SIGINT');
    send('SIGTERM');
    await called;

    expect(calls).toHaveLength(1);
    expect(calls[0]?.signal?.aborted).toBe(false);
    expect(phases).toEqual([]);

    await release();
    await binding.promise;
  });

  test('duplicate signal names register one listener', () => {
    const { source, listenerCount } = createSource();
    const { handle } = createHandle();

    bindProcessSignals(handle, {
      signalSource: source,
      signals: ['SIGTERM', 'SIGTERM'],
    });
    expect(listenerCount('SIGTERM')).toBe(1);
  });

  test('a third signal restores the default disposition instead of doing nothing', async () => {
    const { source, send, raised, listenerCount } = createSource();
    const { handle, called, release } = createHandle();
    const phases: string[] = [];

    const binding = bindProcessSignals(handle, {
      signalSource: source,
      onRepeatedSignal: (_signal, phase) => phases.push(phase),
    });

    send('SIGINT');
    await called;
    await nextTurn();
    send('SIGINT');
    send('SIGINT');

    expect(phases).toEqual(['force', 'escalate']);
    expect(raised).toEqual(['SIGINT']);
    expect(listenerCount('SIGINT')).toBe(0);

    await release();
    await binding.promise;
  });

  test('an escalation that cannot restore the default reports it', async () => {
    const { source, send } = createSource({ restorable: false });
    const { handle, called, release } = createHandle();
    const blocked: ProcessSignalName[] = [];

    const binding = bindProcessSignals(handle, {
      signalSource: source,
      onEscalationBlocked: (signal) => blocked.push(signal),
    });

    send('SIGINT');
    await called;
    await nextTurn();
    send('SIGINT');
    send('SIGINT');

    // Another listener still owns the signal — the process will survive, and the
    // application is told instead of being promised a kill that never happens.
    expect(blocked).toEqual(['SIGINT']);

    await release();
    await binding.promise;
  });

  test('a rejected shutdown reaches onError and does not go unhandled', async () => {
    const { source, send } = createSource();
    const { handle, fail } = createHandle();
    const seen: [ProcessSignalsErrorPhase, unknown][] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on('unhandledRejection', onUnhandled);

    try {
      const binding = bindProcessSignals(handle, {
        signalSource: source,
        onError: (phase, error) => void seen.push([phase, error]),
      });

      send('SIGTERM');
      const failure = new Error('drain failed');
      await fail(failure);
      await expect(binding.promise).rejects.toThrow('drain failed');
      expect(seen).toEqual([['shutdown', failure]]);

      await nextTurn();
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('a failing onShutdown is reported but never cancels the shutdown', async () => {
    const { source, send } = createSource();
    const { handle, calls, called, release } = createHandle();
    const seen: ProcessSignalsErrorPhase[] = [];

    const binding = bindProcessSignals(handle, {
      signalSource: source,
      onShutdown: () => {
        throw new Error('worker stop failed');
      },
      onError: (phase) => void seen.push(phase),
    });

    send('SIGTERM');
    await called;

    // The server must not be left listening because preparation failed.
    expect(calls).toHaveLength(1);
    expect(seen).toEqual(['prepare']);

    await release();
    await expect(binding.promise).resolves.toEqual(cleanResult);
  });

  test('a failing onComplete keeps the chain resolved and reports separately', async () => {
    const { source, send } = createSource();
    const { handle, release } = createHandle();
    const seen: ProcessSignalsErrorPhase[] = [];

    const binding = bindProcessSignals(handle, {
      signalSource: source,
      onComplete: () => {
        throw new Error('db close failed');
      },
      onError: (phase) => void seen.push(phase),
    });

    send('SIGTERM');
    await release();

    // The transport really did shut down — reporting it as a failed shutdown
    // would be a lie, and dropping the callback's error would hide a real one.
    await expect(binding.promise).resolves.toEqual(cleanResult);
    await nextTurn();
    expect(seen).toEqual(['complete']);
  });

  test('a throwing onRepeatedSignal cannot swallow the force', async () => {
    const { source, send } = createSource();
    const { handle, calls, called, release } = createHandle();
    const seen: ProcessSignalsErrorPhase[] = [];

    const binding = bindProcessSignals(handle, {
      signalSource: source,
      onRepeatedSignal: () => {
        throw new Error('logger blew up');
      },
      onError: (phase) => void seen.push(phase),
    });

    send('SIGTERM');
    await called;
    await nextTurn();
    expect(() => send('SIGINT')).not.toThrow();

    expect(calls[0]?.signal?.aborted).toBe(true);
    expect(seen).toEqual(['shutdown']);

    await release();
    await binding.promise;
  });

  test('a re-entering callback finds the machine already advanced', async () => {
    const { source, send } = createSource();
    const { handle, calls, called, release } = createHandle();
    let forces = 0;

    const binding = bindProcessSignals(handle, {
      signalSource: source,
      onRepeatedSignal: (_signal, phase) => {
        if (phase !== 'force') return;
        forces += 1;
        // Deliver another signal from inside the callback: state was mutated
        // before user code ran, so this must not recurse into another force.
        if (forces < 3) send('SIGTERM');
      },
    });

    send('SIGTERM');
    await called;
    await nextTurn();
    send('SIGTERM');

    expect(forces).toBe(1);
    expect(calls).toHaveLength(1);

    await release();
    await binding.promise;
  });

  test('onShutdown runs before shutdown and onComplete after it', async () => {
    const { source, send } = createSource();
    const { handle, release } = createHandle();
    const order: string[] = [];

    const binding = bindProcessSignals(handle, {
      signalSource: source,
      onShutdown: () => void order.push('prepare'),
      onComplete: () => void order.push('complete'),
    });

    send('SIGINT');
    await Promise.resolve();
    order.push('shutdown-called');
    await release();
    await binding.promise;
    await nextTurn();

    expect(order).toEqual(['prepare', 'shutdown-called', 'complete']);
  });

  test('close removes the listeners, settles the chain and is idempotent', async () => {
    const { source, listenerCount } = createSource();
    const { handle } = createHandle();

    const binding = bindProcessSignals(handle, { signalSource: source });
    expect(listenerCount('SIGINT')).toBe(1);
    expect(listenerCount('SIGTERM')).toBe(1);

    binding.close();
    binding.close();
    expect(listenerCount('SIGINT')).toBe(0);
    expect(listenerCount('SIGTERM')).toBe(0);

    // An awaiting application must not hang forever on a binding that was closed
    // before any signal arrived.
    await expect(binding.promise).resolves.toBeUndefined();
  });

  test('binding the same handle twice throws instead of dropping the force path', () => {
    const { source } = createSource();
    const { handle } = createHandle();

    const binding = bindProcessSignals(handle, { signalSource: source });
    expect(() => bindProcessSignals(handle, { signalSource: source })).toThrow(
      '[stitchkit] bindProcessSignals: this server is already bound',
    );

    // Closing an idle binding releases the handle for a new one.
    binding.close();
    expect(() => bindProcessSignals(handle, { signalSource: source })).not.toThrow();
  });

  test('closing a running binding does NOT release the handle for a second one', async () => {
    const { source, send } = createSource();
    const { handle, called, release } = createHandle();

    const binding = bindProcessSignals(handle, { signalSource: source });
    send('SIGTERM');
    await called;

    binding.close();
    // A second binding here would hand `shutdown()` a fresh AbortSignal that the
    // running chain ignores: a dead force path reporting someone else's result.
    expect(() => bindProcessSignals(handle, { signalSource: source })).toThrow(
      'this server is already bound',
    );

    await release();
    await binding.promise;
  });

  test('forwards the declared budgets and owns the abort signal', async () => {
    const { source, send } = createSource();
    const { handle, calls, called, release } = createHandle();

    const binding = bindProcessSignals(handle, {
      signalSource: source,
      shutdown: { gracePeriodMs: 1_000, forceTimeoutMs: 250 },
    });
    send('SIGTERM');
    await called;

    expect(calls[0]?.gracePeriodMs).toBe(1_000);
    expect(calls[0]?.forceTimeoutMs).toBe(250);
    expect(calls[0]?.signal).toBeDefined();

    await release();
    await binding.promise;
  });

  test('registers only the signals it was given', () => {
    const { source, listenerCount } = createSource();
    const { handle } = createHandle();

    bindProcessSignals(handle, { signalSource: source, signals: ['SIGHUP'] });
    expect(listenerCount('SIGHUP')).toBe(1);
    expect(listenerCount('SIGINT')).toBe(0);
  });

  test('never calls process.exit — the escalation path re-raises instead', async () => {
    const source = await Bun.file(
      `${import.meta.dir}/../src/server/process-signals.ts`,
    ).text();
    expect(source).not.toInclude('process.exit(');
    // The only way this module can end a process is by handing the signal back
    // to its default disposition.
    expect(source).toInclude('process.kill(process.pid, signal)');
  });
});
