import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentTuiDiagnostics } from '@stitchkit/tui';
import {
  type AgentLanguageModelProvider,
  type AgentModelCatalog,
  type AgentModelSelectionStore,
  createAgentObservability,
  defineAgentProtocol,
} from 'stitchkit/agent-runtime';
import { createAgentCodingTools } from 'stitchkit/agent-runtime/coding-tools';
import {
  createAgentHarnessFileResources,
  createHeadlessAgentHarness,
} from 'stitchkit/agent-runtime/harness';
import { openRouterProvider } from 'stitchkit/agent-runtime/openrouter';
import { createBunSqliteAgentRuntimeStore } from 'stitchkit/agent-runtime/sqlite/bun';
import { mountAgent } from 'stitchkit/tools';
import { z } from 'zod';
import type { AgentConfig } from './config';

const InputMetadataSchema = z.object({ modelId: z.string().min(1) }).strict();

async function persistentApprovalSecret(stateDirectory: string): Promise<string> {
  const filename = path.join(stateDirectory, 'approval-secret');
  await mkdir(stateDirectory, { recursive: true });
  try {
    return (await readFile(filename, 'utf8')).trim();
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const secret = crypto.randomUUID();
  try {
    await writeFile(filename, `${secret}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return secret;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    return (await readFile(filename, 'utf8')).trim();
  }
}

export async function createStarterHarness(
  config: AgentConfig,
  workspace: string,
  options: {
    catalog: AgentModelCatalog;
    selections: AgentModelSelectionStore;
    provider?: AgentLanguageModelProvider;
    diagnostics: AgentTuiDiagnostics;
  },
) {
  const stateDirectory = path.join(workspace, '.stitchkit');
  await mkdir(stateDirectory, { recursive: true });
  const resources = createAgentHarnessFileResources({
    roots: [
      { id: 'instructions', path: path.join(workspace, 'instructions'), kind: 'instruction' },
      { id: 'skills', path: path.join(workspace, 'skills'), kind: 'skill' },
    ],
  });
  const codingTools = createAgentCodingTools({
    root: workspace,
    authorize: () => true,
    executables: {
      bun: process.execPath,
      git: Bun.which('git') ?? '/usr/bin/git',
      rg: Bun.which('rg') ?? '/usr/bin/rg',
    },
  });
  const provider = options.provider ?? openRouterProvider({ apiKey: config.apiKey });
  const sqlite = createBunSqliteAgentRuntimeStore({
    filename: path.join(stateDirectory, 'agent.sqlite'),
    initialize: true,
  });
  const observability = createAgentObservability({
    includeInternalCause: true,
    write: (event) => options.diagnostics.write(event),
  });
  const harness = createHeadlessAgentHarness({
    protocol: defineAgentProtocol({
      context: z.object({}),
      inputMetadata: InputMetadataSchema,
      terminalAcceptance: 'require-output',
    }),
    store: sqlite.store,
    observe: observability,
    models: {
      async resolve({ conversationId, run, snapshot }) {
        const input = snapshot.messages.find(({ id }) => id === run.inputMessageIds[0]);
        const metadata = InputMetadataSchema.safeParse(input?.metadata);
        const selected = metadata.success
          ? metadata.data.modelId
          : (await options.selections.load(conversationId))?.modelId;
        const entry = options.catalog.models.find(({ id }) => id === selected);
        if (!entry) throw new Error('The selected model is stale or unavailable');
        return {
          descriptor: entry.descriptor,
          model: provider.create(entry.descriptor.modelId),
          ...(provider.normalizeUsage && { normalizeUsage: provider.normalizeUsage }),
        };
      },
    },
    resources: { load: () => resources.load() },
    promptBudget: ({ contextWindow }) => ({
      contextWindow,
      reservedOutput: Math.min(8_192, Math.floor(contextWindow / 4)),
      toolSchemas: { provenance: 'unavailable' },
      attachments: { value: 0, provenance: 'measured' },
      providerOverhead: { provenance: 'unavailable' },
    }),
    tools: (context) =>
      mountAgent([], {
        runtimeTools: [...codingTools, ...resources.runtimeTools],
        lifecycle: context.toolFenceLifecycle,
      }),
    loop: {
      maxSteps: 50,
      checkpointEveryEvents: 10,
      toolApproval: {
        read_file: 'approved',
        search_files: 'approved',
        read_resource: 'approved',
        write_file: 'user-approval',
        apply_patch: 'user-approval',
        run_command: 'user-approval',
      },
      toolApprovalSecret: await persistentApprovalSecret(stateDirectory),
    },
  });
  const managedHarness = {
    ...harness,
    async close(closeOptions?: Parameters<typeof harness.close>[0]) {
      const result = await harness.close(closeOptions);
      await observability.close();
      await sqlite.close();
      return result;
    },
  };
  return { harness: managedHarness, conversations: sqlite.conversations };
}
