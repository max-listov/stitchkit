import { z } from 'zod';
import type { AcpDriverConfig } from '../src/entrypoints/agent-executor/acp';
import type { CodexDriverConfig } from '../src/entrypoints/agent-executor/codex';
import {
  type AgentGeneratedFile,
  type AgentModelDriver,
  type AgentModelProviderOptions,
  AgentModelProviderOptionsSchema,
  type AgentModelProviderOptionValue,
  type AgentModelProviderToolSpec,
  type AgentModelRequest,
  type AgentRuntimeStopPolicy,
  type CompleteStreamPart,
  completeObject,
  completeText,
  composeModelDrivers,
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
  streamComplete,
  wrapModelDriver,
} from '../src/entrypoints/agent-runtime';
import type { AnthropicRequestPolicy } from '../src/entrypoints/agent-runtime/anthropic';
import { createHeadlessAgentHarness } from '../src/entrypoints/agent-runtime/harness';
import type { OpenAiRequestPolicy } from '../src/entrypoints/agent-runtime/openai';
import {
  createOpenRouterCatalogCache,
  evaluateOpenRouterModelAdmission,
  fetchOpenRouterModelEndpoints,
  findOpenRouterModel,
  listOpenRouterModels,
  loadOpenRouterCatalogSnapshot,
  type OpenRouterAdmissionPolicy,
  type OpenRouterCatalogCache,
  type OpenRouterCatalogCacheOptions,
  type OpenRouterCatalogCacheReadResult,
  type OpenRouterCatalogSnapshot,
  type OpenRouterCatalogStore,
  type OpenRouterEndpoint,
  type OpenRouterEndpointSummary,
  type OpenRouterModelFilter,
  type OpenRouterModelPricingCeiling,
  type OpenRouterRequestPolicy,
  type OpenRouterSnapshotModel,
  type OpenRouterSnapshotOptions,
  resolveOpenRouterModelCeiling,
  summarizeOpenRouterEndpoints,
} from '../src/entrypoints/agent-runtime/openrouter';
import type { ProcessSandbox } from '../src/entrypoints/agent-runtime/sandbox';
import type { DeviceRelayAgent } from '../src/entrypoints/device-relay';
import type { DevicePresenceRelayAdapterConfig } from '../src/entrypoints/realtime';
import {
  type AgentToolSet,
  type DefineAgentToolConfig,
  defineAgentTool,
  defineRuntimeTool,
  mountAgentTools,
} from '../src/entrypoints/tools';
import { createToolkit } from '../src/entrypoints/tools/toolkit';

declare const driver: AgentModelDriver;
declare const sandbox: ProcessSandbox;
declare const relayAgent: DeviceRelayAgent;

// 1. defineAgentTool: contextual inference across execute, needsApproval, onInputAvailable, toModelOutput, and AgentToolSet assignability.
const deleteFile = defineAgentTool({
  description: 'Delete a file by path',
  input: z.object({
    path: z.string().transform((value) => value.trim()),
    recursive: z.boolean().default(false),
  }),
  output: z.object({ deleted: z.boolean() }),
  needsApproval: (input) => {
    const p: string = input.path;
    const r: boolean = input.recursive;
    // @ts-expect-error — nonexistent field on inferred tool input.
    const bad = input.nonexistent;
    void bad;
    return p.startsWith('/etc') || r;
  },
  onInputAvailable: ({ input }) => {
    const p: string = input.path;
    void p;
  },
  toModelOutput: ({ input, output }) => {
    const p: string = input.path;
    const ok: boolean = output.deleted;
    return { type: 'text', value: `${p}:${ok}` };
  },
  execute: async ({ path, recursive }) => ({ deleted: path.length > 0 || recursive }),
});

const toolSet: AgentToolSet = { deleteFile };
void toolSet;

// 2. completeText, completeObject, streamComplete: compile-time XOR on prompt vs messages + output inference.
async function checkStandaloneCompletions() {
  const byPrompt = await completeText({ driver, prompt: 'Hello' });
  const byMessages = await completeText({
    driver,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
  });
  void byPrompt.text;
  void byMessages.text;

  // @ts-expect-error — providing both prompt and messages violates the XOR contract.
  await completeText({ driver, prompt: 'a', messages: [] });

  // @ts-expect-error — omitting both prompt and messages violates the XOR contract.
  await completeText({ driver });

  const streamed = streamComplete({ driver, prompt: 'Stream me' });
  for await (const part of streamed.parts) {
    void part.type;
  }
  // @ts-expect-error — streamComplete enforces the same prompt vs messages XOR.
  streamComplete({ driver, prompt: 'a', messages: [] });

  const structured = await completeObject({
    driver,
    prompt: 'Classify',
    schema: z.object({
      label: z.string().transform((s) => s.toUpperCase()),
      score: z.number().optional(),
    }),
  });
  const label: string = structured.object.label;
  const score: number | undefined = structured.object.score;
  // @ts-expect-error — structured.object.label is string, not number.
  const wrongLabel: number = structured.object.label;
  void [label, score, wrongLabel];

  // @ts-expect-error — completeObject forbids passing both prompt and messages.
  await completeObject({
    driver,
    prompt: 'x',
    messages: [],
    schema: z.object({ ok: z.boolean() }),
  });
}
void checkStandaloneCompletions;

// 3. wrapModelDriver & composeModelDrivers: sync/async beforeStream state inference, context, and transformSignal.
const wrappedSync = wrapModelDriver(driver, {
  beforeStream: (_req, _signal, ctx) => {
    const provider: string = ctx.provider;
    const modelId: string = ctx.modelId;
    return {
      startedAt: Date.now(),
      tag: `${provider}:${modelId}`,
      controller: new AbortController(),
    };
  },
  transformRequest: (req: AgentModelRequest, state) => ({
    ...req,
    headers: { ...req.headers, 'x-tag': state.tag },
  }),
  transformSignal: (_signal, state) => state.controller.signal,
  onPart: (_part, state) => {
    const started: number = state.startedAt;
    void started;
  },
  onClose: (_outcome, state) => {
    const tag: string = state.tag;
    // @ts-expect-error — state does not carry an undeclared property.
    const missing = state.missingField;
    void [tag, missing];
  },
});

const wrappedAsync = wrapModelDriver(driver, {
  beforeStream: async () => ({ leaseId: 'lease-1' }),
  onClose: (_outcome, state) => {
    const leaseId: string = state.leaseId;
    void leaseId;
  },
});

const composed = composeModelDrivers(driver, [
  {
    beforeStream: () => ({ depth: 0 }),
    onClose: (_outcome, state) => {
      const depth: number = state.depth;
      void depth;
    },
  },
  {
    transformSignal: () => new AbortController().signal,
  },
]);
void [wrappedSync, wrappedAsync, composed];

// 4. createAgentRuntime: typed per-tool toolApproval input, mountAgentTools(config) overload, history.compact context, and loop.maxDurationMs.
const runtimeTool = defineRuntimeTool({
  name: 'ping_host',
  description: 'Ping a host',
  identity: { serviceName: 'net', action: 'ping', method: 'POST' },
  input: z.object({ host: z.string() }),
  output: z.object({ reachable: z.boolean() }),
  handler: () => ({ reachable: true }),
});

const mountedClean = mountAgentTools({
  runtimeTools: [runtimeTool],
  access: { open: 'local-operator' },
});
void mountedClean;

createAgentRuntime({
  protocol: defineAgentProtocol({
    context: z.object({ tenantId: z.string() }),
    inputMetadata: z.object({}),
  }),
  store: createMemoryAgentRuntimeStore(),
  models: {
    resolve: () => ({
      descriptor: {
        provider: 'test',
        modelId: 'm',
        contextWindow: 128_000,
        capabilities: ['tools'],
      },
      driver,
    }),
  },
  prompt: () => ({
    instructions: 'hi',
    sections: [],
    instructionTokens: { provenance: 'unavailable' },
    contextDecision: 'unavailable',
  }),
  tools: () => ({ deleteFile }),
  history: {
    compact: async ({ context, model, tools, store, conversationId }) => {
      const tenant: string = context.tenantId;
      const win: number = model.contextWindow;
      const hasDelete = tools.deleteFile;
      void [tenant, win, hasDelete];
      return {
        outcome: 'not_needed',
        snapshot: await store.loadSnapshot(conversationId),
        attempts: 1,
      };
    },
  },
  loop: {
    maxDurationMs: 30_000,
    toolApproval: {
      deleteFile: (input, { runtimeContext }) => {
        const path: string = input.path;
        const tenant: string = runtimeContext.tenantId;
        // @ts-expect-error — input is inferred from deleteFile's Zod output, not arbitrary keys.
        const bogus = input.bogusField;
        void [path, tenant, bogus];
        return 'approved';
      },
    },
  },
});

// 5. Structural cross-module compatibility: ProcessSandbox.wrapCommand -> ACP & Codex; DeviceRelayAgent.getState -> DevicePresenceRelayAdapter.
const acpWrap: AcpDriverConfig['wrapCommand'] = sandbox.wrapCommand;
const codexWrap: CodexDriverConfig['wrapCommand'] = sandbox.wrapCommand;
const presenceGetState: DevicePresenceRelayAdapterConfig<
  Record<string, never>,
  string
>['getState'] = relayAgent.getState;
void [acpWrap, codexWrap, presenceGetState];

// 6. defineAgentTool({ output }) with .transform() / .default(): execute returns z.input, toModelOutput receives z.output.
const transformedOutputTool = defineAgentTool({
  description: 'Transform output schema',
  input: z.object({ raw: z.string() }),
  output: z.object({
    n: z.string().transform(Number),
    d: z.boolean().default(true),
  }),
  execute: async ({ raw }) => ({ n: raw }),
  toModelOutput: ({ output }) => {
    const n: number = output.n;
    const d: boolean = output.d;
    // @ts-expect-error — output.n is z.output (number), not string.
    const wrongType: string = output.n;
    void [n, d, wrongType];
    return { type: 'text', value: `${n}:${d}` };
  },
});

defineAgentTool({
  input: z.object({}),
  output: z.object({ n: z.string().transform(Number) }),
  // @ts-expect-error — execute must return z.input (string), not already-transformed number.
  execute: () => ({ n: 42 }),
});

// 6b. defineAgentTool Spotlight #2: typed DefineAgentToolConfig passes cleanly, wrong yield rejected, union Value | AsyncIterable<Value> unwraps distributively.
const typedToolConfig: DefineAgentToolConfig<
  z.ZodObject<{ id: z.ZodString }>,
  { ok: boolean },
  { ok: boolean }
> = {
  input: z.object({ id: z.string() }),
  output: z.object({ ok: z.boolean() }),
  execute: async ({ id }) => ({ ok: id.length > 0 }),
};
const fromTypedConfig = defineAgentTool(typedToolConfig);
void fromTypedConfig;

defineAgentTool({
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
  // @ts-expect-error — streaming execute with output schema must yield z.input<TOutputSchema>.
  async *execute() {
    yield { completelyWrong: 123 };
  },
});

interface SearchAnswer {
  readonly hits: number;
}
declare function maybeStream(flag: boolean): SearchAnswer | AsyncIterable<SearchAnswer>;

const unionReturnTool = defineAgentTool({
  input: z.object({ stream: z.boolean() }),
  execute: ({ stream }) => maybeStream(stream),
  toModelOutput: ({ output }) => {
    const hits: number = output.hits;
    // @ts-expect-error — distributive unwrap removes AsyncIterable from union return.
    const notIter = output[Symbol.asyncIterator];
    void [hits, notIter];
    return { type: 'text', value: String(hits) };
  },
});
void unionReturnTool;

// 7. defineAgentTool with async function* without output: unwraps AsyncIterable chunk type for toModelOutput.
const streamingNoOutputTool = defineAgentTool({
  input: z.object({ topic: z.string() }),
  async *execute({ topic }) {
    yield { phase: 'loading' as const, topic, progress: 50 };
    yield { phase: 'done' as const, topic, progress: 100 };
  },
  toModelOutput: ({ input, output }) => {
    const topic: string = input.topic;
    const progress: number = output.progress;
    const phase: 'loading' | 'done' = output.phase;
    // @ts-expect-error — output is unwrapped chunk element, not AsyncGenerator.
    const notIter = output[Symbol.asyncIterator];
    void [topic, progress, phase, notIter];
    return { type: 'text', value: `${phase}:${progress}` };
  },
});
const dxToolSet: AgentToolSet = { transformedOutputTool, streamingNoOutputTool };
void dxToolSet;

// 8. AgentModelProviderOptions accepts OpenRouterRequestPolicy, OpenAiRequestPolicy, and AnthropicRequestPolicy cleanly (including under exactOptionalPropertyTypes).
declare const orPolicy: OpenRouterRequestPolicy;
declare const oaiPolicy: OpenAiRequestPolicy;
declare const antPolicy: AnthropicRequestPolicy;
const providerOptsAll: AgentModelProviderOptions = {
  openrouter: orPolicy,
  openai: oaiPolicy,
  anthropic: antPolicy,
};
const providerOptsPartial: AgentModelProviderOptions = {
  openrouter: { sessionId: 'sess-1', looseTools: true, provider: { order: ['anthropic'] } },
  openai: { store: false, reasoning: { effort: 'medium' } },
  anthropic: { effort: 'high', thinking: { type: 'adaptive' }, betas: ['b1'] },
};
// Spotlight #1: AgentModelProviderOptionValue exported, z.input rejects functions, AgentModelProviderToolSpec.config handles exactOptionalPropertyTypes.
const optionValue: AgentModelProviderOptionValue = {
  nested: ['a', 1, true, null, { maybe: undefined }],
};
const validSchemaInput: z.input<typeof AgentModelProviderOptionsSchema> = {
  openrouter: { sessionId: 's', nested: optionValue, omitted: undefined },
};
const parsedProviderOptions: AgentModelProviderOptions =
  AgentModelProviderOptionsSchema.parse(validSchemaInput);
void parsedProviderOptions;
const invalidSchemaInput: z.input<typeof AgentModelProviderOptionsSchema> = {
  // @ts-expect-error — functions are not valid AgentModelProviderOptionValue inputs.
  openrouter: { fn: () => 1 },
};
const providerToolSpec: AgentModelProviderToolSpec = {
  type: 'provider',
  id: 'web_search',
  name: 'web_search',
  config: { maxResults: 5, region: undefined, filters: ['news'] },
};
const badProviderToolSpec: AgentModelProviderToolSpec = {
  type: 'provider',
  id: 'web_search',
  name: 'web_search',
  // @ts-expect-error — non-JSON function rejected in AgentModelProviderToolSpec.config.
  config: { fn: () => 1 },
};
void [
  providerOptsAll,
  providerOptsPartial,
  validSchemaInput,
  invalidSchemaInput,
  providerToolSpec,
  badProviderToolSpec,
];

// 9. AgentRuntimeStopPolicy<MyCtx> takes single CONTEXT generic without dummy _TOOLS.
type MyCtx = { readonly tenantId: string; readonly maxStepsOverride?: number };
const myStopPolicy: AgentRuntimeStopPolicy<MyCtx> = {
  name: 'tenant-stop',
  when: ({ context, steps }) => {
    const tenant: string = context.tenantId;
    return tenant.length > 0 && steps.length >= (context.maxStepsOverride ?? 3);
  },
};
void myStopPolicy;

// 10. createToolkit<MyCtx>().mountAgentTools(config) single-argument overload with typed context.
const typedToolkit = createToolkit<MyCtx>();
const singleArgMounted = typedToolkit.mountAgentTools({
  context: { tenantId: 't1' },
  runtimeTools: [runtimeTool],
  access: { open: 'local-operator' },
});
typedToolkit.mountAgentTools({
  // @ts-expect-error — context is checked against MyCtx.
  context: { tenantId: 123 },
  runtimeTools: [runtimeTool],
  access: { open: 'local-operator' },
});
void singleArgMounted;

// 11. createHeadlessAgentHarness with async tools, spread, and loop declared before tools.
const extraHarnessOptions = {
  resources: { load: () => ({ resources: [], diagnostics: [] }) },
  promptBudget: ({ contextWindow }: { contextWindow: number }) => ({
    contextWindow,
    reservedOutput: 512,
    toolSchemas: { value: 100, provenance: 'measured' as const },
    attachments: { value: 0, provenance: 'measured' as const },
    providerOverhead: { provenance: 'unavailable' as const },
  }),
};
createHeadlessAgentHarness({
  protocol: defineAgentProtocol({
    context: z.object({ tenantId: z.string() }),
    inputMetadata: z.object({}),
  }),
  store: createMemoryAgentRuntimeStore(),
  models: {
    resolve: () => ({
      descriptor: {
        provider: 'test',
        modelId: 'm',
        contextWindow: 128_000,
        capabilities: ['tools'],
      },
      driver,
    }),
  },
  ...extraHarnessOptions,
  loop: {
    stopPolicies: [myStopPolicy],
  },
  tools: async (run) => {
    const tenant: string = run.context.tenantId;
    void tenant;
    return { transformedOutputTool, streamingNoOutputTool };
  },
});

// 12. Exhaustive switch on CompleteStreamPart covering attempt-reset and unified toolCallId.
function handleCompletePart(part: CompleteStreamPart): string {
  switch (part.type) {
    case 'ping':
      return 'ping';
    case 'response-metadata':
      return part.id ?? '';
    case 'text-start':
    case 'text-end':
    case 'reasoning-start':
    case 'reasoning-end':
      return part.id;
    case 'text-delta':
    case 'reasoning-delta':
      return part.delta;
    case 'tool-input-start':
      return `${part.toolCallId}:${part.toolName}`;
    case 'tool-input-delta':
      return `${part.toolCallId}:${part.delta}`;
    case 'tool-input-end':
      return part.toolCallId;
    case 'tool-call':
      return `${part.toolCallId}:${part.toolName}`;
    case 'tool-result':
      return `${part.toolCallId}:${String(part.providerExecuted)}`;
    case 'tool-error':
      return `${part.toolCallId}:${part.toolName}`;
    case 'tool-approval-request':
      return `${part.approvalId}:${part.toolCallId}`;
    case 'source':
      return part.source.sourceId;
    case 'file':
      return `${part.mediaType}:${part.filename ?? ''}`;
    case 'reasoning-file':
      return part.mediaType;
    case 'custom':
      return part.kind;
    case 'raw':
      return String(part.rawValue);
    case 'error':
      return String(part.error);
    case 'attempt-reset':
      return `${part.attempt}:${part.reason}`;
    case 'finish-step':
      return `${part.step.stepNumber}`;
    case 'finish':
      return part.finishReason;
    default: {
      const exhaustive: never = part;
      return exhaustive;
    }
  }
}
void handleCompletePart;

// 13. AgentGeneratedFile carries optional filename for persistGeneratedFile.
function checkGeneratedFile(file: AgentGeneratedFile): string | undefined {
  return file.filename;
}
void checkGeneratedFile;

// 14. OpenRouter catalog, pricing ceilings, endpoints, admission, and cache discriminated-union narrowing.
async function checkOpenRouterCatalogDx(
  admissionPolicy: OpenRouterAdmissionPolicy,
  filter: OpenRouterModelFilter,
  snapshotOptions: OpenRouterSnapshotOptions,
) {
  let cached: OpenRouterCatalogSnapshot | null = null;
  const syncStore: OpenRouterCatalogStore = {
    read: () => cached,
    write: (next) => {
      cached = next;
    },
  };
  const asyncStore: OpenRouterCatalogStore = {
    read: async () => cached,
    write: async (next) => {
      cached = next;
    },
  };
  const cacheOptions: OpenRouterCatalogCacheOptions = {
    freshMs: 60_000,
    retryBackoffMs: 5_000,
    store: syncStore,
    endpointsFor: ['anthropic/claude-sonnet-4.6'],
    onError: (err) => {
      void err;
    },
  };
  const badCacheOptions: OpenRouterCatalogCacheOptions = {
    // @ts-expect-error — signal belongs on read()/refresh(), not OpenRouterCatalogCacheOptions.
    signal: new AbortController().signal,
  };
  const cache: OpenRouterCatalogCache = createOpenRouterCatalogCache(cacheOptions);
  const asyncCache: OpenRouterCatalogCache = createOpenRouterCatalogCache({
    store: asyncStore,
  });
  const res: OpenRouterCatalogCacheReadResult = await cache.read();
  if (res.status !== 'unavailable') {
    const observedAt: string = res.observedAt;
    const snap: OpenRouterCatalogSnapshot = res.snapshot;
    const allModels: readonly OpenRouterSnapshotModel[] = res.models;
    const admission = evaluateOpenRouterModelAdmission({
      snapshot: res.snapshot,
      modelId: 'anthropic/claude-sonnet-4.6',
      policy: admissionPolicy,
    });
    const found: OpenRouterSnapshotModel | undefined = findOpenRouterModel(
      res.snapshot,
      'anthropic/claude-sonnet-4.6',
    );
    const filtered: OpenRouterSnapshotModel[] = listOpenRouterModels(res.snapshot, filter);
    if (res.status === 'current') {
      const noErr: undefined = res.lastError;
      void noErr;
    }
    if (found) {
      const ceiling: OpenRouterModelPricingCeiling = resolveOpenRouterModelCeiling(found);
      const summary: OpenRouterEndpointSummary | undefined = found.endpoints
        ? summarizeOpenRouterEndpoints(found.endpoints)
        : undefined;
      void [ceiling, summary];
    }
    void [observedAt, snap, allModels, admission, filtered];
  } else {
    const noneSnap: null = res.snapshot;
    const noneAt: null = res.observedAt;
    const emptyModels: readonly [] = res.models;
    // @ts-expect-error — unavailable snapshot is null and cannot be passed to findOpenRouterModel.
    findOpenRouterModel(res.snapshot, 'anthropic/claude-sonnet-4.6');
    void [noneSnap, noneAt, emptyModels];
  }

  const loaded: OpenRouterCatalogSnapshot =
    await loadOpenRouterCatalogSnapshot(snapshotOptions);
  const endpoints: OpenRouterEndpoint[] = await fetchOpenRouterModelEndpoints(
    'anthropic/claude-sonnet-4.6',
  );
  const endpointSummary: OpenRouterEndpointSummary = summarizeOpenRouterEndpoints(endpoints);
  void [badCacheOptions, asyncCache, loaded, endpointSummary];
}
void checkOpenRouterCatalogDx;
