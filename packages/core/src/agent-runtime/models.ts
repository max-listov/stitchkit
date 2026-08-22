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
});

export type AgentModelDescriptor = z.infer<typeof AgentModelDescriptorSchema>;

export interface AgentLanguageModelProvider {
  create(modelId: string): LanguageModel;
  normalizeUsage?(input: {
    usage: LanguageModelUsage;
    providerMetadata?: unknown;
  }): AgentUsage;
}

export interface AgentModelDeclaration extends AgentModelDescriptor {
  provider: string;
}

export interface AgentModelRegistryConfig<
  MODELS extends Record<string, AgentModelDeclaration>,
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
  resolve(key: MODEL_KEY, capabilities?: readonly AgentModelCapability[]): AgentResolvedModel;
}

export function defineModelRegistry<MODELS extends Record<string, AgentModelDeclaration>>(
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

  return {
    keys: () => [...descriptors.keys()],
    descriptor,
    supports,
    resolve(key, required = []) {
      const selected = descriptor(key);
      if (!supports(key, required)) {
        throw new Error(`Agent model ${key} does not satisfy required capabilities`);
      }
      const provider = config.providers[selected.provider];
      if (!provider) throw new Error(`Unknown agent model provider: ${selected.provider}`);
      return {
        descriptor: selected,
        model: provider.create(selected.modelId),
        ...(provider.normalizeUsage && { normalizeUsage: provider.normalizeUsage }),
      };
    },
  };
}
