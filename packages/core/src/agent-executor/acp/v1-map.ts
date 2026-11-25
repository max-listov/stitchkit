import { z } from 'zod';
import type { AgentMessagePart } from '../../agent-parts/parts';
import { bytesToBase64, resolveImageBytes, validateImageOptions } from '../image-input';
import { JsonRpcError } from '../json-rpc-peer';
import { nonEmptyString } from '../session-primitives';
import type { ExecutorDelta, ExecutorErrorKind } from '../vocabulary';
import type { AcpSessionUpdate } from './v1-protocol';

const ACP_AUTH_REQUIRED_CODE = -32000;
const ACP_RATE_LIMIT_RE =
  /(?<![A-Za-z0-9])(?:rate[-_ ]?limit(?:ed|ing|s)?|quota|too many requests|429)(?![A-Za-z0-9])/i;
const ACP_AUTH_RE =
  /(?<![A-Za-z0-9])(?:auth(?:enticat\w*|oriz\w*)?|login|log in|logged in|unauthori\w*|unauthenticat\w*|401)(?![A-Za-z0-9])/i;

/**
 * Classify a JSON-RPC refusal from an ACP agent into a structured executor
 * error kind (`rateLimited` or `authRequired`), or `undefined` when it is a
 * generic failure that should stay an untyped stream error.
 */
export function classifyAcpRpcRefusal(
  error: unknown,
): Extract<ExecutorErrorKind, 'rateLimited' | 'authRequired'> | undefined {
  if (!(error instanceof JsonRpcError)) return undefined;
  if (ACP_RATE_LIMIT_RE.test(error.message)) return 'rateLimited';
  if (error.code === ACP_AUTH_REQUIRED_CODE || ACP_AUTH_RE.test(error.message)) {
    return 'authRequired';
  }
  return undefined;
}

const raw = (type: string) => ({ source: 'acp', type });
/** Updates that carry nothing for the turn's content: the session's own state. */
const QUIET = new Set([
  'available_commands_update',
  'config_option_update',
  'session_info_update',
  'current_mode_update',
  'plan',
]);

function text(update: AcpSessionUpdate): string | undefined {
  const content = update.content;
  return content !== undefined && !Array.isArray(content) && content.type === 'text'
    ? content.text
    : undefined;
}

/** Per-turn state used to keep text segments distinct across tool calls and remember tool names. */
export interface AcpUpdateTrack {
  segment: number;
  lastKind?: string;
  toolNames: Map<string, string>;
}

function segmentItemId(
  track: AcpUpdateTrack | undefined,
  kind: 'message' | 'thought',
): string {
  if (track === undefined) return kind;
  if (track.lastKind !== kind) {
    track.segment += 1;
    track.lastKind = kind;
  }
  return track.segment <= 1 ? kind : `${kind}:${track.segment}`;
}

/**
 * One `session/update` as deltas for the turn. Each update kind the driver
 * knows has its mapping; `user_message_chunk` is the agent replaying the
 * user's own words while loading a session and is never content of a turn;
 * an unknown kind is `unhandled`.
 */
export function mapAcpUpdate(
  update: AcpSessionUpdate,
  turnId: string,
  chunk: number,
  track?: AcpUpdateTrack,
): ExecutorDelta[] {
  const base = { turnId };
  const kind = update.sessionUpdate;
  switch (kind) {
    case 'agent_message_chunk':
    case 'agent_thought_chunk': {
      const value = text(update);
      if (value === undefined) return [];
      const slot = kind === 'agent_message_chunk' ? 'message' : 'thought';
      const itemId = segmentItemId(track, slot);
      return [
        slot === 'message'
          ? { type: 'text', ...base, itemId, raw: raw(kind), text: value }
          : { type: 'reasoning', ...base, itemId, raw: raw(kind), text: value },
      ];
    }
    case 'tool_call': {
      const callId = nonEmptyString(update.toolCallId) ?? `call-${chunk}`;
      const toolName =
        nonEmptyString(update.name) ??
        nonEmptyString(update.title) ??
        nonEmptyString(update.kind) ??
        'tool';
      if (track !== undefined) {
        track.lastKind = 'tool';
        track.toolNames.set(callId, toolName);
      }
      return [
        {
          type: 'tool-call',
          ...base,
          itemId: `call:${callId}`,
          raw: raw(kind),
          callId,
          toolName,
          input: update.rawInput ?? update.args ?? {},
        },
      ];
    }
    case 'tool_call_update': {
      if (update.status !== 'completed' && update.status !== 'failed') return [];
      const callId = nonEmptyString(update.toolCallId) ?? `call-${chunk}`;
      const output = update.rawOutput ?? update.content;
      const toolName =
        nonEmptyString(update.name) ??
        nonEmptyString(update.title) ??
        nonEmptyString(track?.toolNames.get(callId)) ??
        nonEmptyString(update.kind) ??
        'tool';
      if (track !== undefined) track.lastKind = 'tool';
      return [
        {
          type: 'tool-result',
          ...base,
          itemId: `result:${callId}`,
          raw: raw(kind),
          callId,
          toolName,
          outcome: update.status === 'completed' ? 'success' : 'error',
          ...(output !== undefined && { output: z.json().parse(output) }),
        },
      ];
    }
    case 'usage_update':
      return update.used !== undefined && update.size !== undefined
        ? [
            {
              type: 'context-usage',
              ...base,
              itemId: 'context',
              raw: raw(kind),
              usedTokens: update.used,
              windowTokens: update.size,
            },
          ]
        : [];
    case 'user_message_chunk':
      return [];
    default:
      if (QUIET.has(kind)) return [];
      return [
        {
          type: 'error',
          ...base,
          itemId: `unhandled:${kind}:${chunk}`,
          raw: raw(kind),
          kind: 'unhandled',
          message: `ACP update ${kind} is not known to this driver`,
        },
      ];
  }
}

/** How a prompt's stop reason ends the turn; asked to stop, a turn ends interrupted whatever the agent says. */
export function acpOutcome(
  stopReason: string,
  interruptRequested: boolean,
): 'completed' | 'interrupted' | 'failed' {
  if (interruptRequested || stopReason === 'cancelled') return 'interrupted';
  return stopReason === 'end_turn' ? 'completed' : 'failed';
}

export interface AcpPromptLimits {
  /** The agent declared `promptCapabilities.image`. */
  images: boolean;
  resolveFile?: (reference: string) => Promise<Uint8Array>;
  maxImageBytes: number;
}

/**
 * A turn's input as ACP content blocks: text as text, an image `file` part
 * as an `image` block with its bytes. What the agent cannot take — an image
 * it did not declare, a file that is not an image, one over the limit — is
 * refused before anything is sent, never dropped from the prompt.
 */
export async function acpPromptBlocks(
  parts: readonly AgentMessagePart[],
  limits: AcpPromptLimits,
): Promise<{ type: string; [key: string]: string }[]> {
  validateImageOptions(limits);
  // Pre-validate every part synchronously before calling `resolveFile` on any image.
  for (const part of parts) {
    if (part.type === 'text') continue;
    if (part.type !== 'file')
      throw new TypeError(`The ACP driver sends text and images, received ${part.type}`);
    if (!part.mediaType.startsWith('image/')) {
      throw new TypeError(
        `The ACP driver sends images only, received a file of ${part.mediaType}`,
      );
    }
    if (!limits.images) throw new TypeError('The ACP agent did not declare image input');
    if (limits.resolveFile === undefined)
      throw new TypeError('An image needs resolveFile to read its bytes');
  }
  const blocks: { type: string; [key: string]: string }[] = [];
  for (const part of parts) {
    if (part.type === 'text') {
      blocks.push({ type: 'text', text: part.text });
      continue;
    }
    if (part.type !== 'file' || limits.resolveFile === undefined) continue;
    const bytes = await resolveImageBytes(part.reference, {
      resolveFile: limits.resolveFile,
      maxImageBytes: limits.maxImageBytes,
    });
    blocks.push({
      type: 'image',
      mimeType: part.mediaType,
      data: bytesToBase64(bytes),
    });
  }
  return blocks;
}
