import type { ZodType, z } from 'zod';
import type { AgentInstructions, AgentModelMessage } from '../agent-parts/model';
import type { AgentStepResult } from './models-driver-step';
import {
  AgentJsonObjectSchema,
  type AgentMessage,
  type AgentMessagePart,
  AgentMessageSchema,
  type AgentTerminalReason,
} from './schemas';

export interface AgentTerminalAcceptanceInput {
  message: AgentMessage;
  reason: AgentTerminalReason;
  policyName?: string;
  /** Completed model steps produced so far in this run. */
  steps?: readonly AgentStepResult[];
  /** Number of terminal continuations already executed in this run. */
  continuations?: number;
}

/**
 * Verdict returned by `protocol.acceptTerminal`:
 * - `true` / `{ action: 'accept' }`: commit the terminal message as-is.
 * - `false` / `{ action: 'reject' }`: reject as `output_rejected`.
 * - `{ action: 'continue', message, instructions? }`: append `message` and run another
 *   bounded continuation step (capped by `loop.maxContinuations`, default 3).
 */
export type AgentTerminalAcceptanceDecision =
  | boolean
  | { readonly action: 'accept' }
  | { readonly action: 'reject' }
  | {
      readonly action: 'continue';
      readonly message: AgentModelMessage;
      readonly instructions?: AgentInstructions;
    };

export type AgentTerminalAcceptance =
  | 'allow-empty'
  | 'require-output'
  | ((
      input: AgentTerminalAcceptanceInput,
    ) => AgentTerminalAcceptanceDecision | Promise<AgentTerminalAcceptanceDecision>);

/** Pure helper: whether any completed step performed tool work (client or provider). */
export function carriedToolWork(steps: readonly AgentStepResult[]): boolean {
  return steps.some(
    (step) =>
      step.toolCalls.length > 0 ||
      step.toolResults.length > 0 ||
      step.content.some(
        (part) =>
          part.type === 'tool-call' ||
          part.type === 'tool-result' ||
          part.type === 'tool-error',
      ),
  );
}

/** Generic final-output policy used by `terminalAcceptance: 'require-output'`. */
export function hasAgentTerminalOutput(input: AgentTerminalAcceptanceInput): boolean {
  for (const part of input.message.parts) {
    if (part.type === 'text' && part.text.trim().length > 0) return true;
    if (part.type === 'file' || part.type === 'provider') return true;
    if (
      input.reason === 'policy_stop' &&
      (part.type === 'tool-call' || part.type === 'tool-result')
    ) {
      return true;
    }
  }
  return false;
}

export interface AgentProtocolConfig<CONTEXT extends ZodType, INPUT_METADATA extends ZodType> {
  context: CONTEXT;
  inputMetadata: INPUT_METADATA;
  /**
   * Validate a would-be completed assistant before its terminal CAS.
   *
   * Default `allow-empty` preserves protocols where an empty stop is valid.
   * `require-output` accepts non-blank text, generated files, structured opaque
   * provider output, and an explicit tool-only policy stop. A callback owns any
   * product-specific definition without rewriting a committed terminal record,
   * and may return `{ action: 'continue', message }` for bounded continuation.
   */
  terminalAcceptance?: AgentTerminalAcceptance;
}

export interface AgentProtocol<CONTEXT extends ZodType, INPUT_METADATA extends ZodType> {
  contextSchema: CONTEXT;
  inputMetadataSchema: INPUT_METADATA;
  parseContext(input: unknown): z.infer<CONTEXT>;
  parseInputMetadata(input: unknown): z.infer<typeof AgentJsonObjectSchema>;
  parseMessage(input: unknown): AgentMessage;
  parsePart(input: unknown): AgentMessagePart;
  acceptTerminal?(
    input: AgentTerminalAcceptanceInput,
  ): AgentTerminalAcceptanceDecision | Promise<AgentTerminalAcceptanceDecision>;
}

export function defineAgentProtocol<CONTEXT extends ZodType, INPUT_METADATA extends ZodType>(
  config: AgentProtocolConfig<CONTEXT, INPUT_METADATA>,
): AgentProtocol<CONTEXT, INPUT_METADATA> {
  const acceptance = config.terminalAcceptance;
  return {
    contextSchema: config.context,
    inputMetadataSchema: config.inputMetadata,
    parseContext: (input) => config.context.parse(input),
    parseInputMetadata: (input) =>
      AgentJsonObjectSchema.parse(config.inputMetadata.parse(input)),
    parseMessage: (input) => AgentMessageSchema.parse(input),
    parsePart: (input) => AgentMessageSchema.shape.parts.element.parse(input),
    ...(acceptance !== undefined &&
      acceptance !== 'allow-empty' && {
        acceptTerminal: acceptance === 'require-output' ? hasAgentTerminalOutput : acceptance,
      }),
  };
}
