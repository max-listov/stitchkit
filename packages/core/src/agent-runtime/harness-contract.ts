import type { ToolSet } from 'ai';
import { z } from 'zod';
import type { AgentRuntimeEvent } from './events';
import { AgentModelDescriptorSchema, type AgentResolvedModel } from './models';
import type { AgentPromptBudget, AgentTokenCount } from './prompt';
import type { AgentRuntime, AgentRuntimeConfig, AgentRuntimeRunContext } from './runtime';
import type { AgentRun, AgentSnapshot } from './schemas';

export const AgentHarnessResourceKindSchema = z.enum(['instruction', 'skill', 'resource']);

export const AgentHarnessResourceSchema = z
  .object({
    kind: AgentHarnessResourceKindSchema,
    name: z.string().min(1),
    text: z.string(),
    provenance: z.string().min(1),
  })
  .strict();

export const AgentHarnessResourceDiagnosticSchema = z
  .object({
    resource: z.string().min(1),
    severity: z.enum(['warning', 'error']),
    message: z.string().min(1),
  })
  .strict();

export const AgentHarnessLimitsSchema = z
  .object({
    maxResources: z.int().positive(),
    maxResourceBytes: z.int().positive(),
    maxDiagnostics: z.int().nonnegative(),
  })
  .strict();

export const AgentHarnessAppliedResourceSchema = AgentHarnessResourceSchema.omit({
  text: true,
});

export const AgentHarnessProfileEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    type: z.literal('profile-applied'),
    conversationId: z.string().min(1),
    runId: z.string().min(1),
    model: AgentModelDescriptorSchema,
    resources: z.array(AgentHarnessAppliedResourceSchema),
    diagnostics: z.array(AgentHarnessResourceDiagnosticSchema),
    toolNames: z.array(z.string().min(1)),
  })
  .strict();

export type AgentHarnessResourceKind = z.infer<typeof AgentHarnessResourceKindSchema>;
export type AgentHarnessResource = z.infer<typeof AgentHarnessResourceSchema>;
export type AgentHarnessResourceDiagnostic = z.infer<
  typeof AgentHarnessResourceDiagnosticSchema
>;
export type AgentHarnessLimits = z.infer<typeof AgentHarnessLimitsSchema>;
export type AgentHarnessProfileEvent = z.infer<typeof AgentHarnessProfileEventSchema>;

export interface AgentHarnessResourceResult {
  resources: readonly AgentHarnessResource[];
  diagnostics: readonly AgentHarnessResourceDiagnostic[];
}

export interface HeadlessAgentModelResolver<CONTEXT> {
  preflight?(input: { context: CONTEXT; conversationId: string }): void | Promise<void>;
  resolve(input: {
    context: CONTEXT;
    conversationId: string;
    run: AgentRun;
    snapshot: AgentSnapshot;
  }): AgentResolvedModel | Promise<AgentResolvedModel>;
}

export interface HeadlessAgentHarnessConfig<CONTEXT, TOOLS extends ToolSet>
  extends Omit<AgentRuntimeConfig<CONTEXT, TOOLS>, 'models' | 'prompt' | 'tools'> {
  models: HeadlessAgentModelResolver<CONTEXT>;
  resources: {
    load(input: {
      context: CONTEXT;
      signal: AbortSignal;
      model: AgentResolvedModel;
      snapshot: AgentSnapshot;
    }): AgentHarnessResourceResult | Promise<AgentHarnessResourceResult>;
    onDiagnostics?(input: {
      context: CONTEXT;
      diagnostics: readonly AgentHarnessResourceDiagnostic[];
    }): void | Promise<void>;
  };
  tools(input: AgentRuntimeRunContext<CONTEXT>): TOOLS | Promise<TOOLS>;
  promptBudget(input: {
    context: CONTEXT;
    contextWindow: number;
  }): AgentPromptBudget | Promise<AgentPromptBudget>;
  estimateResourceTokens?(text: string): AgentTokenCount | Promise<AgentTokenCount>;
  limits?: Partial<AgentHarnessLimits>;
  onProfile?(event: AgentHarnessProfileEvent): void | Promise<void>;
  onProfileError?(input: {
    event: AgentHarnessProfileEvent;
    error: unknown;
  }): void | Promise<void>;
}

export interface HeadlessAgentHarness<CONTEXT> extends AgentRuntime<CONTEXT> {
  snapshot(conversationId: string): Promise<AgentSnapshot>;
  subscribe(listener: (event: AgentRuntimeEvent) => void | Promise<void>): () => void;
  pendingApprovals(conversationId: string): Promise<readonly AgentHarnessPendingApproval[]>;
  respondToApproval(
    input: AgentHarnessApprovalDecision<CONTEXT>,
  ): Promise<ReturnType<AgentRuntime<CONTEXT>['submit']>>;
}

export interface AgentHarnessPendingApproval {
  conversationId: string;
  runId: string;
  messageId: string;
  approvalId: string;
  callId: string;
  toolName: string;
  input: unknown;
  signature?: string;
}

export interface AgentHarnessApprovalDecision<_CONTEXT = unknown> {
  conversationId: string;
  approvalId: string;
  approved: boolean;
  reason?: string;
  context: unknown;
  metadata?: unknown;
}

export interface HarnessPromptProfile {
  conversationId: string;
  model: AgentResolvedModel;
  resources: readonly AgentHarnessResource[];
  diagnostics: readonly AgentHarnessResourceDiagnostic[];
}

export interface HarnessPendingProfile {
  prompt?: HarnessPromptProfile;
  toolNames?: readonly string[];
  emitting?: Promise<void>;
}
