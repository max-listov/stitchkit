import type { z } from 'zod';
import type { AgentEngineDialectScenarios } from '../testing/conformance';
import type { FakeEngineScenario, FakeEngineStep } from '../testing/fake-engine';

type Json = z.infer<ReturnType<typeof z.json>>;

const session = 'fake-session';
const update = (value: Record<string, Json>): FakeEngineStep => ({
  do: 'emit',
  record: {
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId: session, update: value },
  },
});
/** The answer to the running `session/prompt`; the fake fills in its id. */
const answer = (result: Record<string, Json>): FakeEngineStep => ({
  do: 'emit',
  record: { answerPrompt: result },
});
const refuse = (message: string): FakeEngineStep => ({
  do: 'emit',
  record: { refusePrompt: { code: -32000, message } },
});
const chunk = (text: string) =>
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
const steps = (...rest: FakeEngineStep[]): FakeEngineScenario => ({ steps: rest });
/** A permission the agent asks for, under its request id. */
const permissionRequest = (id: string, toolCallId: string): FakeEngineStep => ({
  do: 'emit',
  record: {
    jsonrpc: '2.0',
    id,
    method: 'session/request_permission',
    params: {
      sessionId: session,
      toolCall: { toolCallId, title: 'write', rawInput: { path: 'z' } },
      options: [
        { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
        { optionId: 'no', name: 'Reject', kind: 'reject_once' },
      ],
    },
  },
});

/** The conformance scenarios in ACP v1, for `fake-acp-agent`. */
export const acpFakeScenarios: AgentEngineDialectScenarios = {
  text: (value) =>
    steps(
      chunk(value),
      answer({ stopReason: 'end_turn', usage: { inputTokens: 3, outputTokens: 2 } }),
    ),
  approval: () =>
    steps(
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 'call-1',
        title: 'write',
        kind: 'edit',
        status: 'pending',
        rawInput: { path: 'x' },
      }),
      {
        do: 'emit',
        record: {
          jsonrpc: '2.0',
          id: 'agent-1',
          method: 'session/request_permission',
          params: {
            sessionId: session,
            toolCall: { toolCallId: 'call-1', title: 'write', rawInput: { path: 'x' } },
            options: [
              { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
              { optionId: 'no', name: 'Reject', kind: 'reject_once' },
            ],
          },
        },
      },
      { do: 'expect', type: 'response' },
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        title: 'write',
        status: 'completed',
        rawOutput: 'written',
      }),
      answer({ stopReason: 'end_turn' }),
    ),
  failure: (status) =>
    steps(refuse(status === 401 ? 'Authentication required' : 'Rate limit exceeded (429)')),
  interruptible: () =>
    steps(
      chunk('one '),
      { do: 'expect', type: 'session/cancel' },
      answer({ stopReason: 'end_turn' }),
    ),
  interruptDuringApproval: () =>
    steps(
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 'call-1',
        title: 'write',
        kind: 'edit',
        status: 'pending',
        rawInput: { path: 'x' },
      }),
      {
        do: 'emit',
        record: {
          jsonrpc: '2.0',
          id: 'agent-1',
          method: 'session/request_permission',
          params: {
            sessionId: session,
            toolCall: { toolCallId: 'call-1', title: 'write', rawInput: { path: 'x' } },
            options: [
              { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
              { optionId: 'no', name: 'Reject', kind: 'reject_once' },
            ],
          },
        },
      },
      { do: 'expect', type: 'session/cancel' },
      { do: 'expect', type: 'response' },
      answer({ stopReason: 'cancelled' }),
    ),
  requestAfterInterrupt: () =>
    steps(
      chunk('one '),
      { do: 'expect', type: 'session/cancel' },
      {
        do: 'emit',
        record: {
          jsonrpc: '2.0',
          id: 'agent-2',
          method: 'session/request_permission',
          params: {
            sessionId: session,
            toolCall: { toolCallId: 'call-2', title: 'write', rawInput: { path: 'y' } },
            options: [
              { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
              { optionId: 'no', name: 'Reject', kind: 'reject_once' },
            ],
          },
        },
      },
      { do: 'expect', type: 'response' },
      answer({ stopReason: 'cancelled' }),
    ),
  requestAtTurnEnd: () =>
    steps(permissionRequest('agent-3', 'call-3'), answer({ stopReason: 'end_turn' })),
  requestThenCrash: () =>
    steps(permissionRequest('agent-4', 'call-4'), { do: 'delay', ms: 100 }, { do: 'crash' }),
  eofWithoutResult: () => steps(chunk('cut '), { do: 'exit', code: 0 }),
  invalidLine: () => steps({ do: 'emit-raw', line: '{"jsonrpc":' }),
  unknownRecord: () =>
    steps(
      update({ sessionUpdate: 'an_update_from_the_future' }),
      answer({ stopReason: 'end_turn' }),
    ),
  crash: () => steps(chunk('dying '), { do: 'crash' }),
};
