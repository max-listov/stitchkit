import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import {
  AgentModelCatalogSchema,
  createMemoryAgentModelSelectionStore,
} from 'stitchkit/agent-runtime';
import { createStarterHarness } from '../src/runtime';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Agent starter runtime', () => {
  test('runs one model turn and reopens its durable transcript', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'stitchkit-agent-starter-'));
    roots.push(workspace);
    await mkdir(path.join(workspace, 'instructions'));
    await mkdir(path.join(workspace, 'skills'));
    await writeFile(path.join(workspace, 'instructions/AGENTS.md'), 'Answer directly.\n');
    const usage = {
      inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 1, text: 1, reasoning: undefined },
    };
    const model = new MockLanguageModelV4({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start', id: 'answer' },
            { type: 'text-delta', id: 'answer', delta: 'Ready to build.' },
            { type: 'text-end', id: 'answer' },
            { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
          ],
        }),
      },
    });
    const config = { apiKey: 'fixture' };
    const descriptor = {
      provider: 'fixture',
      modelId: 'fixture/model',
      contextWindow: 32_000,
      capabilities: ['tools'],
    };
    const catalog = AgentModelCatalogSchema.parse({
      schemaVersion: 1,
      source: 'fixture',
      observedAt: '2026-08-30T00:00:00.000Z',
      completeness: 'complete',
      diagnostics: [],
      models: [{ id: 'fixture/model', name: 'Fixture', descriptor, metrics: [] }],
    });
    const selections = createMemoryAgentModelSelectionStore();
    await selections.save('main', {
      modelId: 'fixture/model',
      selectedAt: '2026-08-30T00:00:00.000Z',
    });
    const provider = { create: () => model };
    const diagnostics = { write: () => undefined };
    const first = await createStarterHarness(config, workspace, {
      catalog,
      selections,
      provider,
      diagnostics,
    });
    const result = await first.harness.submit({
      conversationId: 'main',
      idempotencyKey: 'first',
      context: {},
      parts: [{ type: 'text', text: 'Hello' }],
      metadata: { modelId: 'fixture/model' },
    }).result;
    expect(result.reason).toBe('success');
    expect(result.message.parts).toContainEqual({ type: 'text', text: 'Ready to build.' });
    await first.harness.close();

    const reopened = await createStarterHarness(config, workspace, {
      catalog,
      selections,
      provider,
      diagnostics,
    });
    expect((await reopened.harness.snapshot('main')).messages).toHaveLength(2);
    await reopened.harness.close();
  });
});
