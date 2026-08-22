import { type FilePart, type ModelMessage, modelMessageSchema } from 'ai';
import type { AgentMessage, AgentMessagePart, AgentProviderEnvelope } from './schemas';

export interface AgentHistoryProjectionOptions {
  resolveFile?(
    part: Extract<AgentMessagePart, { type: 'file' }>,
    message: AgentMessage,
  ): FilePart['data'] | Promise<FilePart['data']>;
  unresolvedFile?: 'text' | 'omit' | 'error';
  leadingAssistant?: 'omit' | 'allow' | 'error';
  incompleteToolTurn?: 'omit' | 'error';
}

export interface AgentHistoryProjectionDecision {
  messageId: string;
  action: 'projected' | 'omitted';
  reason:
    | 'projected'
    | 'draft-or-failed'
    | 'empty'
    | 'leading-assistant'
    | 'incomplete-tool-turn';
}

export interface AgentHistoryProjectionResult {
  messages: readonly ModelMessage[];
  decisions: readonly AgentHistoryProjectionDecision[];
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

function completeToolChronology(message: AgentMessage): boolean {
  const calls = new Set(
    message.parts.filter((part) => part.type === 'tool-call').map((part) => part.callId),
  );
  const results = new Set(
    message.parts.filter((part) => part.type === 'tool-result').map((part) => part.callId),
  );
  return (
    [...calls].every((callId) => results.has(callId)) &&
    [...results].every((callId) => calls.has(callId))
  );
}

/** Project history and retain a decision for every canonical record. */
export async function projectAgentHistoryDetailed(
  messages: readonly AgentMessage[],
  options: AgentHistoryProjectionOptions = {},
): Promise<AgentHistoryProjectionResult> {
  const projected: ModelMessage[] = [];
  const decisions: AgentHistoryProjectionDecision[] = [];
  let observedUser = false;
  for (const message of messages) {
    if (message.status === 'streaming' || message.status === 'failed') {
      decisions.push({ messageId: message.id, action: 'omitted', reason: 'draft-or-failed' });
      continue;
    }
    if (message.role === 'user') {
      const user = await userMessage(message, options);
      observedUser = true;
      if (user) {
        projected.push(user);
        decisions.push({ messageId: message.id, action: 'projected', reason: 'projected' });
      } else {
        decisions.push({ messageId: message.id, action: 'omitted', reason: 'empty' });
      }
      continue;
    }
    if (message.role === 'system' || message.role === 'summary') {
      const content = textContent(message.parts);
      if (content) {
        projected.push(modelMessageSchema.parse({ role: 'system', content }));
        decisions.push({ messageId: message.id, action: 'projected', reason: 'projected' });
      } else {
        decisions.push({ messageId: message.id, action: 'omitted', reason: 'empty' });
      }
      continue;
    }
    if (!observedUser && options.leadingAssistant !== 'allow') {
      if (options.leadingAssistant === 'error') {
        throw new Error(`Assistant message ${message.id} precedes the first user message`);
      }
      decisions.push({
        messageId: message.id,
        action: 'omitted',
        reason: 'leading-assistant',
      });
      continue;
    }
    if (!completeToolChronology(message)) {
      if (options.incompleteToolTurn === 'error') {
        throw new Error(`Assistant message ${message.id} has incomplete tool chronology`);
      }
      decisions.push({
        messageId: message.id,
        action: 'omitted',
        reason: 'incomplete-tool-turn',
      });
      continue;
    }
    const assistant = assistantMessages(message);
    projected.push(...assistant);
    decisions.push({
      messageId: message.id,
      action: assistant.length > 0 ? 'projected' : 'omitted',
      reason: assistant.length > 0 ? 'projected' : 'empty',
    });
  }
  return { messages: projected, decisions };
}

/** Project canonical engine records into provider-valid AI SDK messages. */
export async function projectAgentHistory(
  messages: readonly AgentMessage[],
  options: AgentHistoryProjectionOptions = {},
): Promise<ModelMessage[]> {
  return [...(await projectAgentHistoryDetailed(messages, options)).messages];
}
