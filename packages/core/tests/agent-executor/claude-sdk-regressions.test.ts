/**
 * Claude SDK leaf regressions: open refused by an abort, a refused turn that leaves the
 * session usable, `canUseTool` answered on abort, crash and turn end with no listener left,
 * and empty tool ids.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  type ClaudeSdkQuery,
  createClaudeSdkDriver,
} from '../../src/agent-executor/claude-sdk/driver';
import { type ExecutorDelta, ExecutorDeltaSchema } from '../../src/agent-executor/vocabulary';
import {
  ambientIn,
  countedSignal,
  drain,
  drainApproving,
  inScratch,
} from '../support/engine-driver-harness';

function sdkDriver(root: string, query: ClaudeSdkQuery) {
  return createClaudeSdkDriver({ sdkVersion: '0.3.330', ambient: ambientIn(root), query });
}

function sdkProfile(root: string) {
  return { profileId: 'p', engine: 'claude-sdk' as const, home: join(root, 'home') };
}

function textTurn(turnId: string, clientId: string = crypto.randomUUID()) {
  return { turnId, clientId, input: [{ type: 'text' as const, text: 'hi' }] };
}

/** A successful result for the prompt record `uuid`. */
function success(uuid: unknown, result = 'ok') {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: 's',
    result,
    uuid,
  };
}

/** A query that, per prompt, asks `canUseTool` with `signal`, lets `during` run, then succeeds. */
function askingQuery(ask: {
  name: string;
  toolUseID: string;
  signal: () => AbortSignal;
  during?: (permission: Promise<unknown> | undefined) => Promise<void>;
}): ClaudeSdkQuery {
  return ({ prompt, options }) => {
    async function* run(): AsyncGenerator<unknown> {
      for await (const message of prompt) {
        const permission = options?.canUseTool?.(
          ask.name,
          { path: 'x' },
          { signal: ask.signal(), toolUseID: ask.toolUseID, requestId: 'r' },
        );
        await ask.during?.(permission);
        yield success(message.uuid);
      }
    }
    const records = run();
    return { [Symbol.asyncIterator]: () => records, interrupt: async () => undefined };
  };
}

describe('Claude SDK open', () => {
  test('an already-aborted signal refuses open with its reason', () =>
    inScratch('sdk-pre-aborted', async (root) => {
      const aborted = new AbortController();
      aborted.abort(new Error('nope'));
      const driver = sdkDriver(root, () => {
        throw new Error('query must not start on an aborted open');
      });
      await expect(
        driver.open({ profile: sdkProfile(root), cwd: root, signal: aborted.signal }),
      ).rejects.toThrow('nope');
    }));

  test('an abort while the transcript is checked rejects open before a query starts', () =>
    inScratch('sdk-abort-open', async (root) => {
      const aborted = new AbortController();
      const driver = sdkDriver(root, () => {
        throw new Error('query must not start on an aborted open');
      });
      const opening = driver.open({
        profile: sdkProfile(root),
        cwd: root,
        nativeThreadId: 'existing-session',
        signal: aborted.signal,
      });
      aborted.abort(new Error('aborted-during-transcript-check'));
      await expect(opening).rejects.toThrow('aborted-during-transcript-check');
    }));
});

describe('Claude SDK caller signal', () => {
  /** A query that takes each prompt and never answers it. */
  const silent: ClaudeSdkQuery = ({ prompt }) => {
    async function* run(): AsyncGenerator<unknown> {
      for await (const _message of prompt) await new Promise<never>(() => undefined);
    }
    const records = run();
    return { [Symbol.asyncIterator]: () => records, interrupt: async () => undefined };
  };

  test("the caller's abort ends the running turn with the caller's reason", () =>
    inScratch('sdk-caller-abort', async (root) => {
      const caller = countedSignal();
      const session = await sdkDriver(root, silent).open({
        profile: sdkProfile(root),
        cwd: root,
        signal: caller.signal,
      });
      const turn = await session.startTurn(textTurn('t'));
      const reason = new Error('the caller stopped');
      caller.abort(reason);
      await expect(drain(turn)).rejects.toBe(reason);
      await session.close();
    }));

  test("a closed session leaves no listener on the caller's signal", () =>
    inScratch('sdk-caller-release', async (root) => {
      const caller = countedSignal();
      const session = await sdkDriver(root, silent).open({
        profile: sdkProfile(root),
        cwd: root,
        signal: caller.signal,
      });
      expect(caller.listeners()).toBe(1);
      await session.close();
      expect(caller.listeners()).toBe(0);
    }));
});

describe('Claude SDK turns', () => {
  test('a turn with an invalid clientId is refused, and the session stays usable', () =>
    inScratch('sdk-invalid-turn', async (root) => {
      const driver = sdkDriver(
        root,
        askingQuery({
          name: 'Write',
          toolUseID: 'u',
          signal: () => new AbortController().signal,
        }),
      );
      const session = await driver.open({ profile: sdkProfile(root), cwd: root });
      try {
        await expect(session.startTurn(textTurn('bad', 'not-a-uuid'))).rejects.toThrow(/UUID/);
        const deltas = await drainApproving(await session.startTurn(textTurn('ok')));
        expect(deltas.at(-1)).toMatchObject({ type: 'turn-end', outcome: 'completed' });
      } finally {
        await session.close();
      }
    }));

  test('canUseTool whose signal aborts is denied with interrupt', () =>
    inScratch('sdk-tool-abort', async (root) => {
      const outcomes: unknown[] = [];
      const controller = new AbortController();
      const driver = sdkDriver(
        root,
        askingQuery({
          name: 'Write',
          toolUseID: 'u',
          signal: () => controller.signal,
          async during(permission) {
            controller.abort();
            outcomes.push(await permission);
          },
        }),
      );
      const session = await driver.open({ profile: sdkProfile(root), cwd: root });
      try {
        await drain(await session.startTurn(textTurn('t')));
        expect(outcomes).toEqual([
          { behavior: 'deny', interrupt: true, message: 'The tool request was aborted' },
        ]);
      } finally {
        await session.close();
      }
    }));

  describe('a normal turn end with canUseTool still waiting', () => {
    let deltas: ExecutorDelta[] = [];
    let outcome: unknown;
    let listeners = -1;

    beforeAll(() =>
      inScratch('sdk-end-drain', async (root) => {
        const counted = countedSignal();
        const driver = sdkDriver(
          root,
          askingQuery({
            name: 'Write',
            toolUseID: 'tu-1',
            signal: () => counted.signal,
            async during(permission) {
              void permission?.then((value) => {
                outcome = value;
              });
              await Bun.sleep(5);
            },
          }),
        );
        const session = await driver.open({ profile: sdkProfile(root), cwd: root });
        try {
          deltas = await drain(await session.startTurn(textTurn('t-end-drain')));
          await Bun.sleep(10);
          // Read before close(): the turn end itself must have drained it.
          listeners = counted.listeners();
        } finally {
          await session.close();
        }
      }),
    );

    test('the turn completes', () => {
      expect(deltas.at(-1)).toMatchObject({ type: 'turn-end', outcome: 'completed' });
    });

    test('the waiting permission is denied with interrupt by the turn end, before close', () => {
      expect(outcome).toEqual({
        behavior: 'deny',
        message: 'The turn ended',
        interrupt: true,
      });
    });

    test('no abort listener is left on the tool signal', () => {
      expect(listeners).toBe(0);
    });
  });

  describe('a query that crashes while canUseTool waits', () => {
    let failure: unknown;
    let outcome: unknown;
    let listeners = -1;
    let promptEnded = false;
    let closeCalls = 0;

    beforeAll(() =>
      inScratch('sdk-crash', async (root) => {
        const counted = countedSignal();
        const driver = sdkDriver(root, ({ prompt, options }) => {
          const input = prompt[Symbol.asyncIterator]();
          async function* run(): AsyncGenerator<unknown> {
            const first = await input.next();
            if (first.done) return;
            void input.next().then((next) => {
              promptEnded = next.done === true;
            });
            void options
              ?.canUseTool?.(
                'Bash',
                { command: 'ls' },
                { signal: counted.signal, toolUseID: 'call-1', requestId: 'req-1' },
              )
              .then((value) => {
                outcome = value;
              });
            // Let the permission register, then crash the query.
            await Bun.sleep(5);
            throw new Error('query crashed mid-permission');
          }
          const records = run();
          return {
            [Symbol.asyncIterator]: () => records,
            interrupt: async () => undefined,
            close() {
              closeCalls += 1;
              throw new Error('close sync failure must be contained');
            },
          };
        });
        const session = await driver.open({ profile: sdkProfile(root), cwd: root });
        try {
          failure = await drain(await session.startTurn(textTurn('t-crash'))).catch(
            (error: unknown) => error,
          );
          await Bun.sleep(15);
          listeners = counted.listeners();
        } finally {
          await session.close();
        }
      }),
    );

    test('the turn fails with the query error', () => {
      expect(String(failure)).toContain('query crashed mid-permission');
    });

    test('the waiting permission is denied with interrupt', () => {
      expect(outcome).toMatchObject({ behavior: 'deny', interrupt: true });
    });

    test('no abort listener is left on the tool signal', () => {
      expect(listeners).toBe(0);
    });

    test('the prompt stream is ended', () => {
      expect(promptEnded).toBe(true);
    });

    test('query.close() is called once and its synchronous failure is contained', () => {
      expect(closeCalls).toBe(1);
    });
  });
});

describe('Claude SDK empty ids', () => {
  test('an empty tool name and toolUseID still give deltas that pass ExecutorDeltaSchema', () =>
    inScratch('sdk-empty-ids', async (root) => {
      const driver = sdkDriver(
        root,
        askingQuery({
          name: '',
          toolUseID: '',
          signal: () => new AbortController().signal,
          async during(permission) {
            await permission;
          },
        }),
      );
      const session = await driver.open({ profile: sdkProfile(root), cwd: root });
      try {
        const turn = await session.startTurn(textTurn('t-sdk'));
        const deltas: ExecutorDelta[] = [];
        for await (const delta of turn.deltas) {
          ExecutorDeltaSchema.parse(delta);
          deltas.push(delta);
          if (delta.type === 'request')
            await turn.respond(delta.interactionId, { kind: 'approve' });
        }
        expect(deltas.some((delta) => delta.type === 'request')).toBe(true);
      } finally {
        await session.close();
      }
    }));
});
