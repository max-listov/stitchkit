import type { AgentEngineDialectScenarios } from './conformance';
import type { FakeEngineScenario } from './fake-engine';
import {
  type ExecutorReplayStep,
  type ExecutorReplayTranscript,
  ExecutorReplayTranscriptSchema,
  formatReplayTranscript,
} from './replay-transcript';

/** Built-in deterministic replay scenarios for local UI development and e2e tests. */
export const REPLAY_SCENARIOS = {
  'text-stream': formatReplayTranscript([
    { kind: 'emit', block: 'status', phase: 'initializing' },
    { kind: 'emit', block: 'text', text: 'Hello ', itemId: 'msg-1' },
    { kind: 'emit', block: 'text', text: 'from replay.', itemId: 'msg-1' },
    { kind: 'usage', inputTokens: 12, outputTokens: 4, totalTokens: 16 },
    { kind: 'emit', block: 'turn-end', outcome: 'completed', threadDisposition: 'reusable' },
  ]),
  approval: formatReplayTranscript([
    {
      kind: 'emit',
      block: 'tool-call',
      callId: 'call-1',
      toolName: 'run_shell',
      input: { command: 'ls <workspace>' },
      itemId: 'tc-1',
    },
    {
      kind: 'request',
      interactionId: 'req-1',
      requestKind: 'approval',
      callId: 'call-1',
      toolName: 'run_shell',
      input: { command: 'ls <workspace>' },
    },
    { kind: 'expectReply', interactionId: 'req-1', replyKind: 'approve', required: true },
    {
      kind: 'emit',
      block: 'tool-result',
      callId: 'call-1',
      toolName: 'run_shell',
      outcome: 'success',
      output: 'README.md',
      itemId: 'tr-1',
    },
    { kind: 'emit', block: 'text', text: 'Listed workspace files.', itemId: 'msg-1' },
    { kind: 'emit', block: 'turn-end', outcome: 'completed' },
  ]),
  'user-input': formatReplayTranscript([
    {
      kind: 'request',
      interactionId: 'q-1',
      requestKind: 'input',
      prompt: 'Choose deployment environment',
      input: { options: ['staging', 'production'] },
    },
    { kind: 'expectReply', interactionId: 'q-1', replyKind: 'input', required: true },
    { kind: 'emit', block: 'text', text: 'Selection applied.', itemId: 'msg-1' },
    { kind: 'emit', block: 'turn-end', outcome: 'completed' },
  ]),
  'tool-calls': formatReplayTranscript([
    { kind: 'emit', block: 'reasoning', text: 'Inspecting workspace file.', itemId: 'r-1' },
    {
      kind: 'emit',
      block: 'tool-call',
      callId: 'c-read',
      toolName: 'read_file',
      input: { path: '<workspace>/package.json' },
      itemId: 'tc-1',
    },
    {
      kind: 'emit',
      block: 'tool-result',
      callId: 'c-read',
      toolName: 'read_file',
      outcome: 'success',
      output: '{"name":"demo"}',
      itemId: 'tr-1',
    },
    { kind: 'contextUsage', usedTokens: 1_200, windowTokens: 200_000 },
    { kind: 'emit', block: 'text', text: 'Package name is demo.', itemId: 'msg-1' },
    { kind: 'emit', block: 'turn-end', outcome: 'completed' },
  ]),
  'rate-limit': formatReplayTranscript([
    {
      kind: 'rateLimit',
      windows: [{ name: 'five_hour', usedPercent: 100, windowDurationMins: 300 }],
    },
    {
      kind: 'emit',
      block: 'error',
      errorKind: 'rateLimited',
      message: 'Rate limit window exhausted',
    },
    { kind: 'emit', block: 'turn-end', outcome: 'failed' },
  ]),
  'multi-turn': [
    formatReplayTranscript([
      { kind: 'emit', block: 'text', text: 'First turn done.', itemId: 'm-1' },
      { kind: 'emit', block: 'turn-end', outcome: 'completed' },
    ]),
    formatReplayTranscript([
      { kind: 'emit', block: 'text', text: 'Second turn done.', itemId: 'm-2' },
      { kind: 'emit', block: 'turn-end', outcome: 'completed' },
    ]),
  ] as readonly string[],
  'crash-mid-turn': formatReplayTranscript([
    { kind: 'emit', block: 'text', text: 'Partial output before crash', itemId: 'm-1' },
    { kind: 'crash', message: 'Simulated engine crash mid-turn' },
  ]),
} as const;

function packReplayScenario(steps: readonly ExecutorReplayStep[]): FakeEngineScenario {
  return {
    steps: steps.map((step) => ({ do: 'emit' as const, record: step })),
    keepTranscript: true,
  };
}

/** Extract an {@link ExecutorReplayTranscript} packed by {@link replayDialectScenarios}. */
export function unpackReplayScenario(scenario: FakeEngineScenario): ExecutorReplayTranscript {
  const steps: ExecutorReplayStep[] = [];
  for (const step of scenario.steps) {
    if (step.do === 'emit') {
      steps.push(ExecutorReplayTranscriptSchema.shape.steps.element.parse(step.record));
    }
  }
  return { steps };
}

/**
 * Conformance dialect scenarios for {@link createReplayExecutorDriver}, allowing full
 * execution of {@link runAgentEngineConformance} completely in-process with zero child processes.
 */
export function replayDialectScenarios(): AgentEngineDialectScenarios {
  return {
    text: (value) =>
      packReplayScenario([
        { kind: 'emit', block: 'text', text: value, itemId: 'msg-1' },
        { kind: 'emit', block: 'turn-end', outcome: 'completed' },
      ]),
    approval: () =>
      packReplayScenario([
        {
          kind: 'emit',
          block: 'tool-call',
          callId: 'c1',
          toolName: 'bash',
          input: { command: 'echo ok' },
          itemId: 'tc-1',
        },
        {
          kind: 'request',
          interactionId: 'req-1',
          requestKind: 'approval',
          callId: 'c1',
          toolName: 'bash',
          input: { command: 'echo ok' },
        },
        { kind: 'expectReply', interactionId: 'req-1', replyKind: 'approve' },
        {
          kind: 'emit',
          block: 'tool-result',
          callId: 'c1',
          toolName: 'bash',
          outcome: 'success',
          output: 'ok',
          itemId: 'tr-1',
        },
        { kind: 'emit', block: 'turn-end', outcome: 'completed' },
      ]),
    failure: (status) =>
      packReplayScenario([
        {
          kind: 'emit',
          block: 'error',
          errorKind: status === 401 ? 'authRequired' : 'rateLimited',
          message: `HTTP ${status}`,
        },
        { kind: 'emit', block: 'turn-end', outcome: 'failed' },
      ]),
    interruptible: () =>
      packReplayScenario([
        { kind: 'emit', block: 'text', text: 'working', itemId: 'm1' },
        { kind: 'waitInterrupt' },
        { kind: 'emit', block: 'turn-end', outcome: 'completed' },
      ]),
    interruptDuringApproval: () =>
      packReplayScenario([
        {
          kind: 'request',
          interactionId: 'req-int',
          requestKind: 'approval',
          callId: 'c-int',
          toolName: 'bash',
        },
        { kind: 'waitInterrupt' },
        { kind: 'emit', block: 'turn-end', outcome: 'completed' },
      ]),
    requestAfterInterrupt: () =>
      packReplayScenario([
        { kind: 'emit', block: 'text', text: 'before', itemId: 'm1' },
        { kind: 'waitInterrupt' },
        {
          kind: 'request',
          interactionId: 'req-late',
          requestKind: 'approval',
          callId: 'c-late',
          toolName: 'bash',
        },
        { kind: 'emit', block: 'turn-end', outcome: 'completed' },
      ]),
    requestAtTurnEnd: () =>
      packReplayScenario([
        {
          kind: 'request',
          interactionId: 'req-end',
          requestKind: 'approval',
          callId: 'c-end',
          toolName: 'bash',
        },
        { kind: 'emit', block: 'turn-end', outcome: 'completed' },
      ]),
    requestThenCrash: () =>
      packReplayScenario([
        {
          kind: 'request',
          interactionId: 'req-crash',
          requestKind: 'approval',
          callId: 'c-crash',
          toolName: 'bash',
        },
        { kind: 'crash', message: 'engine lost while request pending' },
      ]),
    eofWithoutResult: () => packReplayScenario([{ kind: 'eofWithoutResult' }]),
    invalidLine: () => packReplayScenario([{ kind: 'invalidLine', rawLine: '{broken' }]),
    unknownRecord: () =>
      packReplayScenario([
        { kind: 'unknownRecord', recordType: 'future_event', message: 'Unknown record' },
        { kind: 'emit', block: 'turn-end', outcome: 'completed' },
      ]),
    crash: () => packReplayScenario([{ kind: 'crash', message: 'boom' }]),
  };
}
