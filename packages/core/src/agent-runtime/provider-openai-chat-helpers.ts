import type {
  AgentModelFileData,
  AgentModelJsonValue,
  AgentModelProviderOptions,
  AgentModelResponseFormat,
} from '../agent-parts/model';
import type { AgentProviderEnvelope } from '../agent-parts/parts';
import { isRecord } from '../internal/typed';
import type { AgentModelStreamPart } from './models-driver';
import { nonEmptyString } from './provider-http';
import { normalizeOpenAiJsonSchema } from './provider-json-schema';
import {
  deterministicJson,
  fallbackFilenameForMediaType,
  normalizeMime,
  resolveFilePayload,
  sanitizeSurrogates,
} from './provider-media';

const AUDIO_FORMAT_ALIASES: Readonly<Record<string, string>> = {
  'audio/wave': 'wav',
  'audio/x-wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
};

export function encodeChatFilePart(
  data: AgentModelFileData,
  mediaType: string,
  filename: string | undefined,
  providerKey: string,
): Record<string, unknown> {
  const payload = resolveFilePayload(data, mediaType);
  if (payload.kind === 'text') return { type: 'text', text: payload.text };
  if (payload.kind === 'reference') {
    const fileId = payload.reference[providerKey] ?? Object.values(payload.reference)[0];
    return typeof fileId === 'string' && fileId.length > 0
      ? { type: 'file', file: { file_id: fileId } }
      : { type: 'text', text: `[file:${mediaType}]` };
  }
  const mime = normalizeMime(payload.kind === 'base64' ? payload.mediaType : mediaType);
  const url = payload.kind === 'url' ? payload.url : `data:${mime};base64,${payload.base64}`;
  if (mime.startsWith('image/')) return { type: 'image_url', image_url: { url } };
  if (mime.startsWith('video/')) return { type: 'video_url', video_url: { url } };
  if (mime.startsWith('audio/')) {
    if (payload.kind === 'url') {
      throw new TypeError(
        'OpenAI Chat input_audio requires base64 audio bytes, not an HTTP(S) URL',
      );
    }
    const format = AUDIO_FORMAT_ALIASES[mime] ?? mime.slice('audio/'.length);
    return { type: 'input_audio', input_audio: { data: payload.base64, format } };
  }
  const name = filename ? sanitizeSurrogates(filename) : fallbackFilenameForMediaType(mime);
  return { type: 'file', file: { filename: name, file_data: url } };
}

export function collectChatReasoningDetails(
  optionsList: readonly (AgentModelProviderOptions | undefined)[],
  providerKey: string,
): Record<string, unknown>[] {
  const collected: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const options of optionsList) {
    const ns = options && isRecord(options[providerKey]) ? options[providerKey] : undefined;
    if (!Array.isArray(ns?.reasoning_details)) continue;
    for (const item of ns.reasoning_details) {
      if (!isRecord(item)) continue;
      // Only Anthropic and Gemini require signatures on reasoning.text; preserve DeepSeek/Qwen/xAI.
      if (item.type === 'reasoning.text') {
        const fmt = typeof item.format === 'string' ? item.format : undefined;
        if (
          (fmt === 'anthropic-claude-v1' || fmt === 'google-gemini-v1') &&
          (typeof item.signature !== 'string' || item.signature.length === 0)
        ) {
          continue;
        }
      }
      const key = deterministicJson(item);
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push({ ...item });
    }
  }
  return collected;
}

export function extractChatToolExtraContent(
  options: AgentModelProviderOptions | undefined,
  providerKey: string,
): Record<string, unknown> | undefined {
  if (!options) return undefined;
  const ns = isRecord(options[providerKey]) ? options[providerKey] : undefined;
  if (isRecord(ns?.extra_content)) return ns.extra_content;
  const orNs =
    providerKey !== 'openrouter' && isRecord(options.openrouter) ? options.openrouter : null;
  if (isRecord(orNs?.extra_content)) return orNs.extra_content;
  const google = isRecord(options.google) ? options.google : undefined;
  const sig = google?.thought_signature ?? google?.thoughtSignature;
  return typeof sig === 'string' && sig.length > 0
    ? { google: { thought_signature: sig } }
    : undefined;
}

export function encodeChatResponseFormat(
  format: AgentModelResponseFormat | undefined,
  normalize: boolean,
): Record<string, unknown> | undefined {
  if (!format || format.type === 'text') return undefined;
  if (format.type === 'json-object') return { type: 'json_object' };
  const strict = format.strict ?? true;
  const schema = normalize ? normalizeOpenAiJsonSchema(format.schema, strict) : format.schema;
  const jsonSchema: Record<string, unknown> = { name: format.name, schema, strict };
  if (format.description !== undefined) {
    jsonSchema.description = sanitizeSurrogates(format.description);
  }
  return { type: 'json_schema', json_schema: jsonSchema };
}

export function toChatJsonRecord(
  record: Record<string, unknown>,
): Record<string, AgentModelJsonValue> {
  const toVal = (v: unknown): AgentModelJsonValue => {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    return Array.isArray(v) ? v.map(toVal) : isRecord(v) ? toChatJsonRecord(v) : String(v);
  };
  const out: Record<string, AgentModelJsonValue> = {};
  for (const [k, v] of Object.entries(record)) if (v !== undefined) out[k] = toVal(v);
  return out;
}

export function mergeChatRecord(
  prev: Record<string, unknown> | undefined,
  next: Record<string, unknown>,
): Record<string, unknown> {
  if (!prev) return { ...next };
  const out: Record<string, unknown> = { ...prev };
  for (const [k, v] of Object.entries(next)) {
    const cur = out[k];
    if (isRecord(cur) && isRecord(v)) out[k] = mergeChatRecord(cur, v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

export function buildChatEnvelope(
  provider: string,
  details: readonly Record<string, unknown>[],
  extraContent?: Record<string, unknown>,
): AgentProviderEnvelope | undefined {
  const data: Record<string, AgentModelJsonValue> = {};
  if (details.length > 0) data.reasoning_details = details.map(toChatJsonRecord);
  if (extraContent !== undefined) data.extra_content = toChatJsonRecord(extraContent);
  return Object.keys(data).length > 0 ? { schemaVersion: 1, provider, data } : undefined;
}

const ABNORMAL_NATIVE_FINISH_REASONS = new Set([
  'MALFORMED_RESPONSE',
  'MALFORMED_FUNCTION_CALL',
  'OTHER',
  'INSUFFICIENT_SYSTEM_RESOURCE',
  'ERROR',
  'UNEXPECTED_TOOL_CALL',
  'RECITATION',
]);

/** Whether a gateway `native_finish_reason` indicates an abnormal empty completion. */
export function isAbnormalNativeFinishReason(native: string | undefined): native is string {
  return (
    native !== undefined && ABNORMAL_NATIVE_FINISH_REASONS.has(native.trim().toUpperCase())
  );
}

/** Whether `raw` is already a syntactically complete JSON object (`{ ... }`). */
export function isCompleteJsonObject(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return false;
  try {
    return isRecord(JSON.parse(trimmed));
  } catch {
    return false;
  }
}

/** Decide whether an incoming Chat Completions tool-call delta collides with an existing slot. */
export function isToolCallSlotCollision(input: {
  readonly prev: {
    readonly rawId?: string;
    readonly name: string;
    readonly arguments: string;
  };
  readonly rawId: string | undefined;
  readonly name: string | undefined;
  readonly arg: string;
}): boolean {
  const { prev, rawId, name, arg } = input;
  const startsNewJsonObject =
    arg.trimStart().startsWith('{') && isCompleteJsonObject(prev.arguments);
  const sameIdAndName =
    rawId !== undefined &&
    prev.rawId === rawId &&
    (name === undefined || prev.name.length === 0 || name === prev.name);
  if (sameIdAndName) return startsNewJsonObject;
  if (rawId !== undefined && prev.rawId !== undefined && prev.rawId !== rawId) return true;
  return (
    prev.name.length > 0 &&
    name !== undefined &&
    (name !== prev.name || rawId !== undefined || startsNewJsonObject)
  );
}

export function* decodeChatMediaAndSources(
  delta: Record<string, unknown>,
  onOutput: () => void,
): Generator<AgentModelStreamPart> {
  for (const img of Array.isArray(delta.images) ? delta.images : []) {
    const url =
      isRecord(img) && isRecord(img.image_url) ? nonEmptyString(img.image_url.url) : null;
    if (!url) continue;
    const m = /^data:([^;,]+);base64,([\s\S]+)$/u.exec(url);
    if (m?.[1] && m[2]) {
      onOutput();
      yield { type: 'file', mediaType: m[1], data: { type: 'data', data: m[2] } };
    } else if (/^https?:\/\//u.test(url) && URL.canParse(url)) {
      onOutput();
      const mt = nonEmptyString(isRecord(img) ? img.media_type : null) ?? 'image/png';
      yield { type: 'file', mediaType: mt, data: { type: 'url', url: new URL(url) } };
    }
  }
  for (const ann of Array.isArray(delta.annotations) ? delta.annotations : []) {
    if (!isRecord(ann) || ann.type !== 'url_citation' || !isRecord(ann.url_citation)) continue;
    const c = ann.url_citation;
    const url = nonEmptyString(c.url);
    if (!url || !URL.canParse(url)) continue;
    const title = typeof c.title === 'string' ? c.title : undefined;
    yield {
      type: 'source',
      source: { type: 'source', sourceId: crypto.randomUUID(), url, ...(title && { title }) },
    };
  }
}
