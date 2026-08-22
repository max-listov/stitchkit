import type { ZodType, z } from 'zod';
import {
  AgentJsonObjectSchema,
  type AgentMessage,
  type AgentMessagePart,
  AgentMessageSchema,
} from './schemas';

export interface AgentProtocolConfig<CONTEXT extends ZodType, INPUT_METADATA extends ZodType> {
  context: CONTEXT;
  inputMetadata: INPUT_METADATA;
}

export interface AgentProtocol<CONTEXT extends ZodType, INPUT_METADATA extends ZodType> {
  contextSchema: CONTEXT;
  inputMetadataSchema: INPUT_METADATA;
  parseContext(input: unknown): z.infer<CONTEXT>;
  parseInputMetadata(input: unknown): z.infer<typeof AgentJsonObjectSchema>;
  parseMessage(input: unknown): AgentMessage;
  parsePart(input: unknown): AgentMessagePart;
}

export function defineAgentProtocol<CONTEXT extends ZodType, INPUT_METADATA extends ZodType>(
  config: AgentProtocolConfig<CONTEXT, INPUT_METADATA>,
): AgentProtocol<CONTEXT, INPUT_METADATA> {
  return {
    contextSchema: config.context,
    inputMetadataSchema: config.inputMetadata,
    parseContext: (input) => config.context.parse(input),
    parseInputMetadata: (input) =>
      AgentJsonObjectSchema.parse(config.inputMetadata.parse(input)),
    parseMessage: (input) => AgentMessageSchema.parse(input),
    parsePart: (input) => AgentMessageSchema.shape.parts.element.parse(input),
  };
}
