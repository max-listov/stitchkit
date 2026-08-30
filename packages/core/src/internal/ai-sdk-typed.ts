import { type ModelMessage, modelMessageSchema, streamText, type ToolSet } from 'ai';
import { isRecord, transportResult } from './typed';

/**
 * AI SDK derives conditional `toolsContext` requirements from each structural tool in a generic
 * set. AgentRuntime receives that set after canonical mounting, so TypeScript cannot prove the
 * conditional options object even though the SDK validates it at this adapter boundary.
 */
export function streamAgentTextBoundary<TOOLS extends ToolSet>(
  options: unknown,
): ReturnType<typeof streamText<TOOLS, never>> {
  return streamText<TOOLS>(options as Parameters<typeof streamText<TOOLS>>[0]) as ReturnType<
    typeof streamText<TOOLS, never>
  >;
}

/**
 * `modelMessageSchema` in the current AI SDK runtime validates approval requests but strips their
 * optional signature even though the public type and approval verifier require it. Validate the
 * full message first, then restore only the already-validated string at this SDK adapter boundary.
 */
export function modelMessageWithApprovalSignature(input: unknown): ModelMessage {
  const parsed = modelMessageSchema.parse(input);
  const rawContent = isRecord(input) ? input.content : undefined;
  if (
    parsed.role !== 'assistant' ||
    typeof parsed.content === 'string' ||
    !Array.isArray(rawContent)
  ) {
    return parsed;
  }
  const content = parsed.content.map((part, index) => {
    const raw = rawContent[index];
    if (
      part.type !== 'tool-approval-request' ||
      !isRecord(raw) ||
      typeof raw.signature !== 'string'
    ) {
      return part;
    }
    return { ...part, signature: raw.signature };
  });
  return transportResult<ModelMessage>({ ...parsed, content });
}
