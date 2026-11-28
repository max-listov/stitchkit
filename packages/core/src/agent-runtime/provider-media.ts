import {
  type AgentCacheControl,
  AgentCacheControlSchema,
  type AgentModelFileData,
  type AgentModelJsonValue,
  type AgentModelProviderOptions,
} from '../agent-parts/model';
import type { AgentProviderEnvelope } from '../agent-parts/parts';
import { bytesToBase64 } from '../internal/base64';
import { isRecord } from '../internal/typed';

/**
 * Copy-on-write sanitization of unpaired UTF-16 surrogates so JSON wire payloads
 * never trigger upstream HTTP 400 / invalid UTF-8 rejections.
 */
export function sanitizeSurrogates(text: string): string {
  if (typeof text.isWellFormed === 'function' && typeof text.toWellFormed === 'function') {
    return text.isWellFormed() ? text : text.toWellFormed();
  }
  return text.replace(
    /([\ud800-\udbff])(?![\udc00-\udfff])|(?<![\ud800-\udbff])([\udc00-\udfff])/gu,
    '\ufffd',
  );
}

function sortJsonKeys(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeSurrogates(value);
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (!isRecord(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const entry = value[key];
    if (entry !== undefined) sorted[key] = sortJsonKeys(entry);
  }
  return sorted;
}

/** Serialize JSON with deterministic sorted object keys to preserve prompt-cache prefix hits. */
export function deterministicJson(value: unknown): string {
  return JSON.stringify(sortJsonKeys(value));
}

export type ResolvedFilePayload =
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'base64'; readonly base64: string; readonly mediaType: string }
  | { readonly kind: 'reference'; readonly reference: Readonly<Record<string, string>> }
  | { readonly kind: 'text'; readonly text: string };

/** Convert a tagged `AgentModelFileData` into a normalized transport representation. */
export function resolveFilePayload(
  data: AgentModelFileData,
  mediaType: string,
): ResolvedFilePayload {
  switch (data.type) {
    case 'url':
      return { kind: 'url', url: data.originalUrl ?? data.url.toString() };
    case 'reference':
      return { kind: 'reference', reference: data.reference };
    case 'text':
      return { kind: 'text', text: sanitizeSurrogates(data.text) };
    case 'data': {
      if (data.data instanceof Uint8Array) {
        return { kind: 'base64', base64: bytesToBase64(data.data), mediaType };
      }
      if (data.data instanceof ArrayBuffer) {
        return { kind: 'base64', base64: bytesToBase64(new Uint8Array(data.data)), mediaType };
      }
      const trimmed = data.data.trim();
      const dataUrlMatch = /^data:([^;,]+);base64,([\s\S]+)$/u.exec(trimmed);
      if (dataUrlMatch?.[1] && dataUrlMatch[2]) {
        return { kind: 'base64', base64: dataUrlMatch[2], mediaType: dataUrlMatch[1] };
      }
      return { kind: 'base64', base64: trimmed, mediaType };
    }
  }
}

/** Normalize a MIME type by stripping parameters, lowercasing, and mapping `image/jpg` to `image/jpeg`. */
export function normalizeMime(mediaType: string): string {
  const base = mediaType.split(';')[0]?.trim().toLowerCase() ?? '';
  return base === 'image/jpg' ? 'image/jpeg' : base;
}

/** Synthesize a deterministic fallback filename from a MIME type when one was not provided. */
export function fallbackFilenameForMediaType(mediaType: string): string {
  const subtype =
    mediaType
      .split('/')[1]
      ?.split(';')[0]
      ?.replace(/[^a-zA-Z0-9]/gu, '') ?? '';
  return subtype.length > 0 ? `file.${subtype}` : 'file.bin';
}

/**
 * Bijective per-request tool-call ID sanitizer for providers with strict character
 * or length constraints (Anthropic `^[a-zA-Z0-9_-]{1,64}$`, OpenAI Chat ≤ 40).
 */
export function createToolCallIdMapper(options: {
  readonly pattern: RegExp;
  readonly maxLength: number;
  readonly prefix?: string;
}): (rawId: string) => string {
  const forward = new Map<string, string>();
  const used = new Set<string>();
  const prefix = options.prefix ?? 'tc_';

  const fnv1aHex = (input: string): string => {
    let h1 = 0x811c9dc5;
    let h2 = 0x9e3779b9;
    for (let i = 0; i < input.length; i += 1) {
      const code = input.charCodeAt(i);
      h1 = Math.imul(h1 ^ code, 0x01000193);
      h2 = Math.imul(h2 ^ (code + i), 0x85ebca6b);
    }
    return `${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`;
  };

  return (rawId: string): string => {
    const existing = forward.get(rawId);
    if (existing !== undefined) return existing;
    if (
      rawId.length > 0 &&
      rawId.length <= options.maxLength &&
      options.pattern.test(rawId) &&
      !used.has(rawId)
    ) {
      forward.set(rawId, rawId);
      used.add(rawId);
      return rawId;
    }
    const base = `${prefix}${fnv1aHex(rawId)}`.slice(0, options.maxLength);
    let candidate = base;
    let suffix = 1;
    while (used.has(candidate)) {
      const tag = `_${suffix}`;
      candidate = `${base.slice(0, options.maxLength - tag.length)}${tag}`;
      suffix += 1;
    }
    forward.set(rawId, candidate);
    used.add(candidate);
    return candidate;
  };
}

/**
 * Read a portable `AgentCacheControl` marker from either the first-class `cacheControl`
 * field or legacy `providerOptions.{providerKey,anthropic}.{cacheControl,cache_control}`.
 */
export function readPortableCacheControl(
  direct: AgentCacheControl | undefined,
  providerOptions: AgentModelProviderOptions | undefined,
  providerKey: string,
): AgentCacheControl | undefined {
  if (direct !== undefined) return direct;
  if (!providerOptions) return undefined;
  for (const ns of [providerKey, 'anthropic']) {
    const entry = providerOptions[ns];
    if (!isRecord(entry)) continue;
    const raw = entry.cacheControl ?? entry.cache_control;
    if (raw === undefined) continue;
    const parsed = AgentCacheControlSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

function toJsonValue(value: unknown): AgentModelJsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (isRecord(value)) {
    const out: Record<string, AgentModelJsonValue> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) out[k] = toJsonValue(v);
    }
    return out;
  }
  return String(value);
}

/**
 * Canonical single owner for converting an opaque `AgentProviderEnvelope` back
 * into a nested provider-keyed `AgentModelProviderOptions` record (zero casts).
 */
export function envelopeToProviderOptions(
  envelope: AgentProviderEnvelope | undefined,
): AgentModelProviderOptions | undefined {
  if (!envelope) return undefined;
  if (envelope.provider !== 'ai-sdk') {
    return { [envelope.provider]: envelope.data };
  }
  const nested: Record<string, Record<string, AgentModelJsonValue>> = {};
  for (const [providerKey, entry] of Object.entries(envelope.data)) {
    if (!isRecord(entry)) continue;
    const inner: Record<string, AgentModelJsonValue> = {};
    for (const [k, v] of Object.entries(entry)) {
      if (v !== undefined) inner[k] = toJsonValue(v);
    }
    nested[providerKey] = inner;
  }
  return Object.keys(nested).length > 0 ? nested : undefined;
}
