import { z } from 'zod';
import type { AgentMessagePart, AgentProviderEnvelope } from '../../agent-parts/parts';
import { bytesToBase64, resolveImageBytes, validateImageOptions } from '../image-input';
import { JsonRpcError } from '../json-rpc-peer';
import { nonEmptyString } from '../session-primitives';
import {
  type ExecutorDelta,
  type ExecutorErrorKind,
  type ExecutorPlanEntry,
  ExecutorPlanEntryPrioritySchema,
  ExecutorPlanEntryStatusSchema,
  type ExecutorTokenUsage,
} from '../vocabulary';
import type {
  AcpPlanEntry,
  AcpPromptUsage,
  AcpSessionUpdate,
  AcpToolLocation,
} from './v1-protocol';

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
  'compaction_update',
  'compaction_summary_chunk',
]);

function text(update: AcpSessionUpdate): string | undefined {
  const content = update.content;
  return content !== undefined && !Array.isArray(content) && content.type === 'text'
    ? content.text
    : undefined;
}

interface AcpTrackedToolState {
  toolName: string;
  input: z.infer<ReturnType<typeof z.json>>;
  title?: string;
  kind?: string;
  locations?: readonly AcpToolLocation[];
}

/** Per-turn state used to keep text segments distinct across tool calls and remember tool names and metadata. */
export interface AcpUpdateTrack {
  segment: number;
  lastKind?: string;
  toolNames: Map<string, string>;
  toolStates?: Map<string, AcpTrackedToolState>;
}

function normalizeLocations(
  locations: readonly AcpToolLocation[] | undefined,
): Array<{ path: string; line?: number; column?: number }> | undefined {
  if (!locations || locations.length === 0) return undefined;
  return locations.map((loc) => ({
    path: loc.path,
    ...(typeof loc.line === 'number' && { line: loc.line }),
    ...(typeof loc.column === 'number' && { column: loc.column }),
  }));
}

function buildToolProviderEnvelope(meta: {
  title?: string;
  kind?: string;
  locations?: readonly AcpToolLocation[];
  status?: string;
}): AgentProviderEnvelope | undefined {
  const locations = normalizeLocations(meta.locations);
  if (
    meta.title === undefined &&
    meta.kind === undefined &&
    locations === undefined &&
    meta.status === undefined
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    provider: 'acp',
    data: {
      ...(meta.title !== undefined && { title: meta.title }),
      ...(meta.kind !== undefined && { kind: meta.kind }),
      ...(locations !== undefined && { locations }),
      ...(meta.status !== undefined && { status: meta.status }),
    },
  };
}

function normalizePlanEntries(entries: readonly AcpPlanEntry[]): ExecutorPlanEntry[] {
  return entries.map((entry) => {
    const status = ExecutorPlanEntryStatusSchema.safeParse(entry.status);
    const priority = ExecutorPlanEntryPrioritySchema.safeParse(entry.priority);
    return {
      content: entry.content,
      ...(status.success && { status: status.data }),
      ...(priority.success && { priority: priority.data }),
    };
  });
}

function ensureToolStates(
  track: AcpUpdateTrack | undefined,
): Map<string, AcpTrackedToolState> | undefined {
  if (track === undefined) return undefined;
  track.toolStates ??= new Map();
  return track.toolStates;
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
      const title = nonEmptyString(update.title);
      const toolKind = nonEmptyString(update.kind);
      const toolName = nonEmptyString(update.name) ?? title ?? toolKind ?? 'tool';
      const input = update.rawInput ?? update.args ?? {};
      const locations =
        update.locations && update.locations.length > 0 ? update.locations : undefined;
      const provider = buildToolProviderEnvelope({
        ...(title !== undefined && { title }),
        ...(toolKind !== undefined && { kind: toolKind }),
        ...(locations !== undefined && { locations }),
      });
      if (track !== undefined) {
        track.lastKind = 'tool';
        track.toolNames.set(callId, toolName);
        ensureToolStates(track)?.set(callId, {
          toolName,
          input,
          ...(title !== undefined && { title }),
          ...(toolKind !== undefined && { kind: toolKind }),
          ...(locations !== undefined && { locations }),
        });
      }
      return [
        {
          type: 'tool-call',
          ...base,
          itemId: `call:${callId}`,
          raw: raw(kind),
          callId,
          toolName,
          input,
          ...(provider !== undefined && { provider }),
        },
      ];
    }
    case 'tool_call_update': {
      const callId = nonEmptyString(update.toolCallId) ?? `call-${chunk}`;
      const previous = track?.toolStates?.get(callId);
      const title = nonEmptyString(update.title) ?? previous?.title;
      const toolKind = nonEmptyString(update.kind) ?? previous?.kind;
      const locations =
        update.locations && update.locations.length > 0
          ? update.locations
          : previous?.locations;
      const toolName =
        nonEmptyString(update.name) ??
        nonEmptyString(track?.toolNames.get(callId)) ??
        title ??
        toolKind ??
        'tool';

      if (update.status !== 'completed' && update.status !== 'failed') {
        const hasInput = update.rawInput !== undefined || update.args !== undefined;
        const hasNewMetadata =
          nonEmptyString(update.title) !== undefined ||
          nonEmptyString(update.kind) !== undefined ||
          (update.locations !== undefined && update.locations.length > 0);
        if (!hasInput && !hasNewMetadata) return [];
        const input = update.rawInput ?? update.args ?? previous?.input ?? {};
        const status = nonEmptyString(update.status);
        const provider = buildToolProviderEnvelope({
          ...(title !== undefined && { title }),
          ...(toolKind !== undefined && { kind: toolKind }),
          ...(locations !== undefined && { locations }),
          ...(status !== undefined && { status }),
        });
        if (track !== undefined) {
          track.lastKind = 'tool';
          track.toolNames.set(callId, toolName);
          ensureToolStates(track)?.set(callId, {
            toolName,
            input,
            ...(title !== undefined && { title }),
            ...(toolKind !== undefined && { kind: toolKind }),
            ...(locations !== undefined && { locations }),
          });
        }
        return [
          {
            type: 'tool-call',
            ...base,
            itemId: `call:${callId}`,
            raw: raw(kind),
            callId,
            toolName,
            input,
            ...(provider !== undefined && { provider }),
          },
        ];
      }

      const output = update.rawOutput ?? update.content;
      const hasUpdateMetadata =
        nonEmptyString(update.title) !== undefined ||
        nonEmptyString(update.kind) !== undefined ||
        (update.locations !== undefined && update.locations.length > 0);
      const provider = hasUpdateMetadata
        ? buildToolProviderEnvelope({
            ...(title !== undefined && { title }),
            ...(toolKind !== undefined && { kind: toolKind }),
            ...(locations !== undefined && { locations }),
          })
        : undefined;
      if (track !== undefined) {
        track.lastKind = 'tool';
        track.toolStates?.delete(callId);
      }
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
          ...(provider !== undefined && { provider }),
        },
      ];
    }
    case 'plan':
    case 'plan_update':
    case 'plan_removed': {
      const planId = nonEmptyString(update.planId) ?? nonEmptyString(update.plan?.id);
      const rawEntries = update.entries ?? update.plan?.entries;
      const action = kind === 'plan' ? 'set' : kind === 'plan_update' ? 'update' : 'remove';
      return [
        {
          type: 'plan',
          ...base,
          itemId: planId !== undefined ? `plan:${planId}` : 'plan',
          raw: raw(kind),
          action,
          ...(planId !== undefined && { planId }),
          ...(action !== 'remove' &&
            (rawEntries !== undefined || action === 'set') && {
              entries: normalizePlanEntries(rawEntries ?? []),
            }),
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

/**
 * Normalize one ACP prompt `usage` object into executor token counters, preserving
 * `cachedWriteTokens`, `thoughtTokens`, and `totalTokens`. When `usageInputIncludesCachedRead`
 * is `false`, adds `cachedReadTokens` onto `inputTokens` so total input reflects both uncached
 * and cache-read tokens.
 */
export function normalizeAcpUsage(
  usage: AcpPromptUsage,
  options: { readonly usageInputIncludesCachedRead?: boolean } = {},
): ExecutorTokenUsage {
  const cachedRead = usage.cachedReadTokens ?? undefined;
  const inputTokens =
    usage.inputTokens != null
      ? options.usageInputIncludesCachedRead === false && cachedRead !== undefined
        ? usage.inputTokens + cachedRead
        : usage.inputTokens
      : undefined;
  return {
    ...(inputTokens !== undefined && { inputTokens }),
    ...(usage.outputTokens != null && { outputTokens: usage.outputTokens }),
    ...(cachedRead !== undefined && { cachedInputTokens: cachedRead }),
    ...(usage.cachedWriteTokens != null && {
      cacheCreationInputTokens: usage.cachedWriteTokens,
    }),
    ...(usage.thoughtTokens != null && { thinkingTokens: usage.thoughtTokens }),
    ...(usage.totalTokens != null && { totalTokens: usage.totalTokens }),
  };
}

function sumOptionalCount(
  left: number | undefined,
  right: number | undefined,
): number | undefined {
  if (left === undefined && right === undefined) return undefined;
  return (left ?? 0) + (right ?? 0);
}

/** Accumulate normalized token counters across multiple prompt generations of one steered turn. */
export function addAcpTokenUsage(
  total: ExecutorTokenUsage | undefined,
  next: ExecutorTokenUsage,
): ExecutorTokenUsage {
  if (total === undefined) return next;
  const inputTokens = sumOptionalCount(total.inputTokens, next.inputTokens);
  const outputTokens = sumOptionalCount(total.outputTokens, next.outputTokens);
  const cachedInputTokens = sumOptionalCount(total.cachedInputTokens, next.cachedInputTokens);
  const cacheCreationInputTokens = sumOptionalCount(
    total.cacheCreationInputTokens,
    next.cacheCreationInputTokens,
  );
  const thinkingTokens = sumOptionalCount(total.thinkingTokens, next.thinkingTokens);
  const totalTokens = sumOptionalCount(total.totalTokens, next.totalTokens);
  return {
    ...(inputTokens !== undefined && { inputTokens }),
    ...(outputTokens !== undefined && { outputTokens }),
    ...(cachedInputTokens !== undefined && { cachedInputTokens }),
    ...(cacheCreationInputTokens !== undefined && { cacheCreationInputTokens }),
    ...(thinkingTokens !== undefined && { thinkingTokens }),
    ...(totalTokens !== undefined && { totalTokens }),
  };
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
