import type { z } from 'zod';
import type { AgentEngineDialectScenarios } from '../testing/conformance';
import type { FakeEngineScenario, FakeEngineStep } from '../testing/fake-engine';

type Json = z.infer<ReturnType<typeof z.json>>;

const session = 'fake-session';
/** One record the fake writes, each literal checked to be JSON on its own. */
const emit = (record: Json): FakeEngineStep => ({ do: 'emit', record });
const result = (fields: Record<string, Json>): FakeEngineStep =>
  emit({
    type: 'result',
    session_id: session,
    usage: { input_tokens: 3, output_tokens: 2 },
    total_cost_usd: 0.0001,
    ...fields,
  });
const text = (value: string): FakeEngineStep =>
  emit({
    type: 'stream_event',
    api_message_id: 'msg-1',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: value },
    },
  });
/** A `can_use_tool` request the CLI writes and waits on. */
const permissionRequest = (requestId: string, toolUseId: string): FakeEngineStep =>
  emit({
    type: 'control_request',
    request_id: requestId,
    request: {
      subtype: 'can_use_tool',
      tool_name: 'Write',
      tool_use_id: toolUseId,
      input: { file_path: 'z' },
    },
  });
const start: FakeEngineStep[] = [
  emit({ type: 'system', subtype: 'init', session_id: session, model: 'fake' }),
  { do: 'expect', type: 'user' },
];
const steps = (...rest: FakeEngineStep[]): FakeEngineScenario => ({
  steps: [...start, ...rest],
});

/** The conformance scenarios in Claude Code's `stream-json` dialect. */
export const claudeFakeScenarios: AgentEngineDialectScenarios = {
  text: (value) =>
    steps(text(value), result({ subtype: 'success', is_error: false, result: value })),
  approval: () =>
    steps(
      emit({
        type: 'assistant',
        message: {
          id: 'msg-1',
          content: [
            { type: 'tool_use', id: 'call-1', name: 'Write', input: { file_path: 'x' } },
          ],
        },
      }),
      emit({
        type: 'control_request',
        request_id: 'req-1',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Write',
          tool_use_id: 'call-1',
          input: { file_path: 'x' },
        },
      }),
      { do: 'expect', type: 'control_response', subtype: 'success' },
      emit({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'written' }],
        },
      }),
      result({ subtype: 'success', is_error: false, result: 'done' }),
    ),
  failure: (status) =>
    steps(
      result({
        subtype: 'error_during_execution',
        is_error: true,
        api_error_status: status,
        result: `HTTP ${status}`,
      }),
    ),
  interruptible: () =>
    steps(
      text('one '),
      { do: 'expect', type: 'control_request', subtype: 'interrupt' },
      // A late success after the interrupt: the turn still ends interrupted.
      result({ subtype: 'success', is_error: false, result: 'one' }),
    ),
  interruptDuringApproval: () =>
    steps(
      emit({
        type: 'assistant',
        message: {
          id: 'msg-1',
          content: [
            { type: 'tool_use', id: 'call-1', name: 'Write', input: { file_path: 'x' } },
          ],
        },
      }),
      emit({
        type: 'control_request',
        request_id: 'req-1',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Write',
          tool_use_id: 'call-1',
          input: { file_path: 'x' },
        },
      }),
      { do: 'expect', type: 'control_response', subtype: 'success' },
      { do: 'expect', type: 'control_request', subtype: 'interrupt' },
      result({ subtype: 'error_during_execution', is_error: true, result: 'interrupted' }),
    ),
  requestAfterInterrupt: () =>
    steps(
      text('one '),
      { do: 'expect', type: 'control_request', subtype: 'interrupt' },
      emit({
        type: 'control_request',
        request_id: 'req-2',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Write',
          tool_use_id: 'call-2',
          input: { file_path: 'y' },
        },
      }),
      { do: 'expect', type: 'control_response', subtype: 'success' },
      result({ subtype: 'error_during_execution', is_error: true, result: 'interrupted' }),
    ),
  requestAtTurnEnd: () =>
    steps(
      permissionRequest('req-3', 'call-3'),
      result({ subtype: 'success', is_error: false, result: 'done' }),
    ),
  requestThenCrash: () =>
    steps(permissionRequest('req-4', 'call-4'), { do: 'delay', ms: 100 }, { do: 'crash' }),
  eofWithoutResult: () => steps(text('cut '), { do: 'exit', code: 0 }),
  invalidLine: () => steps({ do: 'emit-raw', line: '{"type":' }),
  unknownRecord: () =>
    steps(
      emit({ type: 'a_record_from_the_future' }),
      result({ subtype: 'success', is_error: false, result: '' }),
    ),
  crash: () => steps(text('dying '), { do: 'crash' }),
};
