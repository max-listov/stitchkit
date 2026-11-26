/**
 * Mechanical coverage guard for the ACP v1 driver: every JSON-RPC method the driver sends or
 * handles, every ACP v1 `session/update` variant, every `usage` counter, stop reason, and
 * permission option kind is checked against the protocol declarations and recorded live fixtures.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import {
  acpOutcome,
  mapAcpUpdate,
  normalizeAcpUsage,
} from '../../src/agent-executor/acp/v1-map';
import {
  buildAcpPermissionAnswer,
  buildAcpPermissionDeltaFields,
} from '../../src/agent-executor/acp/v1-permission';
import {
  ACP_PROTOCOL_VERSION,
  ACP_V1_AGENT_METHODS,
  ACP_V1_CLIENT_METHODS,
  ACP_V1_PERMISSION_OPTION_KINDS,
  ACP_V1_STOP_REASONS,
  ACP_V1_UPDATE_KINDS,
  ACP_V1_USAGE_FIELDS,
  AcpClientInfoSchema,
  AcpInitializeResultSchema,
  AcpPermissionRequestSchema,
  AcpPromptResultSchema,
  AcpPromptUsageSchema,
  AcpUpdateNotificationSchema,
} from '../../src/agent-executor/acp/v1-protocol';
import {
  ExecutorDeltaSchema,
  ExecutorUsageDeltaSchema,
} from '../../src/agent-executor/vocabulary';

const ACP_SRC = resolve(import.meta.dir, '../../src/agent-executor/acp');
const RECORDED_DIR = resolve(import.meta.dir, '../fixtures/recorded');

/** Extract JSON-RPC method literals sent via `peer.request(...)` / `peer.notify(...)` or matched in handlers. */
function collectDriverMethods(sourceText: string): { agent: string[]; client: string[] } {
  const agent: string[] = [];
  const client: string[] = [];
  for (const match of sourceText.matchAll(
    /\bpeer\s*\.\s*(?:request|notify)\(\s*'([a-zA-Z0-9_/-]+)'/g,
  )) {
    if (match[1] !== undefined) agent.push(match[1]);
  }
  for (const match of sourceText.matchAll(/method\s*!==\s*'(session\/[a-z_]+)'/g)) {
    if (match[1] !== undefined) client.push(match[1]);
  }
  // Dynamic reopen chooses between `session/resume` and `session/load`.
  for (const match of sourceText.matchAll(/'(session\/(?:resume|load))'/g)) {
    if (match[1] !== undefined) agent.push(match[1]);
  }
  return { agent, client };
}

const RecordedLineSchema = z.looseObject({
  method: z.string().optional(),
  params: z.unknown().optional(),
  answerPrompt: z.unknown().optional(),
});

describe('ACP v1 protocol coverage and schema drift', () => {
  test('every JSON-RPC method sent or handled by the ACP driver is declared in ACP_V1_*_METHODS', () => {
    const files = readdirSync(ACP_SRC).filter(
      (name) => name.startsWith('v1-') && name.endsWith('.ts'),
    );
    const seenAgent = new Set<string>();
    const seenClient = new Set<string>();
    for (const file of files) {
      const text = readFileSync(join(ACP_SRC, file), 'utf8');
      const { agent, client } = collectDriverMethods(text);
      for (const method of agent) seenAgent.add(method);
      for (const method of client) seenClient.add(method);
    }
    expect([...seenAgent].sort()).toEqual([...ACP_V1_AGENT_METHODS].sort());
    expect([...seenClient].sort()).toEqual([...ACP_V1_CLIENT_METHODS].sort());

    // Negative control: an undeclared method string in driver code is caught.
    const declaredAgent = new Set<string>(ACP_V1_AGENT_METHODS);
    const bogus = collectDriverMethods(`peer.request('session/does_not_exist', {});`);
    expect(bogus.agent.filter((method) => !declaredAgent.has(method))).toEqual([
      'session/does_not_exist',
    ]);
  });

  test('every ACP v1 session/update variant parses and maps without unhandled errors', () => {
    const samples: Record<(typeof ACP_V1_UPDATE_KINDS)[number], Record<string, unknown>> = {
      user_message_chunk: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'hello' },
      },
      agent_message_chunk: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'answer' },
      },
      agent_thought_chunk: {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'thinking' },
      },
      tool_call: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1',
        title: 'ReadFile',
        kind: 'read',
        status: 'pending',
        rawInput: { path: 'a.ts' },
      },
      tool_call_update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-1',
        status: 'completed',
        rawOutput: { ok: true },
      },
      plan: { sessionUpdate: 'plan', entries: [] },
      plan_update: { sessionUpdate: 'plan_update', plan: { id: 'p1' } },
      plan_removed: { sessionUpdate: 'plan_removed', planId: 'p1' },
      available_commands_update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: 'compact' }],
      },
      current_mode_update: { sessionUpdate: 'current_mode_update', currentModeId: 'default' },
      config_option_update: {
        sessionUpdate: 'config_option_update',
        configOptions: [{ id: 'model', category: 'model', currentValue: 'm1' }],
      },
      session_info_update: { sessionUpdate: 'session_info_update', title: 'Session title' },
      usage_update: { sessionUpdate: 'usage_update', used: 100, size: 100_000 },
      compaction_update: {
        sessionUpdate: 'compaction_update',
        compactionId: 'c1',
        status: 'completed',
      },
      compaction_summary_chunk: {
        sessionUpdate: 'compaction_summary_chunk',
        compactionId: 'c1',
        content: { type: 'text', text: 'summary' },
      },
    };
    const track = { segment: 0, toolNames: new Map<string, string>() };
    let chunk = 0;
    for (const kind of ACP_V1_UPDATE_KINDS) {
      chunk += 1;
      const notification = AcpUpdateNotificationSchema.parse({
        sessionId: 'sess-1',
        update: samples[kind],
      });
      const deltas = mapAcpUpdate(notification.update, 'turn-1', chunk, track);
      for (const delta of deltas) {
        ExecutorDeltaSchema.parse(delta);
        expect(delta.type === 'error' && delta.kind === 'unhandled', kind).toBe(false);
      }
    }

    // Negative control: an unknown future update still maps to `unhandled`.
    const unknown = mapAcpUpdate(
      AcpUpdateNotificationSchema.parse({
        sessionId: 'sess-1',
        update: { sessionUpdate: 'future_acp_update' },
      }).update,
      'turn-1',
      99,
      track,
    );
    expect(unknown).toMatchObject([{ type: 'error', kind: 'unhandled' }]);
  });

  test('every ACP v1 usage counter, stopReason, and permission option kind is covered', () => {
    // 1. Usage counters
    const usageShapeKeys = Object.keys(AcpPromptUsageSchema.shape).sort();
    expect(usageShapeKeys).toEqual([...ACP_V1_USAGE_FIELDS].sort());
    const parsedUsage = AcpPromptUsageSchema.parse({
      inputTokens: 120,
      outputTokens: 30,
      cachedReadTokens: 40,
      cachedWriteTokens: 15,
      thoughtTokens: 12,
      totalTokens: 190,
    });
    const normalizedIncluded = normalizeAcpUsage(parsedUsage, {
      usageInputIncludesCachedRead: true,
    });
    const normalizedExcluded = normalizeAcpUsage(parsedUsage, {
      usageInputIncludesCachedRead: false,
    });
    expect(
      ExecutorUsageDeltaSchema.parse({
        type: 'usage',
        turnId: 't',
        itemId: 'usage',
        raw: { source: 'acp', type: 'session/prompt/end_turn' },
        ...normalizedIncluded,
      }),
    ).toMatchObject({
      inputTokens: 120,
      outputTokens: 30,
      cachedInputTokens: 40,
      cacheCreationInputTokens: 15,
      thinkingTokens: 12,
      totalTokens: 190,
    });
    expect(normalizedExcluded.inputTokens).toBe(160);

    // 2. Stop reasons
    for (const stopReason of ACP_V1_STOP_REASONS) {
      const parsed = AcpPromptResultSchema.parse({ stopReason });
      const outcome = acpOutcome(parsed.stopReason, false);
      if (stopReason === 'end_turn') expect(outcome).toBe('completed');
      else if (stopReason === 'cancelled') expect(outcome).toBe('interrupted');
      else expect(outcome).toBe('failed');
    }

    // 3. Permission option kinds, name, and _meta
    const request = AcpPermissionRequestSchema.parse({
      sessionId: 'sess-1',
      toolCall: { toolCallId: 'tc-1', title: 'Run', rawInput: { cmd: 'ls' } },
      options: ACP_V1_PERMISSION_OPTION_KINDS.map((kind, index) => ({
        optionId: `opt-${index}`,
        kind,
        name: `Label ${kind}`,
        _meta: { tag: kind },
      })),
    });
    const fields = buildAcpPermissionDeltaFields(request);
    expect(fields.input).toMatchObject({
      cmd: 'ls',
      options: ACP_V1_PERMISSION_OPTION_KINDS.map((kind, index) => ({
        optionId: `opt-${index}`,
        kind,
        name: `Label ${kind}`,
        _meta: { tag: kind },
      })),
    });
    expect(
      buildAcpPermissionAnswer({ options: request.options }, { kind: 'approve' }),
    ).toEqual({
      outcome: { outcome: 'selected', optionId: 'opt-0' },
    });
    expect(
      buildAcpPermissionAnswer(
        { options: request.options },
        { kind: 'approve', scope: 'session' },
      ),
    ).toEqual({
      outcome: { outcome: 'selected', optionId: 'opt-1' },
    });
    expect(
      buildAcpPermissionAnswer({ options: request.options }, { kind: 'deny', message: 'no' }),
    ).toEqual({
      outcome: { outcome: 'selected', optionId: 'opt-2' },
    });
    expect(
      buildAcpPermissionAnswer(
        { options: request.options },
        { kind: 'input', value: { optionId: 'opt-3' } },
      ),
    ).toEqual({
      outcome: { outcome: 'selected', optionId: 'opt-3' },
    });

    // 4. Initialize + clientInfo schemas accept protocolVersion >= 1 with v1 shape.
    expect(
      AcpInitializeResultSchema.parse({
        protocolVersion: ACP_PROTOCOL_VERSION + 1,
        agentInfo: { name: 'agent', title: 'Agent', version: '1.5.14' },
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { list: {}, resume: {}, close: null, delete: {} },
        },
      }).protocolVersion,
    ).toBe(2);
    expect(
      AcpClientInfoSchema.safeParse({ name: 'host', version: '1.0.0', extra: true }).success,
    ).toBe(false);
  });

  test('recorded agy 1.5.14 fixtures parse cleanly through ACP v1 schemas and retain full usage counters', () => {
    for (const file of ['agy-1.5.14-text.jsonl', 'agy-1.5.14-cancelled.jsonl']) {
      const lines = readFileSync(join(RECORDED_DIR, file), 'utf8')
        .trim()
        .split('\n')
        .map((line) => RecordedLineSchema.parse(JSON.parse(line)));
      const track = { segment: 0, toolNames: new Map<string, string>() };
      let chunk = 0;
      for (const record of lines) {
        if (record.method === 'session/update') {
          chunk += 1;
          const parsed = AcpUpdateNotificationSchema.parse(record.params);
          const deltas = mapAcpUpdate(parsed.update, 't', chunk, track);
          for (const delta of deltas) {
            ExecutorDeltaSchema.parse(delta);
            expect(delta.type === 'error' && delta.kind === 'unhandled').toBe(false);
          }
        } else if (record.answerPrompt !== undefined) {
          const parsed = AcpPromptResultSchema.parse(record.answerPrompt);
          expect(parsed.usage).toBeDefined();
          if (file === 'agy-1.5.14-text.jsonl' && parsed.usage != null) {
            expect(normalizeAcpUsage(parsed.usage)).toEqual({
              inputTokens: 14451,
              outputTokens: 178,
              cachedInputTokens: 0,
              cacheCreationInputTokens: 0,
              thinkingTokens: 177,
              totalTokens: 14629,
            });
          }
        }
      }
    }
  });
});
