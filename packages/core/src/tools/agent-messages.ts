import {
  type AgentModelFileData,
  type AgentModelJsonValue,
  type AgentModelMessage,
  AgentModelMessageSchema,
  AgentModelProviderOptionsSchema,
  type AgentToolModelContentPart,
  type AgentToolModelOutput,
} from '../agent-parts/model';
import { isRecord } from '../internal/typed';

function toOwnedBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function safeJsonValueInternal(value: unknown, seen: WeakSet<object>): AgentModelJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof URL) return value.toString();
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    try {
      return value.map((item) => safeJsonValueInternal(item ?? null, seen));
    } finally {
      seen.delete(value);
    }
  }
  if (isRecord(value)) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    try {
      const out: Record<string, AgentModelJsonValue> = {};
      for (const [k, v] of Object.entries(value)) {
        if (v !== undefined) out[k] = safeJsonValueInternal(v, seen);
      }
      return out;
    } finally {
      seen.delete(value);
    }
  }
  return value === undefined ? null : String(value);
}

/** Normalize an arbitrary value into a finite JSON-safe value for AI SDK boundary adaptation. */
export function safeJsonValue(value: unknown): AgentModelJsonValue {
  return safeJsonValueInternal(value, new WeakSet<object>());
}

function providerOpt(raw: unknown) {
  const parsed = AgentModelProviderOptionsSchema.safeParse(raw);
  return parsed.success ? { providerOptions: parsed.data } : {};
}

function parseDataUrl(raw: string): { data: string; mediaType?: string } | undefined {
  if (!raw.startsWith('data:')) return undefined;
  const comma = raw.indexOf(',');
  if (comma < 0) return undefined;
  const mediaType = raw.slice(5, comma).split(';')[0]?.trim();
  return { data: raw.slice(comma + 1), ...(mediaType && { mediaType }) };
}

function normalizeProviderReference(raw: unknown): Record<string, string> | undefined {
  if (typeof raw === 'string' && raw.length > 0) return { default: raw };
  if (!isRecord(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k !== 'type' && typeof v === 'string') out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function tryUrl(raw: string): AgentModelFileData | undefined {
  try {
    return { type: 'url', url: new URL(raw), originalUrl: raw };
  } catch {
    return undefined;
  }
}

function adaptAiSdkFileData(raw: unknown): AgentModelFileData | undefined {
  if (raw instanceof Uint8Array) return { type: 'data', data: toOwnedBytes(raw) };
  if (raw instanceof ArrayBuffer) return { type: 'data', data: new Uint8Array(raw) };
  if (raw instanceof URL) return { type: 'url', url: raw };
  if (typeof raw === 'string') {
    const dataUrl = parseDataUrl(raw);
    if (dataUrl) return { type: 'data', data: dataUrl.data };
    if (/^https?:\/\//i.test(raw)) return tryUrl(raw) ?? { type: 'data', data: raw };
    return { type: 'data', data: raw };
  }
  if (!isRecord(raw)) return undefined;
  if (raw.type === 'data') {
    if (raw.data instanceof Uint8Array) return { type: 'data', data: toOwnedBytes(raw.data) };
    if (raw.data instanceof ArrayBuffer)
      return { type: 'data', data: new Uint8Array(raw.data) };
    return typeof raw.data === 'string' ? { type: 'data', data: raw.data } : undefined;
  }
  if (raw.type === 'url') {
    if (raw.url instanceof URL) {
      return {
        type: 'url',
        url: raw.url,
        ...(typeof raw.originalUrl === 'string' && { originalUrl: raw.originalUrl }),
      };
    }
    return typeof raw.url === 'string' ? tryUrl(raw.url) : undefined;
  }
  if (raw.type === 'reference') {
    const reference = normalizeProviderReference(raw.reference);
    return reference ? { type: 'reference', reference } : undefined;
  }
  if (raw.type === 'text' && typeof raw.text === 'string') {
    return { type: 'text', text: raw.text };
  }
  const reference = normalizeProviderReference(raw);
  return reference ? { type: 'reference', reference } : undefined;
}

function resolveMediaType(
  raw: Record<string, unknown>,
  dataSource: unknown,
  fallback: string,
): string {
  if (typeof raw.mediaType === 'string' && raw.mediaType.length > 0) return raw.mediaType;
  if (typeof raw.mimeType === 'string' && raw.mimeType.length > 0) return raw.mimeType;
  return (
    (typeof dataSource === 'string' ? parseDataUrl(dataSource)?.mediaType : undefined) ??
    fallback
  );
}

function adaptAiSdkToolContentPart(raw: unknown): AgentToolModelContentPart | undefined {
  if (!isRecord(raw) || typeof raw.type !== 'string') return undefined;
  const opt = providerOpt(raw.providerOptions);
  if (raw.type === 'text') {
    return typeof raw.text === 'string' ? { type: 'text', text: raw.text, ...opt } : undefined;
  }
  if (raw.type === 'custom') return { type: 'custom', ...opt };
  if (
    raw.type === 'file' ||
    raw.type === 'media' ||
    raw.type === 'image-data' ||
    raw.type === 'file-data' ||
    raw.type === 'image-url' ||
    raw.type === 'file-url'
  ) {
    const isUrl = raw.type === 'image-url' || raw.type === 'file-url';
    const source = isUrl ? raw.url : raw.data;
    const data = adaptAiSdkFileData(source);
    if (!data) return undefined;
    const fallback =
      raw.type === 'image-data'
        ? 'image/png'
        : raw.type === 'image-url'
          ? 'image/*'
          : 'application/octet-stream';
    return {
      type: 'file',
      data,
      mediaType: resolveMediaType(raw, source, fallback),
      ...(!isUrl && typeof raw.filename === 'string' && { filename: raw.filename }),
      ...opt,
    };
  }
  if (raw.type === 'image-file-id' || raw.type === 'file-id') {
    const reference = normalizeProviderReference(raw.fileId);
    if (!reference) return undefined;
    const fallback = raw.type === 'image-file-id' ? 'image/*' : 'application/octet-stream';
    return {
      type: 'file',
      data: { type: 'reference', reference },
      mediaType: resolveMediaType(raw, undefined, fallback),
      ...opt,
    };
  }
  return undefined;
}

function adaptAiSdkToolOutput(
  rawOutput: unknown,
  fallbackResult?: unknown,
): AgentToolModelOutput {
  const source = rawOutput !== undefined ? rawOutput : fallbackResult;
  if (isRecord(source) && typeof source.type === 'string') {
    const opt = providerOpt(source.providerOptions);
    if (
      (source.type === 'text' || source.type === 'error-text') &&
      typeof source.value === 'string'
    ) {
      return { type: source.type, value: source.value, ...opt };
    }
    if (source.type === 'json' || source.type === 'error-json') {
      return { type: source.type, value: safeJsonValue(source.value ?? null), ...opt };
    }
    if (source.type === 'execution-denied') {
      return {
        type: 'execution-denied',
        ...(typeof source.reason === 'string' && { reason: source.reason }),
        ...opt,
      };
    }
    if (source.type === 'content' && Array.isArray(source.value)) {
      const value = source.value
        .map(adaptAiSdkToolContentPart)
        .filter((part): part is AgentToolModelContentPart => part !== undefined);
      return { type: 'content', value, ...opt };
    }
  }
  return typeof source === 'string'
    ? { type: 'text', value: source }
    : { type: 'json', value: safeJsonValue(source ?? null) };
}

function adaptToolResultPart(
  raw: Record<string, unknown>,
  opt: Record<string, unknown>,
): unknown {
  if (typeof raw.toolCallId !== 'string' || typeof raw.toolName !== 'string') return undefined;
  return {
    type: 'tool-result',
    toolCallId: raw.toolCallId,
    toolName: raw.toolName,
    output: adaptAiSdkToolOutput(raw.output, raw.result),
    ...opt,
  };
}

function adaptAiSdkUserPart(raw: unknown): unknown {
  if (!isRecord(raw) || typeof raw.type !== 'string') return undefined;
  const opt = providerOpt(raw.providerOptions);
  if (raw.type === 'text' && typeof raw.text === 'string') {
    return { type: 'text', text: raw.text, ...opt };
  }
  if (raw.type !== 'image' && raw.type !== 'file') return undefined;
  const source = raw.type === 'image' ? raw.image : raw.data;
  const data = adaptAiSdkFileData(source);
  if (!data) return undefined;
  const fallback = raw.type === 'image' ? 'image/png' : 'application/octet-stream';
  return {
    type: 'file',
    data,
    mediaType: resolveMediaType(raw, source, fallback),
    ...(raw.type === 'file' && typeof raw.filename === 'string' && { filename: raw.filename }),
    ...opt,
  };
}

function adaptAiSdkAssistantPart(raw: unknown): unknown {
  if (!isRecord(raw) || typeof raw.type !== 'string') return undefined;
  const opt = providerOpt(raw.providerOptions);
  if ((raw.type === 'text' || raw.type === 'reasoning') && typeof raw.text === 'string') {
    return { type: raw.type, text: raw.text, ...opt };
  }
  if (raw.type === 'file' || raw.type === 'reasoning-file') {
    const data = adaptAiSdkFileData(raw.data);
    if (!data) return undefined;
    return {
      type: raw.type,
      data,
      mediaType: resolveMediaType(raw, raw.data, 'application/octet-stream'),
      ...(raw.type === 'file' &&
        typeof raw.filename === 'string' && { filename: raw.filename }),
      ...opt,
    };
  }
  if (
    raw.type === 'tool-call' &&
    typeof raw.toolCallId === 'string' &&
    typeof raw.toolName === 'string'
  ) {
    return {
      type: 'tool-call',
      toolCallId: raw.toolCallId,
      toolName: raw.toolName,
      input: raw.input ?? raw.args,
      ...(typeof raw.providerExecuted === 'boolean' && {
        providerExecuted: raw.providerExecuted,
      }),
      ...opt,
    };
  }
  if (raw.type === 'tool-result') return adaptToolResultPart(raw, opt);
  if (
    raw.type === 'tool-approval-request' &&
    typeof raw.approvalId === 'string' &&
    typeof raw.toolCallId === 'string'
  ) {
    return {
      type: 'tool-approval-request',
      approvalId: raw.approvalId,
      toolCallId: raw.toolCallId,
      ...(typeof raw.signature === 'string' && { signature: raw.signature }),
      ...(typeof raw.isAutomatic === 'boolean' && { isAutomatic: raw.isAutomatic }),
      ...(typeof raw.reason === 'string' && { reason: raw.reason }),
    };
  }
  return raw.type === 'custom' && typeof raw.kind === 'string'
    ? { type: 'custom', kind: raw.kind, ...opt }
    : undefined;
}

function adaptAiSdkToolPart(raw: unknown): unknown {
  if (!isRecord(raw) || typeof raw.type !== 'string') return undefined;
  const opt = providerOpt(raw.providerOptions);
  if (raw.type === 'tool-result') return adaptToolResultPart(raw, opt);
  if (
    raw.type === 'tool-approval-response' &&
    typeof raw.approvalId === 'string' &&
    typeof raw.approved === 'boolean'
  ) {
    return {
      type: 'tool-approval-response',
      approvalId: raw.approvalId,
      approved: raw.approved,
      ...(typeof raw.reason === 'string' && { reason: raw.reason }),
      ...(typeof raw.providerExecuted === 'boolean' && {
        providerExecuted: raw.providerExecuted,
      }),
    };
  }
  return undefined;
}

function adaptAiSdkMessage(item: unknown): AgentModelMessage | undefined {
  const direct = AgentModelMessageSchema.safeParse(item);
  if (direct.success) return direct.data;
  if (!isRecord(item) || typeof item.role !== 'string') return undefined;
  const opt = providerOpt(item.providerOptions);
  const adaptParts = (mapper: (part: unknown) => unknown) =>
    Array.isArray(item.content)
      ? item.content.map(mapper).filter((part) => part !== undefined)
      : [];
  let candidate: unknown;
  if (item.role === 'system' && typeof item.content === 'string') {
    candidate = { role: 'system', content: item.content, ...opt };
  } else if (item.role === 'user') {
    candidate = {
      role: 'user',
      content:
        typeof item.content === 'string' ? item.content : adaptParts(adaptAiSdkUserPart),
      ...opt,
    };
  } else if (item.role === 'assistant') {
    candidate = {
      role: 'assistant',
      content:
        typeof item.content === 'string' ? item.content : adaptParts(adaptAiSdkAssistantPart),
      ...opt,
    };
  } else if (item.role === 'tool' && Array.isArray(item.content)) {
    candidate = { role: 'tool', content: adaptParts(adaptAiSdkToolPart), ...opt };
  }
  if (candidate === undefined) return undefined;
  const parsed = AgentModelMessageSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

/** Convert AI SDK `ModelMessage[]` (including `image` and untagged `file.data`) into canonical `AgentModelMessage[]`. */
export function adaptAiSdkMessages(raw: readonly unknown[]): AgentModelMessage[] {
  const result: AgentModelMessage[] = [];
  for (const item of raw) {
    const adapted = adaptAiSdkMessage(item);
    if (adapted) result.push(adapted);
  }
  return result;
}
