import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  type ExecutorDelta,
  projectExecutorDeltas,
} from '../../src/entrypoints/agent-executor';
import { createCodexDriver } from '../../src/entrypoints/agent-executor/codex';
import { reapAfterEachTest, trackPidFile } from '../support/process-reaper';

reapAfterEachTest();

const FAKE_SHARED_CODEX = resolve(import.meta.dir, '../fixtures/fake-codex-shared-server.ts');

async function collectTurn(
  turn: { deltas: AsyncIterable<ExecutorDelta> },
  onDelta?: (delta: ExecutorDelta) => Promise<void>,
): Promise<ExecutorDelta[]> {
  const deltas: ExecutorDelta[] = [];
  for await (const delta of turn.deltas) {
    deltas.push(delta);
    await onDelta?.(delta);
  }
  return deltas;
}

describe('Codex shared multi-thread server (ADR 0329)', () => {
  test('multiplexes concurrent threads with interleaved approvals, thread/unsubscribe on close, and sibling survival', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-shared-'));
    const home = join(root, 'home');
    trackPidFile(join(home, 'shared-pid.txt'));
    const startupPhases: string[] = [];
    const driver = createCodexDriver({
      executable: process.execPath,
      prefixArgs: [FAKE_SHARED_CODEX],
      ambient: { PATH: process.env.PATH, HOME: root },
    });
    expect(driver.capabilities.multiThreadPerProcess).toBe(false);

    const server = await driver.openSharedServer({
      profile: { profileId: 'p-shared', engine: 'codex', home },
      cwd: root,
      maxThreads: 2,
      onStartupPhase: (phase) => startupPhases.push(phase),
    });
    try {
      expect(server.capabilities.multiThreadPerProcess).toBe(true);
      expect(server.maxThreads).toBe(2);
      expect(server.providerPid).toBeGreaterThan(0);
      expect(startupPhases).toEqual(['spawning', 'initializing']);

      const threadA = await server.openThread({ cwd: root });
      const threadB = await server.openThread({ cwd: root });
      expect(threadA.nativeThreadId).not.toBe(threadB.nativeThreadId);
      expect(threadA.providerPid).toBe(server.providerPid);
      expect(threadB.providerPid).toBe(server.providerPid);
      expect(server.activeThreadCount).toBe(2);

      // maxThreads + 1 is refused with RangeError before any RPC.
      await expect(server.openThread({ cwd: root })).rejects.toThrow(RangeError);

      // Run two concurrent approval-gated turns on the two threads without cross-leaking deltas or interactionIds.
      const turnA = await threadA.startTurn({
        turnId: 'tA',
        clientId: 'cA',
        input: [{ type: 'text', text: 'NEEDS_APPROVAL alpha' }],
      });
      const turnB = await threadB.startTurn({
        turnId: 'tB',
        clientId: 'cB',
        input: [{ type: 'text', text: 'NEEDS_APPROVAL beta' }],
      });

      const [deltasA, deltasB] = await Promise.all([
        collectTurn(turnA, async (delta) => {
          if (delta.type === 'request') {
            expect(delta.turnId).toBe('tA');
            await turnA.respond(delta.interactionId, { kind: 'approve' });
          }
        }),
        collectTurn(turnB, async (delta) => {
          if (delta.type === 'request') {
            expect(delta.turnId).toBe('tB');
            await turnB.respond(delta.interactionId, { kind: 'deny', message: 'nope' });
          }
        }),
      ]);

      const partsA = projectExecutorDeltas(deltasA);
      const partsB = projectExecutorDeltas(deltasB);
      expect(partsA).toEqual([
        expect.objectContaining({ type: 'tool-approval-request', callId: 'cmd-turn-1' }),
        { type: 'text', text: `${threadA.nativeThreadId}:NEEDS_APPROVAL alpha:accept` },
      ]);
      expect(partsB).toEqual([
        expect.objectContaining({ type: 'tool-approval-request', callId: 'cmd-turn-2' }),
        { type: 'text', text: `${threadB.nativeThreadId}:NEEDS_APPROVAL beta:decline` },
      ]);

      // Closing threadA calls thread/unsubscribe and frees a slot while threadB stays alive on the same process.
      await threadA.close();
      expect(server.activeThreadCount).toBe(1);
      const unsubscribed = readFileSync(join(home, 'unsubscribed.jsonl'), 'utf8');
      expect(unsubscribed).toContain(threadA.nativeThreadId);

      const turnB2 = await threadB.startTurn({
        turnId: 'tB2',
        clientId: 'cB2',
        input: [{ type: 'text', text: 'EMIT_RATE_LIMIT still alive' }],
      });
      expect(projectExecutorDeltas(await collectTurn(turnB2))).toEqual([
        { type: 'text', text: `${threadB.nativeThreadId}:EMIT_RATE_LIMIT still alive` },
      ]);

      // Global account/rateLimits/updated updates shared driver limits.
      const status = await driver.status({ profileId: 'p-shared', engine: 'codex', home });
      expect(status.planLimits?.answer).toBe('known');
      expect(status.planLimits?.windows[0]?.usedPercent).toBe(42);

      // Freed slot allows opening a third thread.
      const threadC = await server.openThread({ cwd: root });
      expect(server.activeThreadCount).toBe(2);
      await threadC.close();
      await threadB.close();
      expect(server.activeThreadCount).toBe(0);
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('aborts mid-open and post-open cleanly without leaking slots, listeners, or sending duplicate thread/resume', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-shared-abort-'));
    const home = join(root, 'home');
    trackPidFile(join(home, 'shared-pid.txt'));
    const serverAbort = new AbortController();
    const driver = createCodexDriver({
      executable: process.execPath,
      prefixArgs: [FAKE_SHARED_CODEX],
      ambient: { PATH: process.env.PATH, HOME: root },
    });

    const server = await driver.openSharedServer({
      profile: {
        profileId: 'p-abort',
        engine: 'codex',
        home,
        env: { FAKE_SHARED_START_DELAY_MS: '80' },
      },
      cwd: root,
      maxThreads: 1,
      signal: serverAbort.signal,
    });
    try {
      // 1) Mid-open abort (without verifyThread) rejects and never leaves a slot in activeThreadCount.
      const midAbort = new AbortController();
      const midPromise = server.openThread({ cwd: root, signal: midAbort.signal });
      setTimeout(() => midAbort.abort(new Error('mid-open cancelled')), 15);
      await expect(midPromise).rejects.toThrow(/mid-open cancelled/i);
      expect(server.activeThreadCount).toBe(0);

      // Wait briefly for the delayed thread/start reply so disposeLate unsubscribes it cleanly.
      await new Promise((resolve) => setTimeout(resolve, 110));
      expect(server.activeThreadCount).toBe(0);

      // 2) Open one thread (fills maxThreads: 1), then verify duplicate nativeThreadId fails BEFORE thread/resume.
      const postAbort = new AbortController();
      const thread1 = await server.openThread({ cwd: root, signal: postAbort.signal });
      expect(server.activeThreadCount).toBe(1);
      await expect(
        server.openThread({ cwd: root, nativeThreadId: thread1.nativeThreadId }),
      ).rejects.toThrow(/already open/i);
      expect(existsSync(join(home, 'resumed.jsonl'))).toBe(false);

      // 3) Post-open abort frees slot, unsubscribes thread1, and allows immediate slot reuse.
      postAbort.abort(new Error('thread1 aborted'));
      expect(server.activeThreadCount).toBe(0);
      const thread2 = await server.openThread({ cwd: root });
      expect(server.activeThreadCount).toBe(1);
      await thread2.close();
      expect(server.activeThreadCount).toBe(0);

      // Wait for async best-effort unsubscribe write.
      await new Promise((resolve) => setTimeout(resolve, 40));
      const unsubscribed = readFileSync(join(home, 'unsubscribed.jsonl'), 'utf8');
      expect(unsubscribed).toContain(thread1.nativeThreadId);

      // 4) Aborting the server signal terminates openSharedServer cleanly.
      serverAbort.abort(new Error('server cancelled'));
      await expect(server.openThread({ cwd: root })).rejects.toThrow();
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('process crash fails all active threads, cleans pending requests, and notifies onDisconnect once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-shared-crash-'));
    const home = join(root, 'home');
    trackPidFile(join(home, 'shared-pid.txt'));
    const disconnects: Error[] = [];
    const driver = createCodexDriver({
      executable: process.execPath,
      prefixArgs: [FAKE_SHARED_CODEX],
      ambient: { PATH: process.env.PATH, HOME: root },
      onDisconnect: (err) => disconnects.push(err),
    });

    const server = await driver.openSharedServer({
      profile: { profileId: 'p-crash', engine: 'codex', home },
      cwd: root,
    });
    try {
      const threadA = await server.openThread({ cwd: root });
      const threadB = await server.openThread({ cwd: root });
      const turnA = await threadA.startTurn({
        turnId: 't-wait',
        clientId: 'c-wait',
        input: [{ type: 'text', text: 'NEEDS_APPROVAL hold' }],
      });
      const turnB = await threadB.startTurn({
        turnId: 't-boom',
        clientId: 'c-boom',
        input: [{ type: 'text', text: 'CRASH_SERVER' }],
      });

      const [resA, resB] = await Promise.allSettled([collectTurn(turnA), collectTurn(turnB)]);
      expect(resA.status).toBe('rejected');
      expect(resB.status).toBe('rejected');
      expect(disconnects.length).toBe(1);
      expect(server.activeThreadCount).toBe(0);
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('negative controls: refuses unix-listen, unix-connect, and invalid maxThreads before spawning', async () => {
    const listenDriver = createCodexDriver({
      transport: { kind: 'unix-listen', socketPath: '/tmp/unused-codex-shared.sock' },
    });
    await expect(
      listenDriver.openSharedServer({
        profile: { profileId: 'p', engine: 'codex', home: '/tmp' },
        cwd: '/tmp',
      }),
    ).rejects.toThrow(TypeError);

    const connectDriver = createCodexDriver({
      transport: { kind: 'unix-connect', socketPath: '/tmp/unused-codex-shared.sock' },
    });
    await expect(
      connectDriver.openSharedServer({
        profile: { profileId: 'p', engine: 'codex', home: '/tmp' },
        cwd: '/tmp',
      }),
    ).rejects.toThrow(TypeError);

    const stdioDriver = createCodexDriver();
    await expect(
      stdioDriver.openSharedServer({
        profile: { profileId: 'p', engine: 'codex', home: '/tmp' },
        cwd: '/tmp',
        maxThreads: 0,
      }),
    ).rejects.toThrow();
    await expect(
      stdioDriver.openSharedServer({
        profile: { profileId: 'p', engine: 'codex', home: '/tmp' },
        cwd: '/tmp',
        maxThreads: 257,
      }),
    ).rejects.toThrow(RangeError);
  });

  test('exposes userAgent, drains local approvals on server/cross-thread interruptTurn, supports serverRequestDelivery all, and aborts in-flight openControls.steerTurn', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-shared-controls-'));
    const home = join(root, 'home');
    trackPidFile(join(home, 'shared-pid.txt'));
    const observedRequests: Array<{
      interactionId: string;
      requestId: string | number;
      duringActiveTurn: boolean;
      threadId: unknown;
      respond: (reply: { kind: 'approve' }) => Promise<void>;
    }> = [];

    const driver = createCodexDriver({
      executable: process.execPath,
      prefixArgs: [FAKE_SHARED_CODEX],
      ambient: { PATH: process.env.PATH, HOME: root },
      serverRequestDelivery: 'all',
      onServerRequest: (ev) => {
        const paramsObj =
          typeof ev.params === 'object' && ev.params !== null ? ev.params : undefined;
        observedRequests.push({
          interactionId: ev.interactionId,
          requestId: ev.requestId,
          duringActiveTurn: ev.duringActiveTurn,
          threadId: paramsObj !== undefined ? Reflect.get(paramsObj, 'threadId') : undefined,
          respond: (reply) => ev.respond(reply),
        });
      },
    });

    const server = await driver.openSharedServer({
      profile: { profileId: 'p-shared-ctrl', engine: 'codex', home },
      cwd: root,
      maxThreads: 4,
    });
    try {
      expect(server.userAgent).toBe('fake-codex-shared');
      const threadA = await server.openThread({ cwd: root });
      const threadB = await server.openThread({ cwd: root });
      const threadC = await server.openThread({ cwd: root });
      expect(threadA.userAgent).toBe('fake-codex-shared');

      // Start approval-gated turns on A, B, and C.
      const turnA = await threadA.startTurn({
        turnId: 'tA-int',
        clientId: 'cA-int',
        input: [{ type: 'text', text: 'NEEDS_APPROVAL alpha' }],
      });
      const turnB = await threadB.startTurn({
        turnId: 'tB-int',
        clientId: 'cB-int',
        input: [{ type: 'text', text: 'NEEDS_APPROVAL beta' }],
      });
      const turnC = await threadC.startTurn({
        turnId: 'tC-obs',
        clientId: 'cC-obs',
        input: [{ type: 'text', text: 'NEEDS_APPROVAL gamma' }],
      });
      expect(turnA.nativeTurnId).toBe('turn-1');
      expect(turnB.nativeTurnId).toBe('turn-2');
      expect(turnC.nativeTurnId).toBe('turn-3');

      for (let i = 0; i < 40 && observedRequests.length < 3; i += 1) await Bun.sleep(10);
      expect(observedRequests).toHaveLength(3);
      for (const req of observedRequests) {
        expect(req.duringActiveTurn).toBe(true);
        expect(typeof req.requestId).toBe('number');
      }

      // 1) Server-level interruptTurn drains threadA's local pending approval before RPC.
      await server.interruptTurn({
        threadId: threadA.nativeThreadId,
        turnId: turnA.nativeTurnId,
      });
      // 2) Cross-thread threadA.interruptTurn({ threadId: threadB }) drains threadB's pending approval!
      await threadA.interruptTurn({
        threadId: threadB.nativeThreadId,
        turnId: turnB.nativeTurnId,
      });
      // 3) Answer threadC through onServerRequest.respond; second answer on turnC fails with TypeError.
      const reqC = observedRequests.find((r) => r.threadId === threadC.nativeThreadId);
      if (reqC === undefined) throw new Error('expected request for threadC');
      await reqC.respond({ kind: 'approve' });
      await expect(turnC.respond(reqC.interactionId, { kind: 'approve' })).rejects.toThrow(
        TypeError,
      );

      const [deltasA, deltasB, deltasC] = await Promise.all([
        collectTurn(turnA),
        collectTurn(turnB),
        collectTurn(turnC),
      ]);
      expect(deltasA.some((d) => d.type === 'turn-end' && d.outcome === 'interrupted')).toBe(
        true,
      );
      expect(deltasB.some((d) => d.type === 'turn-end' && d.outcome === 'interrupted')).toBe(
        true,
      );
      expect(projectExecutorDeltas(deltasC)).toContainEqual({
        type: 'text',
        text: `${threadC.nativeThreadId}:NEEDS_APPROVAL gamma:accept`,
      });

      const responses = readFileSync(join(home, 'responses.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(responses.filter((r) => r.result?.decision === 'cancel')).toHaveLength(2);
      const interrupts = readFileSync(join(home, 'turn-interrupt.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(interrupts).toEqual([
        { threadId: threadA.nativeThreadId, turnId: turnA.nativeTurnId },
        { threadId: threadB.nativeThreadId, turnId: turnB.nativeTurnId },
      ]);

      // Control-plane resumeThread, compactThread, and steerTurn on shared server.
      await server.resumeThread({ threadId: threadA.nativeThreadId });
      await server.compactThread({ threadId: threadA.nativeThreadId });
      expect(
        await server.steerTurn({
          threadId: threadA.nativeThreadId,
          expectedTurnId: 'ext-shared-turn',
          input: [{ type: 'text', text: 'nudge' }],
        }),
      ).toEqual({ turnId: 'ext-shared-turn' });
      expect(readFileSync(join(home, 'resumed.jsonl'), 'utf8')).toContain(
        threadA.nativeThreadId,
      );
      expect(readFileSync(join(home, 'thread-compact.jsonl'), 'utf8')).toContain(
        threadA.nativeThreadId,
      );
      expect(readFileSync(join(home, 'turn-steer.jsonl'), 'utf8')).toContain(
        'ext-shared-turn',
      );

      await threadC.close();
      await threadB.close();
      await threadA.close();
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }

    // 4) Per-attempt openControls in openThread binds steerTurn resolveFile to threadAbort.signal.
    const abortRoot = mkdtempSync(join(tmpdir(), 'codex-shared-open-ctrl-'));
    const abortHome = join(abortRoot, 'home');
    trackPidFile(join(abortHome, 'shared-pid.txt'));
    let steerCalledAfterAbort = false;
    let releaseAbortResolveFile: (() => void) | undefined;
    const abortResolveGate = new Promise<void>((resolve) => {
      releaseAbortResolveFile = resolve;
    });
    const abortDriver = createCodexDriver({
      executable: process.execPath,
      prefixArgs: [FAKE_SHARED_CODEX],
      ambient: { PATH: process.env.PATH, HOME: abortRoot },
      resolveFile: async () => {
        await abortResolveGate;
        return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      },
      prepareThread: async ({ controls }) => {
        await controls.steerTurn({
          threadId: 'shared-thread-0',
          expectedTurnId: 't-0',
          input: [{ type: 'file', mediaType: 'image/png', reference: 'wait.png' }],
        });
        steerCalledAfterAbort = true;
        return undefined;
      },
    });
    const abortServer = await abortDriver.openSharedServer({
      profile: { profileId: 'p-open-ctrl', engine: 'codex', home: abortHome },
      cwd: abortRoot,
    });
    try {
      const ac = new AbortController();
      const opening = abortServer.openThread({ cwd: abortRoot, signal: ac.signal });
      setTimeout(() => ac.abort(new Error('cancel openThread prepare')), 25);
      await expect(opening).rejects.toThrow(/cancel openThread prepare/);
      releaseAbortResolveFile?.();
      await Bun.sleep(25);
      expect(steerCalledAfterAbort).toBe(false);
      expect(existsSync(join(abortHome, 'turn-steer.jsonl'))).toBe(false);
      expect(abortServer.activeThreadCount).toBe(0);
    } finally {
      await abortServer.close();
      rmSync(abortRoot, { recursive: true, force: true });
    }
  });
});
