import {
  type AgentModelMessage,
  AgentModelMessageSchema,
  type AgentToolModelOutput,
  AgentToolModelOutputSchema,
} from '../agent-parts/model';
import type { AgentHistoryProjectionOptions } from './history';
import { envelopeToProviderOptions } from './provider-media';
import type { AgentMessage, AgentMessagePart } from './schemas';

export type HistoryPartType = AgentMessagePart['type'];

/**
 * What an interrupted or failed turn says about itself.
 *
 * Driven by the message *status*, not by the presence of a `control` part: the
 * abort path that does not throw commits an interrupted assistant without one,
 * so a marker conditioned on the part would be missing from exactly the runs a
 * newer input ended.
 */
const INTERRUPTION_NOTE = '[interrupted: this turn was cut off before it finished]';
const FAILURE_NOTE =
  '[failed: partial evidence from a run that did not complete successfully]';

export function textContent(parts: readonly AgentMessagePart[]): string {
  return parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

async function resolveHistoryFilePart(
  part: Extract<AgentMessagePart, { type: 'file' }>,
  message: AgentMessage,
  options: AgentHistoryProjectionOptions,
): Promise<unknown | undefined> {
  if (options.resolveFile) {
    return {
      type: 'file',
      data: await options.resolveFile(part, message),
      mediaType: part.mediaType,
      ...(part.filename && { filename: part.filename }),
    };
  }
  const fallback = options.unresolvedFile ?? 'omit';
  if (fallback === 'error') {
    // Thrown into the application's own process, so it names the reference:
    // inward we owe the operator everything. The provider never sees it.
    throw new Error(`No history file resolver configured for ${part.reference}`);
  }
  if (fallback === 'text') {
    // `part.reference` is an address in the application's storage — an object
    // key or a path. It identifies our infrastructure, and this string is
    // sent upstream, so the placeholder describes the attachment instead.
    const described = part.filename ?? part.mediaType;
    return {
      type: 'text',
      text: described ? `[attachment: ${described}]` : '[attachment]',
    };
  }
  return undefined;
}

export async function projectUserMessage(
  message: AgentMessage,
  options: AgentHistoryProjectionOptions,
): Promise<{ message?: AgentModelMessage; rendered: Set<HistoryPartType> }> {
  const rendered = new Set<HistoryPartType>();
  const text = textContent(message.parts);
  const content: unknown[] = [];
  if (text) {
    content.push({ type: 'text', text });
    rendered.add('text');
  }
  for (const part of message.parts) {
    if (part.type !== 'file') continue;
    const projectedFile = await resolveHistoryFilePart(part, message, options);
    if (projectedFile !== undefined) {
      content.push(projectedFile);
      rendered.add('file');
    }
  }
  if (content.length === 0) return { rendered };
  return { message: AgentModelMessageSchema.parse({ role: 'user', content }), rendered };
}

async function projectToolResultOutput(
  part: Extract<AgentMessagePart, { type: 'tool-result' }>,
  callInput: unknown,
  options: AgentHistoryProjectionOptions,
): Promise<AgentToolModelOutput> {
  if (options.resolveToolModelOutput) {
    const resolved = await options.resolveToolModelOutput({
      toolCallId: part.callId,
      toolName: part.toolName,
      input: callInput,
      output: part.output,
      outcome: part.outcome,
    });
    if (resolved !== undefined) return AgentToolModelOutputSchema.parse(resolved);
  }
  if (
    part.outcome === 'success' &&
    options.tools &&
    Object.hasOwn(options.tools, part.toolName)
  ) {
    const tool = options.tools[part.toolName];
    if (tool?.toModelOutput) {
      return AgentToolModelOutputSchema.parse(
        await tool.toModelOutput({
          toolCallId: part.callId,
          input: callInput,
          output: part.output,
        }),
      );
    }
  }
  return part.outcome === 'success'
    ? { type: 'json', value: part.output ?? null }
    : { type: 'error-json', value: part.output ?? { message: part.outcome } };
}

export async function projectAssistantMessages(
  message: AgentMessage,
  marker: 'interrupted' | 'failed' | undefined,
  options: AgentHistoryProjectionOptions,
  callInputsById: Map<string, unknown>,
): Promise<{ messages: AgentModelMessage[]; rendered: Set<HistoryPartType> }> {
  const rendered = new Set<HistoryPartType>();
  const messages: AgentModelMessage[] = [];
  let role: 'assistant' | 'tool' | undefined;
  let content: unknown[] = [];
  const flush = (): void => {
    if (!role || content.length === 0) return;
    messages.push(AgentModelMessageSchema.parse({ role, content }));
    content = [];
  };
  const append = (nextRole: 'assistant' | 'tool', part: unknown): void => {
    if (role !== nextRole) {
      flush();
      role = nextRole;
    }
    content.push(part);
  };
  for (const part of message.parts) {
    if (part.type === 'text') {
      const providerOptions = envelopeToProviderOptions(part.provider);
      append('assistant', {
        type: 'text',
        text: part.text,
        ...(providerOptions && { providerOptions }),
      });
      rendered.add('text');
    } else if (part.type === 'reasoning') {
      const providerOptions = envelopeToProviderOptions(part.provider);
      append('assistant', {
        type: 'reasoning',
        text: part.text,
        ...(providerOptions && { providerOptions }),
      });
      rendered.add('reasoning');
    } else if (part.type === 'file') {
      const projectedFile = await resolveHistoryFilePart(part, message, options);
      if (projectedFile !== undefined) {
        append('assistant', projectedFile);
        rendered.add('file');
      }
    } else if (part.type === 'tool-call') {
      callInputsById.set(part.callId, part.input);
      const providerOptions = envelopeToProviderOptions(part.provider);
      append('assistant', {
        type: 'tool-call',
        toolCallId: part.callId,
        toolName: part.toolName,
        input: part.input,
        ...(providerOptions && { providerOptions }),
      });
      rendered.add('tool-call');
    } else if (part.type === 'tool-result') {
      const output = await projectToolResultOutput(
        part,
        callInputsById.get(part.callId),
        options,
      );
      append('tool', {
        type: 'tool-result',
        toolCallId: part.callId,
        toolName: part.toolName,
        output,
      });
      rendered.add('tool-result');
    } else if (part.type === 'tool-approval-request') {
      append('assistant', {
        type: 'tool-approval-request',
        approvalId: part.approvalId,
        toolCallId: part.callId,
        ...(part.isAutomatic !== undefined && { isAutomatic: part.isAutomatic }),
        ...(part.signature && { signature: part.signature }),
      });
      rendered.add('tool-approval-request');
    } else if (part.type === 'tool-approval-response') {
      append('tool', {
        type: 'tool-approval-response',
        approvalId: part.approvalId,
        approved: part.approved,
        ...(part.reason && { reason: part.reason }),
      });
      rendered.add('tool-approval-response');
    }
  }
  // An opted-in failure is evidence even when the provider produced no content.
  // Its marker must survive projection before a summarizer replaces the raw turn.
  if (marker === 'failed' || (marker && (messages.length > 0 || content.length > 0))) {
    append('assistant', {
      type: 'text',
      text: marker === 'interrupted' ? INTERRUPTION_NOTE : FAILURE_NOTE,
    });
    // The note stands for the marker, so a `control` part is now represented
    // rather than silently dropped.
    rendered.add('control');
  }
  flush();
  return { messages, rendered };
}
