import { describe, expect, test } from 'bun:test';
import { AgentModelCatalogSchema } from 'stitchkit/agent-runtime';
import { AGENT_TUI_MODEL_RESULT_LIMIT, searchAgentTuiModels } from '../src/model-picker';

describe('Agent TUI model picker', () => {
  test('searches the complete catalog but retains only the renderer bound', () => {
    const catalog = AgentModelCatalogSchema.parse({
      schemaVersion: 1,
      source: 'fixture',
      observedAt: '2026-08-30T00:00:00.000Z',
      completeness: 'complete',
      diagnostics: [],
      models: Array.from({ length: AGENT_TUI_MODEL_RESULT_LIMIT + 25 }, (_, index) => ({
        id: `provider/model-${index}`,
        name: `Model ${index}`,
        descriptor: {
          provider: 'provider',
          modelId: `model-${index}`,
          contextWindow: 32_000,
          capabilities: ['tools'],
        },
        metrics: [],
      })),
    });

    const all = searchAgentTuiModels(catalog, '');
    expect(all).toMatchObject({
      total: AGENT_TUI_MODEL_RESULT_LIMIT + 25,
      truncated: true,
    });
    expect(all.models).toHaveLength(AGENT_TUI_MODEL_RESULT_LIMIT);
    expect(searchAgentTuiModels(catalog, 'model-224').models[0]?.id).toBe(
      'provider/model-224',
    );
  });
});
