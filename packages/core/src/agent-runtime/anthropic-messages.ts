import type {
  AgentCacheControl,
  AgentModelAssistantMessage,
  AgentModelMessage,
  AgentModelSystemMessage,
  AgentModelToolMessage,
  AgentModelUserMessage,
} from '../agent-parts/model';
import { isRecord } from '../internal/typed';
import { encodeAnthropicFileBlock, encodeAnthropicToolOutput } from './anthropic-media';
import {
  type AnthropicRequestPolicy,
  buildAnthropicPolicyFields,
  mergeAnthropicStepPolicy,
  readAnthropicProviderOptions,
  validateAnthropicRequest,
} from './anthropic-options';
import type { AgentModelRequest } from './models-driver';
import type { PlannedCacheBreakpoint } from './provider-cache';
import { historyHasToolTraffic, normalizeProviderHistory } from './provider-history';
import {
  createToolCallIdMapper,
  readPortableCacheControl,
  sanitizeSurrogates,
} from './provider-media';

type WireBlock = Record<string, unknown>;

interface PlannedUserBlock {
  readonly block: WireBlock;
  readonly cacheControl?: AgentCacheControl;
}

interface PlannedAssistantBlock {
  readonly kind: 'thinking' | 'text' | 'tool_use';
  readonly block: WireBlock;
  readonly cacheControl?: AgentCacheControl;
}

type PendingTurn =
  | {
      readonly role: 'user';
      toolResults: WireBlock[];
      toolCacheControl?: AgentCacheControl;
      userBlocks: PlannedUserBlock[];
    }
  | {
      readonly role: 'assistant';
      blocks: PlannedAssistantBlock[];
    };

const TOOL_CALL_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const TOOL_CALL_ID_MAX_LENGTH = 64;

export interface BuildAnthropicRequestInput {
  readonly modelId: string;
  readonly request: AgentModelRequest;
  readonly policy: AnthropicRequestPolicy;
  readonly extraBody?: Readonly<Record<string, unknown>>;
}

export interface BuiltAnthropicRequest {
  readonly body: Record<string, unknown>;
  readonly autoBetas: readonly string[];
  readonly policyBetas?: readonly string[];
}

/**
 * Anthropic rejects images embedded inside a `tool_result` with `is_error: true`.
 * Move any such images into trailing blocks of the same `user` message after all
 * `tool_result` and normal user blocks, while keeping every `tool_result` block first.
 */
export function splitErrorToolResultImages(blocks: readonly WireBlock[]): WireBlock[] {
  const toolResults: WireBlock[] = [];
  const otherBlocks: WireBlock[] = [];
  const trailingImages: WireBlock[] = [];

  for (const block of blocks) {
    if (block.type !== 'tool_result') {
      otherBlocks.push(block);
      continue;
    }
    if (block.is_error === true && Array.isArray(block.content)) {
      const kept: unknown[] = [];
      let extracted = false;
      for (const item of block.content) {
        if (isRecord(item) && item.type === 'image') {
          trailingImages.push(item);
          extracted = true;
        } else {
          kept.push(item);
        }
      }
      if (extracted) {
        toolResults.push({
          ...block,
          content: kept.length > 0 ? kept : 'Tool execution failed (see attached image)',
        });
        continue;
      }
    }
    toolResults.push(block);
  }

  return [...toolResults, ...otherBlocks, ...trailingImages];
}

function encodeToolMessage(
  message: AgentModelToolMessage,
  mapToolCallId: (rawId: string) => string,
): { readonly blocks: WireBlock[]; readonly cacheControl?: AgentCacheControl } {
  const blocks: WireBlock[] = [];
  let cacheControl = readPortableCacheControl(
    message.cacheControl,
    message.providerOptions,
    'anthropic',
  );

  for (const part of message.content) {
    if (part.type !== 'tool-result') continue;
    const encoded = encodeAnthropicToolOutput(part.output, part);
    blocks.push({
      type: 'tool_result',
      tool_use_id: mapToolCallId(part.toolCallId),
      content: encoded.content,
      ...(encoded.isError && { is_error: true }),
    });
    const partCache =
      readPortableCacheControl(part.cacheControl, part.providerOptions, 'anthropic') ??
      readPortableCacheControl(
        part.output.cacheControl,
        part.output.providerOptions,
        'anthropic',
      );
    if (partCache !== undefined) cacheControl = partCache;
  }

  return { blocks, ...(cacheControl !== undefined && { cacheControl }) };
}

function encodeUserMessage(message: AgentModelUserMessage): PlannedUserBlock[] {
  const msgCache = readPortableCacheControl(
    message.cacheControl,
    message.providerOptions,
    'anthropic',
  );
  const blocks: PlannedUserBlock[] = [];

  if (typeof message.content === 'string') {
    if (message.content.length > 0) {
      blocks.push({
        block: { type: 'text', text: message.content },
        ...(msgCache !== undefined && { cacheControl: msgCache }),
      });
    }
    return blocks;
  }

  for (const part of message.content) {
    const partCache = readPortableCacheControl(
      part.cacheControl,
      part.providerOptions,
      'anthropic',
    );
    if (part.type === 'text' && part.text.length > 0) {
      blocks.push({
        block: { type: 'text', text: part.text },
        ...(partCache !== undefined && { cacheControl: partCache }),
      });
    } else if (part.type === 'file') {
      blocks.push({
        block: encodeAnthropicFileBlock(part.data, part.mediaType, part.filename),
        ...(partCache !== undefined && { cacheControl: partCache }),
      });
    }
  }

  const lastIndex = blocks.length - 1;
  const last = blocks[lastIndex];
  if (msgCache !== undefined && last && last.cacheControl === undefined) {
    blocks[lastIndex] = { block: last.block, cacheControl: msgCache };
  }
  return blocks;
}

function encodeAssistantMessage(
  message: AgentModelAssistantMessage,
  mapToolCallId: (rawId: string) => string,
): PlannedAssistantBlock[] {
  const msgCache = readPortableCacheControl(
    message.cacheControl,
    message.providerOptions,
    'anthropic',
  );
  const blocks: PlannedAssistantBlock[] = [];

  if (typeof message.content === 'string') {
    if (message.content.length > 0) {
      blocks.push({
        kind: 'text',
        block: { type: 'text', text: message.content },
        ...(msgCache !== undefined && { cacheControl: msgCache }),
      });
    }
    return blocks;
  }

  for (const part of message.content) {
    if (part.type === 'reasoning') {
      const opts = readAnthropicProviderOptions(part.providerOptions);
      if (
        opts?.type === 'redacted_thinking' &&
        typeof opts.data === 'string' &&
        opts.data.length > 0
      ) {
        blocks.push({
          kind: 'thinking',
          block: { type: 'redacted_thinking', data: opts.data },
        });
      } else if (typeof opts?.signature === 'string' && opts.signature.length > 0) {
        blocks.push({
          kind: 'thinking',
          block: { type: 'thinking', thinking: part.text, signature: opts.signature },
        });
      }
      continue;
    }

    if (part.type === 'text' && part.text.length > 0) {
      const partCache = readPortableCacheControl(
        part.cacheControl,
        part.providerOptions,
        'anthropic',
      );
      blocks.push({
        kind: 'text',
        block: { type: 'text', text: part.text },
        ...(partCache !== undefined && { cacheControl: partCache }),
      });
      continue;
    }

    if (part.type === 'tool-call' && part.providerExecuted !== true) {
      const partCache = readPortableCacheControl(
        part.cacheControl,
        part.providerOptions,
        'anthropic',
      );
      blocks.push({
        kind: 'tool_use',
        block: {
          type: 'tool_use',
          id: mapToolCallId(part.toolCallId),
          name: part.toolName,
          input: isRecord(part.input) ? part.input : {},
        },
        ...(partCache !== undefined && { cacheControl: partCache }),
      });
    }
  }

  if (msgCache !== undefined) {
    for (let i = blocks.length - 1; i >= 0; i -= 1) {
      const candidate = blocks[i];
      if (!candidate || candidate.kind === 'thinking') continue;
      if (candidate.cacheControl === undefined)
        blocks[i] = { ...candidate, cacheControl: msgCache };
      break;
    }
  }
  return blocks;
}

function encodeSystemBlocks(
  instructions: readonly AgentModelSystemMessage[],
  inlineSystems: readonly AgentModelSystemMessage[],
  plannedBreakpoints: PlannedCacheBreakpoint<WireBlock>[],
): WireBlock[] {
  const blocks: WireBlock[] = [];
  for (const entry of [...instructions, ...inlineSystems]) {
    const clean = sanitizeSurrogates(entry.content);
    if (clean.length === 0) continue;
    const block: WireBlock = { type: 'text', text: clean };
    blocks.push(block);
    const control = readPortableCacheControl(
      entry.cacheControl,
      entry.providerOptions,
      'anthropic',
    );
    if (control !== undefined)
      plannedBreakpoints.push({ slot: 'system', control, target: block });
  }
  return blocks;
}

function collectPendingTurns(
  messages: readonly AgentModelMessage[],
  mapToolCallId: (rawId: string) => string,
): { readonly inlineSystems: AgentModelSystemMessage[]; readonly turns: PendingTurn[] } {
  const inlineSystems: AgentModelSystemMessage[] = [];
  const turns: PendingTurn[] = [];

  for (const message of messages) {
    if (message.role === 'system') {
      inlineSystems.push(message);
      continue;
    }
    if (message.role === 'tool') {
      const encoded = encodeToolMessage(message, mapToolCallId);
      if (encoded.blocks.length === 0) continue;
      const last = turns.at(-1);
      if (last?.role === 'user') {
        last.toolResults.push(...encoded.blocks);
        if (encoded.cacheControl !== undefined) last.toolCacheControl = encoded.cacheControl;
      } else {
        turns.push({
          role: 'user',
          toolResults: [...encoded.blocks],
          ...(encoded.cacheControl !== undefined && {
            toolCacheControl: encoded.cacheControl,
          }),
          userBlocks: [],
        });
      }
      continue;
    }
    if (message.role === 'user') {
      const encoded = encodeUserMessage(message);
      if (encoded.length === 0) continue;
      const last = turns.at(-1);
      if (last?.role === 'user') last.userBlocks.push(...encoded);
      else turns.push({ role: 'user', toolResults: [], userBlocks: [...encoded] });
      continue;
    }
    const encoded = encodeAssistantMessage(message, mapToolCallId);
    if (encoded.length === 0) continue;
    const last = turns.at(-1);
    if (last?.role === 'assistant') last.blocks.push(...encoded);
    else turns.push({ role: 'assistant', blocks: [...encoded] });
  }

  return { inlineSystems, turns };
}

function serializeTurns(
  turns: readonly PendingTurn[],
  plannedBreakpoints: PlannedCacheBreakpoint<WireBlock>[],
): WireBlock[] {
  const wireMessages: WireBlock[] = [];
  for (const turn of turns) {
    if (turn.role === 'user') {
      const userCacheMap = new Map<WireBlock, AgentCacheControl>();
      for (const entry of turn.userBlocks) {
        if (entry.cacheControl !== undefined)
          userCacheMap.set(entry.block, entry.cacheControl);
      }
      const finalized = splitErrorToolResultImages([
        ...turn.toolResults,
        ...turn.userBlocks.map((entry) => entry.block),
      ]);
      if (finalized.length === 0) continue;
      let lastToolResult: WireBlock | undefined;
      for (const block of finalized) {
        if (block.type === 'tool_result') lastToolResult = block;
      }
      if (turn.toolCacheControl !== undefined && lastToolResult !== undefined) {
        plannedBreakpoints.push({
          slot: 'message',
          control: turn.toolCacheControl,
          target: lastToolResult,
        });
      }
      for (const block of finalized) {
        const control = userCacheMap.get(block);
        if (control !== undefined)
          plannedBreakpoints.push({ slot: 'message', control, target: block });
      }
      wireMessages.push({ role: 'user', content: finalized });
      continue;
    }

    // Preserve original block order so `interleaved-thinking-2025-05-14`
    // (`[thinking_1, tool_use_1, thinking_2, tool_use_2]`) retains valid signatures.
    const ordered = turn.blocks;
    if (ordered.length === 0) continue;
    for (const entry of ordered) {
      if (entry.kind !== 'thinking' && entry.cacheControl !== undefined) {
        plannedBreakpoints.push({
          slot: 'message',
          control: entry.cacheControl,
          target: entry.block,
        });
      }
    }
    wireMessages.push({ role: 'assistant', content: ordered.map((entry) => entry.block) });
  }
  return wireMessages;
}

/** Encode one `AgentModelRequest` into an Anthropic `/v1/messages` body and required beta flags. */
export function buildAnthropicRequest(
  input: BuildAnthropicRequestInput,
): BuiltAnthropicRequest {
  const { modelId, request, extraBody } = input;
  const policy = mergeAnthropicStepPolicy(
    input.policy,
    request.providerOptions,
    request.settings.maxOutputTokens,
  );
  const maxTokens = validateAnthropicRequest(request, policy);
  const normalized = normalizeProviderHistory(request.messages);
  const mapToolCallId = createToolCallIdMapper({
    pattern: TOOL_CALL_ID_PATTERN,
    maxLength: TOOL_CALL_ID_MAX_LENGTH,
  });

  const systemBreakpoints: PlannedCacheBreakpoint<WireBlock>[] = [];
  const messageBreakpoints: PlannedCacheBreakpoint<WireBlock>[] = [];

  const { inlineSystems, turns } = collectPendingTurns(normalized, mapToolCallId);
  const wireMessages = serializeTurns(turns, messageBreakpoints);
  const systemBlocks = encodeSystemBlocks(
    request.instructions,
    inlineSystems,
    systemBreakpoints,
  );

  const { fields, autoBetas } = buildAnthropicPolicyFields({
    request,
    policy,
    maxTokens,
    hasToolTraffic: historyHasToolTraffic(normalized),
    systemBreakpoints,
    messageBreakpoints,
  });

  const body: Record<string, unknown> = {
    ...(extraBody ?? {}),
    model: modelId,
    ...fields,
    messages: wireMessages,
    ...(systemBlocks.length > 0 && { system: systemBlocks }),
  };

  return {
    body,
    autoBetas,
    ...(policy.betas !== undefined && { policyBetas: policy.betas }),
  };
}
