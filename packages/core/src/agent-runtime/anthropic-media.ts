import type {
  AgentModelFileData,
  AgentModelProviderOptions,
  AgentModelToolContentPart,
  AgentToolModelOutput,
} from '../agent-parts/model';
import { base64ToBytes } from '../internal/base64';
import { readAnthropicProviderOptions } from './anthropic-options';
import {
  deterministicJson,
  normalizeMime,
  resolveFilePayload,
  sanitizeSurrogates,
} from './provider-media';

const SUPPORTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/** Encode one multimodal file part into an Anthropic `image` or `document` content block. */
export function encodeAnthropicFileBlock(
  data: AgentModelFileData,
  mediaType: string,
  filename?: string,
): Record<string, unknown> {
  const declared = normalizeMime(mediaType);
  if (declared.startsWith('audio/') || declared.startsWith('video/')) {
    throw new TypeError(`anthropicProvider does not support ${declared} media inputs`);
  }
  const resolved = resolveFilePayload(data, declared);
  const mime = resolved.kind === 'base64' ? normalizeMime(resolved.mediaType) : declared;
  if (mime.startsWith('audio/') || mime.startsWith('video/')) {
    throw new TypeError(`anthropicProvider does not support ${mime} media inputs`);
  }
  const sanitizedFilename = filename !== undefined ? sanitizeSurrogates(filename) : undefined;
  const title =
    sanitizedFilename !== undefined && sanitizedFilename.length > 0
      ? { title: sanitizedFilename }
      : {};

  if (resolved.kind === 'reference') {
    const fileId = resolved.reference.anthropic;
    if (typeof fileId !== 'string' || fileId.length === 0) {
      throw new TypeError(
        'anthropicProvider cannot encode a file reference without an "anthropic" file id',
      );
    }
    const isImage = mime.startsWith('image/');
    return {
      type: isImage ? 'image' : 'document',
      source: { type: 'file', file_id: fileId },
      ...(!isImage ? title : {}),
    };
  }

  if (mime.startsWith('image/')) {
    if (resolved.kind === 'url') {
      return { type: 'image', source: { type: 'url', url: resolved.url } };
    }
    if (resolved.kind === 'base64') {
      if (!SUPPORTED_IMAGE_TYPES.has(mime)) {
        throw new TypeError(`anthropicProvider does not support image media type "${mime}"`);
      }
      return {
        type: 'image',
        source: { type: 'base64', media_type: mime, data: resolved.base64 },
      };
    }
    throw new TypeError(`anthropicProvider cannot encode inline text as "${mime}"`);
  }

  if (mime === 'application/pdf') {
    if (resolved.kind === 'url') {
      return { type: 'document', source: { type: 'url', url: resolved.url }, ...title };
    }
    if (resolved.kind === 'base64') {
      return {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: resolved.base64 },
        ...title,
      };
    }
    throw new TypeError('anthropicProvider cannot encode inline text as application/pdf');
  }

  if (mime === 'text/plain') {
    if (resolved.kind === 'text') {
      return {
        type: 'document',
        source: { type: 'text', media_type: 'text/plain', data: resolved.text },
        ...title,
      };
    }
    if (resolved.kind === 'base64') {
      const text = sanitizeSurrogates(
        new TextDecoder().decode(base64ToBytes(resolved.base64)),
      );
      return {
        type: 'document',
        source: { type: 'text', media_type: 'text/plain', data: text },
        ...title,
      };
    }
    throw new TypeError(
      'anthropicProvider does not support URL sources for text/plain documents',
    );
  }

  throw new TypeError(
    `anthropicProvider does not support file media type "${mime || mediaType}"`,
  );
}

function isErrorFlagSet(providerOptions: AgentModelProviderOptions | undefined): boolean {
  const entry = readAnthropicProviderOptions(providerOptions);
  return entry?.isError === true || entry?.is_error === true;
}

/** Encode one canonical `AgentToolModelOutput` into Anthropic `tool_result` content + `is_error`. */
export function encodeAnthropicToolOutput(
  output: AgentToolModelOutput,
  part: Extract<AgentModelToolContentPart, { type: 'tool-result' }>,
): { readonly content: string | Record<string, unknown>[]; readonly isError: boolean } {
  switch (output.type) {
    case 'text':
      return { content: output.value, isError: false };
    case 'error-text':
      return { content: output.value, isError: true };
    case 'json':
      return { content: deterministicJson(output.value), isError: false };
    case 'error-json':
      return { content: deterministicJson(output.value), isError: true };
    case 'execution-denied':
      return {
        content:
          output.reason && output.reason.length > 0 ? output.reason : 'Tool execution denied',
        isError: true,
      };
    case 'content': {
      const isError =
        isErrorFlagSet(part.providerOptions) || isErrorFlagSet(output.providerOptions);
      const blocks: Record<string, unknown>[] = [];
      for (const item of output.value) {
        if (item.type === 'text' && item.text.length > 0)
          blocks.push({ type: 'text', text: item.text });
        else if (item.type === 'file') {
          blocks.push(encodeAnthropicFileBlock(item.data, item.mediaType, item.filename));
        } else if (item.type === 'custom') {
          blocks.push({ type: 'text', text: deterministicJson(item) });
        }
      }
      if (blocks.length === 0) {
        return { content: isError ? 'Tool execution failed' : '(no tool output)', isError };
      }
      return { content: blocks, isError };
    }
  }
}
