import type { LanguageModel, LanguageModelUsage } from 'ai';
import { z } from 'zod';
import type { AgentUsage } from './schemas';

export const AgentModelCapabilitySchema = z.enum(['tools', 'vision', 'reasoning', 'files']);

export type AgentModelCapability = z.infer<typeof AgentModelCapabilitySchema>;

export const AgentModelDescriptorSchema = z.object({
  provider: z.string().min(1),
  modelId: z.string().min(1),
  contextWindow: z.int().positive(),
  capabilities: z.array(AgentModelCapabilitySchema),
  observedAt: z.iso.datetime({ offset: true }).optional(),
  source: z.string().min(1).optional(),
  availability: z.enum(['available', 'unavailable']).optional(),
});

export type AgentModelDescriptor = z.infer<typeof AgentModelDescriptorSchema>;

export const AgentModelRegistrySnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.string().min(1),
  observedAt: z.iso.datetime({ offset: true }),
  models: z.record(z.string().min(1), AgentModelDescriptorSchema),
});

export type AgentModelRegistrySnapshot = z.infer<typeof AgentModelRegistrySnapshotSchema>;

export const AgentModelPriceSchema = z
  .object({
    currency: z.string().length(3),
    inputPerToken: z
      .string()
      .regex(/^\d+(?:\.\d+)?$/)
      .optional(),
    outputPerToken: z
      .string()
      .regex(/^\d+(?:\.\d+)?$/)
      .optional(),
  })
  .strict();

export const AgentModelMetricSchema = z
  .object({
    metric: z.string().min(1),
    value: z.number(),
    unit: z.enum(['index', 'elo', 'percent', 'milliseconds']),
    source: z.string().min(1),
    observedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const AgentModelPopularitySchema = z
  .object({
    rank: z.int().positive(),
    window: z.literal('week'),
    source: z.string().min(1),
    observedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const AgentModelCatalogEntrySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    descriptor: AgentModelDescriptorSchema,
    description: z.string().optional(),
    price: AgentModelPriceSchema.optional(),
    popularity: AgentModelPopularitySchema.optional(),
    metrics: z.array(AgentModelMetricSchema),
  })
  .strict();

export const AgentModelCatalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    source: z.string().min(1),
    observedAt: z.iso.datetime({ offset: true }),
    completeness: z.enum(['complete', 'partial']),
    models: z.array(AgentModelCatalogEntrySchema),
    diagnostics: z.array(z.string()),
  })
  .strict();

export const AgentModelSelectionSchema = z
  .object({
    modelId: z.string().min(1),
    selectedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const AgentModelSearchInputSchema = z
  .object({ query: z.string().max(256).default(''), limit: z.int().positive().max(200) })
  .strict();

export const AgentModelSearchResultSchema = z
  .object({
    models: z.array(AgentModelCatalogEntrySchema),
    total: z.int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();

export type AgentModelPrice = z.infer<typeof AgentModelPriceSchema>;
export type AgentModelMetric = z.infer<typeof AgentModelMetricSchema>;
export type AgentModelPopularity = z.infer<typeof AgentModelPopularitySchema>;
export type AgentModelCatalogEntry = z.infer<typeof AgentModelCatalogEntrySchema>;
export type AgentModelCatalog = z.infer<typeof AgentModelCatalogSchema>;
export type AgentModelSelection = z.infer<typeof AgentModelSelectionSchema>;
export type AgentModelSearchInput = z.infer<typeof AgentModelSearchInputSchema>;
export type AgentModelSearchResult = z.infer<typeof AgentModelSearchResultSchema>;

export function searchAgentModelCatalog(
  catalog: AgentModelCatalog,
  rawInput: AgentModelSearchInput,
): AgentModelSearchResult {
  const input = AgentModelSearchInputSchema.parse(rawInput);
  const terms = input.query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const matches = catalog.models.filter((model) => {
    const searchable =
      `${model.id}\n${model.name}\n${model.description ?? ''}`.toLocaleLowerCase();
    return terms.every((term) => searchable.includes(term));
  });
  return AgentModelSearchResultSchema.parse({
    models: matches.slice(0, input.limit),
    total: matches.length,
    truncated: matches.length > input.limit,
  });
}

export interface AgentModelCatalogProvider {
  load(input?: { signal?: AbortSignal }): Promise<AgentModelCatalog>;
}

export interface AgentModelSelectionStore {
  load(
    conversationId: string,
  ): AgentModelSelection | undefined | Promise<AgentModelSelection | undefined>;
  save(conversationId: string, selection: AgentModelSelection): void | Promise<void>;
}

export function createMemoryAgentModelSelectionStore(): AgentModelSelectionStore {
  const selections = new Map<string, AgentModelSelection>();
  return {
    load: (conversationId) => selections.get(conversationId),
    save(conversationId, rawSelection) {
      selections.set(conversationId, AgentModelSelectionSchema.parse(rawSelection));
    },
  };
}

export interface AgentLanguageModelProvider {
  create(modelId: string): LanguageModel;
  normalizeUsage?(input: {
    usage: LanguageModelUsage;
    providerMetadata?: unknown;
  }): AgentUsage;
}

export interface AgentModelRegistryConfig<
  MODELS extends Record<string, AgentModelDescriptor>,
> {
  models: MODELS;
  providers: Readonly<Record<string, AgentLanguageModelProvider>>;
}

export interface AgentResolvedModel {
  descriptor: AgentModelDescriptor;
  model: LanguageModel;
  normalizeUsage?: AgentLanguageModelProvider['normalizeUsage'];
}

export interface AgentModelRegistry<MODEL_KEY extends string> {
  keys(): readonly MODEL_KEY[];
  descriptor(key: MODEL_KEY): AgentModelDescriptor;
  supports(key: MODEL_KEY, capabilities: readonly AgentModelCapability[]): boolean;
  preflight(
    key: MODEL_KEY,
    capabilities?: readonly AgentModelCapability[],
  ): AgentModelDescriptor;
  resolve(key: MODEL_KEY, capabilities?: readonly AgentModelCapability[]): AgentResolvedModel;
  snapshot(input: { source: string; observedAt: string }): AgentModelRegistrySnapshot;
}

export function defineModelRegistry<MODELS extends Record<string, AgentModelDescriptor>>(
  config: AgentModelRegistryConfig<MODELS>,
): AgentModelRegistry<Extract<keyof MODELS, string>> {
  type ModelKey = Extract<keyof MODELS, string>;
  const descriptors = new Map<ModelKey, AgentModelDescriptor>();
  for (const key in config.models) {
    const declaration = config.models[key];
    if (declaration) descriptors.set(key, AgentModelDescriptorSchema.parse(declaration));
  }

  const descriptor = (key: ModelKey): AgentModelDescriptor => {
    const found = descriptors.get(key);
    if (!found) throw new Error(`Unknown agent model: ${key}`);
    return found;
  };

  const supports = (key: ModelKey, capabilities: readonly AgentModelCapability[]): boolean => {
    const available = new Set(descriptor(key).capabilities);
    return capabilities.every((capability) => available.has(capability));
  };

  const preflight = (
    key: ModelKey,
    required: readonly AgentModelCapability[] = [],
  ): AgentModelDescriptor => {
    const selected = descriptor(key);
    if (selected.availability === 'unavailable') {
      throw new Error(`Agent model ${key} is unavailable`);
    }
    if (!supports(key, required)) {
      throw new Error(`Agent model ${key} does not satisfy required capabilities`);
    }
    if (!config.providers[selected.provider]) {
      throw new Error(`Unknown agent model provider: ${selected.provider}`);
    }
    return selected;
  };

  return {
    keys: () => [...descriptors.keys()],
    descriptor,
    supports,
    preflight,
    resolve(key, required = []) {
      const selected = preflight(key, required);
      const provider = config.providers[selected.provider];
      if (!provider) throw new Error(`Unknown agent model provider: ${selected.provider}`);
      return {
        descriptor: selected,
        model: provider.create(selected.modelId),
        ...(provider.normalizeUsage && { normalizeUsage: provider.normalizeUsage }),
      };
    },
    snapshot(input) {
      return AgentModelRegistrySnapshotSchema.parse({
        schemaVersion: 1,
        source: input.source,
        observedAt: input.observedAt,
        models: Object.fromEntries(descriptors.entries()),
      });
    },
  };
}

export interface AgentModelSnapshotPolicy {
  maxAgeMs: number;
  now?: () => Date;
}

/** Validate an optional discovery snapshot without making discovery a startup dependency. */
export function validateAgentModelSnapshot(
  input: unknown,
  policy: AgentModelSnapshotPolicy,
): AgentModelRegistrySnapshot {
  if (!Number.isSafeInteger(policy.maxAgeMs) || policy.maxAgeMs < 0) {
    throw new TypeError('maxAgeMs must be a non-negative safe integer');
  }
  const snapshot = AgentModelRegistrySnapshotSchema.parse(input);
  const now = policy.now?.() ?? new Date();
  const age = now.getTime() - new Date(snapshot.observedAt).getTime();
  if (age < 0 || age > policy.maxAgeMs) {
    throw new Error(`Agent model snapshot from ${snapshot.source} is stale`);
  }
  return snapshot;
}
