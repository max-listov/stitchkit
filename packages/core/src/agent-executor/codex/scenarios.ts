import type { z } from 'zod';
import type { AgentEngineDialectScenarios } from '../testing/conformance';
import type { FakeEngineScenario, FakeEngineStep } from '../testing/fake-engine';

type Json = z.infer<ReturnType<typeof z.json>>;

const thread = 'fake-thread';
const turn = 'fake-turn';
const emit = (record: Json): FakeEngineStep => ({ do: 'emit', record });
const notify = (method: string, params: Record<string, Json>): FakeEngineStep =>
  emit({ method, params: { threadId: thread, turnId: turn, ...params } });
const completed = (status: string, error?: Record<string, Json>): FakeEngineStep =>
  notify('turn/completed', { turn: { id: turn, status, items: [], error: error ?? null } });
const usage = notify('thread/tokenUsage/updated', {
  tokenUsage: { last: { inputTokens: 3, outputTokens: 2, cachedInputTokens: 0 }, total: {} },
});
const text = (value: string) =>
  notify('item/agentMessage/delta', { itemId: 'msg-1', delta: value });
/** A command approval the app-server asks for, under its request id. */
const approvalRequest = (id: string, itemId: string): FakeEngineStep =>
  emit({
    id,
    method: 'item/commandExecution/requestApproval',
    params: { threadId: thread, turnId: turn, itemId, startedAtMs: 1, command: 'touch z' },
  });
/** The fake answers the protocol itself; a scenario starts when the turn does. */
const steps = (...rest: FakeEngineStep[]): FakeEngineScenario => ({ steps: rest });

/** The conformance scenarios in Codex's app-server dialect, for `fake-codex-engine`. */
export const codexFakeScenarios: AgentEngineDialectScenarios = {
  text: (value) => steps(text(value), usage, completed('completed')),
  approval: () =>
    steps(
      notify('item/started', {
        item: {
          type: 'commandExecution',
          id: 'call-1',
          command: 'touch x',
          status: 'inProgress',
        },
      }),
      emit({
        id: 'server-1',
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: thread,
          turnId: turn,
          itemId: 'call-1',
          startedAtMs: 1,
          command: 'touch x',
        },
      }),
      { do: 'expect', type: 'response' },
      notify('serverRequest/resolved', { requestId: 'server-1' }),
      notify('item/completed', {
        item: {
          type: 'commandExecution',
          id: 'call-1',
          command: 'touch x',
          status: 'completed',
          aggregatedOutput: '',
        },
      }),
      completed('completed'),
    ),
  failure: (status) =>
    steps(
      completed('failed', {
        message: `HTTP ${status}`,
        codexErrorInfo: status === 401 ? 'unauthorized' : 'usageLimitExceeded',
      }),
    ),
  interruptible: () =>
    steps(text('one '), { do: 'expect', type: 'turn/interrupt' }, completed('completed')),
  interruptDuringApproval: () =>
    steps(
      notify('item/started', {
        item: {
          type: 'commandExecution',
          id: 'call-1',
          command: 'touch x',
          status: 'inProgress',
        },
      }),
      emit({
        id: 'server-1',
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: thread,
          turnId: turn,
          itemId: 'call-1',
          startedAtMs: 1,
          command: 'touch x',
        },
      }),
      { do: 'expect', type: 'response' },
      { do: 'expect', type: 'turn/interrupt' },
      completed('interrupted'),
    ),
  requestAfterInterrupt: () =>
    steps(
      text('one '),
      { do: 'expect', type: 'turn/interrupt' },
      emit({
        id: 'server-2',
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: thread,
          turnId: turn,
          itemId: 'call-2',
          startedAtMs: 1,
          command: 'touch y',
        },
      }),
      { do: 'expect', type: 'response' },
      completed('interrupted'),
    ),
  requestAtTurnEnd: () => steps(approvalRequest('server-3', 'call-3'), completed('completed')),
  requestThenCrash: () =>
    steps(approvalRequest('server-4', 'call-4'), { do: 'delay', ms: 100 }, { do: 'crash' }),
  eofWithoutResult: () => steps(text('cut '), { do: 'exit', code: 0 }),
  invalidLine: () => steps({ do: 'emit-raw', line: '{"method":' }),
  unknownRecord: () =>
    steps(notify('a/notification/from/the/future', {}), completed('completed')),
  crash: () => steps(text('dying '), { do: 'crash' }),
};
