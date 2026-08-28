import type { ZodType, z } from 'zod';
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
}

export type AgentTerminalAcceptance =
  | 'allow-empty'
  | 'require-output'
  | ((input: AgentTerminalAcceptanceInput) => boolean | Promise<boolean>);

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
   * product-specific definition without rewriting a committed terminal record.
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
  acceptTerminal?(input: AgentTerminalAcceptanceInput): boolean | Promise<boolean>;
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
