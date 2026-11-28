import type {
  AgentModelAssistantContentPart,
  AgentModelJsonValue,
  AgentModelMessage,
  AgentModelToolContentPart,
  AgentToolModelOutput,
} from '../agent-parts/model';
import { isRecord } from '../internal/typed';
import { sanitizeSurrogates } from './provider-media';

const EMPTY_TOOL_OUTPUT_FALLBACK = '(no tool output)';
const ORPHAN_TOOL_RESULT_ERROR =
  'Tool result missing (call was interrupted before completion)';

function sanitizeJsonValue(value: AgentModelJsonValue): AgentModelJsonValue {
  if (typeof value === 'string') return sanitizeSurrogates(value);
  if (Array.isArray(value)) return value.map(sanitizeJsonValue);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, AgentModelJsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) {
        out[sanitizeSurrogates(key)] = sanitizeJsonValue(entry);
      }
    }
    return out;
  }
  return value;
}

function sanitizeUnknown(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeSurrogates(value);
  if (Array.isArray(value)) return value.map(sanitizeUnknown);
  if (isRecord(value)) return sanitizeRecord(value);
  return value;
}

function sanitizeRecord(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    out[sanitizeSurrogates(key)] = sanitizeUnknown(entry);
  }
  return out;
}

function normalizeToolOutput(output: AgentToolModelOutput): AgentToolModelOutput {
  switch (output.type) {
    case 'text': {
      const clean = sanitizeSurrogates(output.value);
      return { ...output, value: clean.length > 0 ? clean : EMPTY_TOOL_OUTPUT_FALLBACK };
    }
    case 'error-text': {
      const clean = sanitizeSurrogates(output.value);
      return { ...output, value: clean.length > 0 ? clean : 'Tool execution failed' };
    }
    case 'execution-denied':
      return {
        ...output,
        ...(output.reason !== undefined && { reason: sanitizeSurrogates(output.reason) }),
      };
    case 'content': {
      if (output.value.length === 0) {
        return {
          type: 'text',
          value: EMPTY_TOOL_OUTPUT_FALLBACK,
          ...(output.providerOptions && { providerOptions: output.providerOptions }),
          ...(output.cacheControl && { cacheControl: output.cacheControl }),
        };
      }
      return {
        ...output,
        value: output.value.map((part) => {
          if (part.type === 'text') return { ...part, text: sanitizeSurrogates(part.text) };
          if (part.type === 'file' && part.filename !== undefined) {
            return { ...part, filename: sanitizeSurrogates(part.filename) };
          }
          return part;
        }),
      };
    }
    case 'json':
    case 'error-json':
      return { ...output, value: sanitizeJsonValue(output.value) };
  }
}

function safeToolCallInput(input: unknown): Record<string, unknown> {
  if (isRecord(input)) return sanitizeRecord(input);
  if (typeof input === 'string') {
    try {
      const parsed: unknown = JSON.parse(input);
      if (isRecord(parsed)) return sanitizeRecord(parsed);
    } catch {
      /* Invalid raw JSON arguments replay as `{}` so providers do not reject the turn with 400. */
    }
  }
  return {};
}

/**
 * Protocol-agnostic history hygiene run before wire serialization on every native driver:
 * 1. Sanitizes lone UTF-16 surrogates across text/reasoning/tool outputs.
 * 2. Ensures every client `tool-call` has a valid JSON object input on replay (`{}` if invalid).
 * 3. Replaces empty tool outputs with `"(no tool output)"`.
 * 4. Inserts synthetic error `tool-result` entries for orphan client `tool-call`s whose results
 *    never arrived (e.g. interrupted turn followed by a new user message).
 */
export function normalizeProviderHistory(
  messages: readonly AgentModelMessage[],
): AgentModelMessage[] {
  const result: AgentModelMessage[] = [];
  let pendingClientCalls: Array<{ toolCallId: string; toolName: string }> = [];

  const flushOrphans = (): void => {
    if (pendingClientCalls.length === 0) return;
    const synthetic: AgentModelToolContentPart[] = pendingClientCalls.map((call) => ({
      type: 'tool-result',
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      output: { type: 'error-text', value: ORPHAN_TOOL_RESULT_ERROR },
    }));
    result.push({ role: 'tool', content: synthetic });
    pendingClientCalls = [];
  };

  for (const message of messages) {
    if (message.role === 'tool') {
      const settledIds = new Set<string>();
      const cleanedContent: AgentModelToolContentPart[] = [];
      for (const part of message.content) {
        if (part.type === 'tool-result') {
          settledIds.add(part.toolCallId);
          cleanedContent.push({ ...part, output: normalizeToolOutput(part.output) });
        } else if (part.providerExecuted === true) {
          cleanedContent.push(part);
        }
      }
      pendingClientCalls = pendingClientCalls.filter(
        (call) => !settledIds.has(call.toolCallId),
      );
      if (cleanedContent.length > 0) {
        result.push({ ...message, content: cleanedContent });
      }
      continue;
    }

    flushOrphans();

    if (message.role === 'system') {
      const clean = sanitizeSurrogates(message.content);
      if (clean.length > 0) result.push({ ...message, content: clean });
      continue;
    }

    if (message.role === 'user') {
      if (typeof message.content === 'string') {
        result.push({ ...message, content: sanitizeSurrogates(message.content) });
      } else {
        result.push({
          ...message,
          content: message.content.map((part) => {
            if (part.type === 'text') return { ...part, text: sanitizeSurrogates(part.text) };
            if (part.type === 'file' && part.filename !== undefined) {
              return { ...part, filename: sanitizeSurrogates(part.filename) };
            }
            return part;
          }),
        });
      }
      continue;
    }

    if (typeof message.content === 'string') {
      result.push({ ...message, content: sanitizeSurrogates(message.content) });
      continue;
    }

    const parts: AgentModelAssistantContentPart[] = [];
    for (const part of message.content) {
      if (part.type === 'tool-approval-request') continue;
      if (part.type === 'text') {
        parts.push({ ...part, text: sanitizeSurrogates(part.text) });
        continue;
      }
      if (part.type === 'reasoning') {
        parts.push({ ...part, text: sanitizeSurrogates(part.text) });
        continue;
      }
      if (part.type === 'tool-call') {
        if (part.providerExecuted !== true) {
          pendingClientCalls.push({ toolCallId: part.toolCallId, toolName: part.toolName });
        }
        parts.push({ ...part, input: safeToolCallInput(part.input) });
        continue;
      }
      if (part.type === 'tool-result') {
        parts.push({ ...part, output: normalizeToolOutput(part.output) });
        continue;
      }
      parts.push(part);
    }
    if (parts.length > 0) {
      result.push({ ...message, content: parts });
    }
  }

  flushOrphans();
  return result;
}

/** Whether a normalized history contains any client tool calls or tool results. */
export function historyHasToolTraffic(messages: readonly AgentModelMessage[]): boolean {
  for (const message of messages) {
    if (message.role === 'tool') return true;
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      if (
        message.content.some(
          (part) => part.type === 'tool-call' && part.providerExecuted !== true,
        )
      ) {
        return true;
      }
    }
  }
  return false;
}
