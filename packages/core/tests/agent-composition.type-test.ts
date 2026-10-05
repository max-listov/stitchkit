import { z } from 'zod';
import {
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
} from '../src/entrypoints/agent-runtime';
import {
  createHeadlessAgentHarness,
  type HeadlessAgentModelResolver,
} from '../src/entrypoints/agent-runtime/harness';
import { composeToolLifecycle, mountAgent } from '../src/entrypoints/tools';

declare const models: HeadlessAgentModelResolver<{ tenant: string }>;

// Contextual inference must survive the short composition shown in the guide.
createHeadlessAgentHarness({
  protocol: defineAgentProtocol({
    context: z.object({ tenant: z.string() }),
    inputMetadata: z.object({}),
    terminalAcceptance: 'require-output',
  }),
  store: createMemoryAgentRuntimeStore(),
  models,
  resources: {
    load: ({ context }) => ({
      resources: [
        { kind: 'instruction', name: 'tenant', text: context.tenant, provenance: 'fixture' },
      ],
      diagnostics: [],
    }),
  },
  promptBudget: ({ contextWindow }) => ({
    contextWindow,
    reservedOutput: 100,
    toolSchemas: { value: 0, provenance: 'measured' },
    attachments: { value: 0, provenance: 'measured' },
    providerOverhead: { provenance: 'unavailable' },
  }),
  tools: ({ context, run, toolFenceLifecycle }) => {
    const tenant: string = context.tenant;
    // @ts-expect-error — the protocol context is concrete, not an untyped dictionary.
    const invalid: number = context.tenant;
    void invalid;
    return mountAgent([], {
      context: { tenant, assistantMessageId: run.assistantMessageId },
      lifecycle: composeToolLifecycle(undefined, toolFenceLifecycle),
    });
  },
});
