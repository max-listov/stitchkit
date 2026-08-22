import { type FilePart, type ModelMessage, modelMessageSchema } from 'ai';
import type { AgentMessage, AgentMessagePart, AgentProviderEnvelope } from './schemas';

export interface AgentHistoryProjectionOptions {
  resolveFile?(
    part: Extract<AgentMessagePart, { type: 'file' }>,
    message: AgentMessage,
  ): FilePart['data'] | Promise<FilePart['data']>;
  unresolvedFile?: 'text' | 'omit' | 'error';
}

function providerOptions(envelope: AgentProviderEnvelope | undefined) {
  if (!envelope) return undefined;
  return envelope.provider === 'ai-sdk'
    ? envelope.data
    : { [envelope.provider]: envelope.data };
}

function textContent(parts: readonly AgentMessagePart[]): string {
  return parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

async function userMessage(
  message: AgentMessage,
  options: AgentHistoryProjectionOptions,
): Promise<ModelMessage | undefined> {
  const text = textContent(message.parts);
  const content: unknown[] = [];
  if (text) content.push({ type: 'text', text });
  for (const part of message.parts) {
    if (part.type !== 'file') continue;
    if (options.resolveFile) {
      content.push({
        type: 'file',
        data: await options.resolveFile(part, message),
        mediaType: part.mediaType,
        ...(part.filename && { filename: part.filename }),
      });
      continue;
    }
    const fallback = options.unresolvedFile ?? 'text';
    if (fallback === 'error') {
      throw new Error(`No history file resolver configured for ${part.reference}`);
    }
    if (fallback === 'text') {
      content.push({ type: 'text', text: `[attachment: ${part.reference}]` });
    }
  }
  if (content.length === 0) return undefined;
  return modelMessageSchema.parse({ role: 'user', content });
}

function assistantMessages(message: AgentMessage): ModelMessage[] {
  const assistantContent: unknown[] = [];
  const toolContent: unknown[] = [];
  for (const part of message.parts) {
    if (part.type === 'text') assistantContent.push({ type: 'text', text: part.text });
    if (part.type === 'reasoning') {
      assistantContent.push({
        type: 'reasoning',
        text: part.text,
        ...(part.provider && { providerOptions: providerOptions(part.provider) }),
      });
    }
    if (part.type === 'tool-call') {
      assistantContent.push({
        type: 'tool-call',
        toolCallId: part.callId,
        toolName: part.toolName,
        input: part.input,
        ...(part.provider && { providerOptions: providerOptions(part.provider) }),
      });
    }
    if (part.type === 'tool-result') {
      const output =
        part.outcome === 'success'
          ? { type: 'json', value: part.output ?? null }
          : { type: 'error-json', value: part.output ?? { message: part.outcome } };
      toolContent.push({
        type: 'tool-result',
        toolCallId: part.callId,
        toolName: part.toolName,
        output,
      });
    }
  }
  const messages: ModelMessage[] = [];
  if (assistantContent.length > 0) {
    messages.push(modelMessageSchema.parse({ role: 'assistant', content: assistantContent }));
  }
  if (toolContent.length > 0) {
    messages.push(modelMessageSchema.parse({ role: 'tool', content: toolContent }));
  }
  return messages;
}

/** Project canonical engine records into provider-valid AI SDK messages. */
export async function projectAgentHistory(
  messages: readonly AgentMessage[],
  options: AgentHistoryProjectionOptions = {},
): Promise<ModelMessage[]> {
  const projected: ModelMessage[] = [];
  for (const message of messages) {
    if (message.status === 'streaming' || message.status === 'failed') continue;
    if (message.role === 'user') {
      const user = await userMessage(message, options);
      if (user) projected.push(user);
      continue;
    }
    if (message.role === 'system' || message.role === 'summary') {
      const content = textContent(message.parts);
      if (content) projected.push(modelMessageSchema.parse({ role: 'system', content }));
      continue;
    }
    projected.push(...assistantMessages(message));
  }
  return projected;
}
