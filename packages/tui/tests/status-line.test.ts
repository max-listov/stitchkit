import { describe, expect, test } from 'bun:test';
import { AgentModelCatalogSchema, AgentSnapshotSchema } from 'stitchkit/agent-runtime';
import { defaultAgentTuiStatusLine } from '../src/status-line';

const at = '2026-08-30T00:00:00.000Z';

describe('Agent TUI status line', () => {
  test('reports model capacity and only durable usage values', () => {
    const catalog = AgentModelCatalogSchema.parse({
      schemaVersion: 1,
      source: 'fixture',
      observedAt: at,
      completeness: 'complete',
      diagnostics: [],
      models: [
        {
          id: 'provider/model',
          name: 'Model',
          descriptor: {
            provider: 'provider',
            modelId: 'model',
            contextWindow: 1_000_000,
            capabilities: ['tools'],
          },
          metrics: [],
        },
      ],
    });
    const snapshot = AgentSnapshotSchema.parse({
      schemaVersion: 1,
      conversationId: 'conversation-12345678',
      version: 1,
      messages: [],
      runs: [
        {
          schemaVersion: 1,
          id: 'run-1',
          conversationId: 'conversation-12345678',
          inputMessageIds: ['input-1'],
          assistantMessageId: 'assistant-1',
          state: 'completed',
          revision: 2,
          terminalReason: 'success',
          usage: {
            inputTokens: { value: 1_200, provenance: 'provider-reported' },
            outputTokens: { value: 340, provenance: 'provider-reported' },
          },
          createdAt: at,
          updatedAt: at,
        },
      ],
    });
    const model = catalog.models[0];
    if (!model) throw new Error('model fixture is empty');
    const rows = defaultAgentTuiStatusLine({
      title: 'Agent',
      workspace: '/work/example',
      activity: 'READY',
      sessionId: 'session-12345678',
      conversationId: snapshot.conversationId,
      model,
      snapshot,
    });

    expect(rows.map((row) => row.map(({ text }) => text))).toEqual([
      ['Model', '1.0M context', 'session ↓1.2k ↑340'],
      ['example', 'conversa', 'ready'],
    ]);
  });

  test('does not invent usage when the snapshot has none', () => {
    const snapshot = AgentSnapshotSchema.parse({
      schemaVersion: 1,
      conversationId: 'fresh-conversation',
      version: 0,
      messages: [],
      runs: [],
    });
    const rows = defaultAgentTuiStatusLine({
      title: 'Agent',
      workspace: '/work/example',
      activity: 'RUNNING',
      sessionId: 'session',
      conversationId: snapshot.conversationId,
      snapshot,
    });

    expect(rows[0]?.map(({ text }) => text)).toEqual(['model unavailable']);
  });
});
