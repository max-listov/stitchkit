import type { AgentModelStreamPart } from './models-driver';
import {
  buildOpenAiPhaseEnvelope,
  buildOpenAiReasoningEnvelope,
  extractOpenAiReasoningSummary,
  type OpenAiReasoningSummaryEntry,
} from './openai-response';
import { nonEmptyString } from './provider-http';

export interface ActiveTextItem {
  readonly kind: 'message';
  readonly id: string;
  phase?: string;
  activeSegmentId?: string;
  segmentCount: number;
  readonly openSegments: Set<string>;
}

export interface ActiveReasoningItem {
  readonly kind: 'reasoning';
  readonly id: string;
  itemId?: string;
  summaryTexts: string[];
  finalSummary: OpenAiReasoningSummaryEntry[];
  encryptedContent?: string;
  opened: boolean;
  closed: boolean;
  pendingDone: boolean;
}

export interface ActiveFunctionCallItem {
  readonly kind: 'function_call';
  readonly itemId?: string;
  readonly callId: string;
  name: string;
  arguments: string;
  started: boolean;
}

export type ActiveItem = ActiveTextItem | ActiveReasoningItem | ActiveFunctionCallItem;

export interface OpenAiSseState {
  responseId?: string;
  responseModelId?: string;
  responseTimestamp?: Date;
  metadataEmitted: boolean;
  sawText: boolean;
  sawRefusal: boolean;
  hasToolCalls: boolean;
  sawTerminal: boolean;
  readonly itemsById: Map<string, ActiveItem>;
  readonly keyByOutputIndex: Map<number, string>;
}

export function intField(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key];
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined;
}

export function lookupItem(
  state: OpenAiSseState,
  itemId: string | undefined,
  outputIndex: number | undefined,
): ActiveItem | undefined {
  const byId = itemId !== undefined ? state.itemsById.get(itemId) : undefined;
  if (byId !== undefined) return byId;
  const key = outputIndex !== undefined ? state.keyByOutputIndex.get(outputIndex) : undefined;
  return key !== undefined ? state.itemsById.get(key) : undefined;
}

export function setItem(
  state: OpenAiSseState,
  key: string,
  outputIndex: number | undefined,
  item: ActiveItem,
): void {
  state.itemsById.set(key, item);
  if (outputIndex !== undefined) state.keyByOutputIndex.set(outputIndex, key);
}

export function ensureTextItem(
  state: OpenAiSseState,
  itemId: string | undefined,
  outputIndex: number | undefined,
): ActiveTextItem {
  const existing = lookupItem(state, itemId, outputIndex);
  if (existing?.kind === 'message') return existing;
  const id = itemId ?? `text-${outputIndex ?? state.itemsById.size}`;
  const created: ActiveTextItem = {
    kind: 'message',
    id,
    segmentCount: 0,
    openSegments: new Set(),
  };
  setItem(state, id, outputIndex, created);
  return created;
}

export function ensureReasoningItem(
  state: OpenAiSseState,
  itemId: string | undefined,
  outputIndex: number | undefined,
): ActiveReasoningItem {
  const existing = lookupItem(state, itemId, outputIndex);
  if (existing?.kind === 'reasoning') return existing;
  const id = itemId ?? `reasoning-${outputIndex ?? state.itemsById.size}`;
  const created: ActiveReasoningItem = {
    kind: 'reasoning',
    id,
    ...(itemId !== undefined && { itemId }),
    summaryTexts: [],
    finalSummary: [],
    opened: false,
    closed: false,
    pendingDone: false,
  };
  setItem(state, id, outputIndex, created);
  return created;
}

export function resolveSummary(
  entry: ActiveReasoningItem,
  raw: unknown,
): OpenAiReasoningSummaryEntry[] {
  const fromWire = extractOpenAiReasoningSummary(raw);
  if (fromWire.length > 0) return fromWire;
  const fromDeltas = entry.summaryTexts
    .filter((t) => t.length > 0)
    .map((text): OpenAiReasoningSummaryEntry => ({ type: 'summary_text', text }));
  return fromDeltas.length > 0 ? fromDeltas : entry.finalSummary;
}

export function* emitReasoningDelta(
  entry: ActiveReasoningItem,
  delta: string,
): Generator<AgentModelStreamPart> {
  if (!entry.opened) {
    entry.opened = true;
    yield { type: 'reasoning-start', id: entry.id };
  }
  if (delta.length > 0) yield { type: 'reasoning-delta', id: entry.id, delta };
}

export function* closeTextSegment(
  entry: ActiveTextItem,
  segmentId: string,
): Generator<AgentModelStreamPart> {
  if (!entry.openSegments.delete(segmentId)) return;
  if (entry.activeSegmentId === segmentId) entry.activeSegmentId = undefined;
  yield {
    type: 'text-end',
    id: segmentId,
    ...(entry.phase !== undefined && { provider: buildOpenAiPhaseEnvelope(entry.phase) }),
  };
}

export function* closeTextItem(entry: ActiveTextItem): Generator<AgentModelStreamPart> {
  for (const segmentId of [...entry.openSegments]) yield* closeTextSegment(entry, segmentId);
}

export function* closeReasoningItem(
  entry: ActiveReasoningItem,
  summary: OpenAiReasoningSummaryEntry[],
  encryptedContent: string | undefined,
): Generator<AgentModelStreamPart> {
  entry.finalSummary = summary;
  if (encryptedContent !== undefined) entry.encryptedContent = encryptedContent;
  if (!entry.opened) {
    entry.opened = true;
    yield { type: 'reasoning-start', id: entry.id };
  }
  entry.closed = true;
  entry.pendingDone = false;
  yield {
    type: 'reasoning-end',
    id: entry.id,
    provider: buildOpenAiReasoningEnvelope({
      ...(entry.itemId !== undefined && { id: entry.itemId }),
      summary,
      ...(encryptedContent !== undefined && { encryptedContent }),
    }),
  };
}

export function* emitMetadata(
  state: OpenAiSseState,
  response: Record<string, unknown> | undefined,
): Generator<AgentModelStreamPart> {
  const id = nonEmptyString(response?.id);
  const modelId = nonEmptyString(response?.model);
  const createdAt =
    typeof response?.created_at === 'number' &&
    Number.isFinite(response.created_at) &&
    response.created_at >= 0
      ? new Date(response.created_at * 1000)
      : undefined;
  if (id !== undefined) state.responseId = id;
  if (modelId !== undefined) state.responseModelId = modelId;
  if (createdAt !== undefined && state.responseTimestamp === undefined) {
    state.responseTimestamp = createdAt;
  }
  const hasMeta =
    state.responseId !== undefined ||
    state.responseModelId !== undefined ||
    state.responseTimestamp !== undefined;
  if (state.metadataEmitted || !hasMeta) return;
  state.metadataEmitted = true;
  yield {
    type: 'response-metadata',
    ...(state.responseId !== undefined && { id: state.responseId }),
    ...(state.responseModelId !== undefined && { modelId: state.responseModelId }),
    ...(state.responseTimestamp !== undefined && { timestamp: state.responseTimestamp }),
  };
}
