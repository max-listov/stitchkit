import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { mediaExtension } from '../../internal/media-extension';
import { isRecord } from '../../internal/typed';
import { McpAudioContentSchema, McpImageContentSchema } from '../transfer/view-file-contract';

/** MCP's carrier for a file of any type: its bytes as base64 `blob`, or its `text`. */
const EmbeddedResourceSchema = z.object({
  type: z.literal('resource'),
  resource: z.union([
    z.object({ uri: z.string(), mimeType: z.string().optional(), blob: z.string() }),
    z.object({ uri: z.string(), mimeType: z.string().optional(), text: z.string() }),
  ]),
});

const InlineFileSchema = z.discriminatedUnion('type', [
  McpImageContentSchema,
  McpAudioContentSchema,
  EmbeddedResourceSchema,
]);

type InlineFile = z.infer<typeof InlineFileSchema>;

/** One block of a result that carries a file, and its position in the result's `content`. */
export interface InlineFileBlock {
  index: number;
  file: InlineFile;
}

/**
 * The blocks in a result's top-level `content` that carry a file: an `image` or `audio`
 * block of the media schema, or an embedded `resource` of any type. A part of any other
 * shape — a rich-text node that also calls itself `image` — is the result's own data and
 * is left alone.
 */
export function inlineFileBlocks(data: unknown): InlineFileBlock[] {
  if (!isRecord(data) || !Array.isArray(data.content)) return [];
  return data.content.flatMap((part, index) => {
    const parsed = InlineFileSchema.safeParse(part);
    return parsed.success ? [{ index, file: parsed.data }] : [];
  });
}

/** Decode canonical base64, refusing an oversize file before allocating it. */
function decodeBase64(data: string, maxBytes: number): Buffer {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  const decodedLength = Math.floor(((data.length - padding) * 3) / 4);
  if (data.length > Math.ceil(maxBytes / 3) * 4 || decodedLength > maxBytes) {
    throw new Error(`file exceeds the ${maxBytes}-byte cap`);
  }
  if (
    data.length % 4 === 1 ||
    (padding > 0 && data.length % 4 !== 0) ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
  ) {
    throw new Error('invalid base64');
  }
  const bytes = Buffer.from(data, 'base64');
  // Buffer's decoder is permissive, including nonzero unused bits. Accept canonical
  // standard base64 with or without its final padding, never silent byte repair.
  if (!bytes.toString('base64').startsWith(data)) throw new Error('invalid base64');
  return bytes;
}

/** A text resource is its UTF-8 bytes; every UTF-16 unit is at least one of them. */
function encodeText(text: string, maxBytes: number): Buffer {
  const bytes = text.length > maxBytes ? undefined : Buffer.from(text, 'utf8');
  if (!bytes || bytes.length > maxBytes) {
    throw new Error(`file exceeds the ${maxBytes}-byte cap`);
  }
  return bytes;
}

/** The bytes of one block, bounded before they are allocated. */
export function inlineFileBytes(file: InlineFile, maxBytes: number): Buffer {
  if (file.type !== 'resource') return decodeBase64(file.data, maxBytes);
  return 'blob' in file.resource
    ? decodeBase64(file.resource.blob, maxBytes)
    : encodeText(file.resource.text, maxBytes);
}

/** The last path segment of a resource URI; empty when the URI names no file. */
function uriFileName(uri: string): string {
  try {
    return basename(new URL(uri).pathname);
  } catch {
    return '';
  }
}

export function inlineFileMimeType(file: InlineFile): string | undefined {
  return file.type === 'resource' ? file.resource.mimeType : file.mimeType;
}

/**
 * The file name of a block: a media block's `name` or the file name in a resource's URI.
 * A block that names no file is `<type>-<sha256 of its bytes><extension>`; a media block
 * that names an empty one is refused by the writer like any other unusable name.
 */
export function inlineFileName(file: InlineFile, digest: string): string {
  const own =
    file.type === 'resource' ? uriFileName(file.resource.uri) || undefined : file.name;
  return (
    own ?? `${file.type}-${digest}${mediaExtension(inlineFileMimeType(file) ?? '') ?? '.bin'}`
  );
}

/**
 * The result as stdout prints it once its files are saved: each saved block gives up its
 * bytes for an MCP resource link to the file. A block that was not saved keeps its bytes.
 */
export function linkSavedFiles(
  data: unknown,
  blocks: readonly InlineFileBlock[],
  saved: (block: InlineFileBlock) => { path: string; name: string; size: number } | undefined,
): unknown {
  if (!isRecord(data) || !Array.isArray(data.content)) return data;
  const links = new Map<number, unknown>();
  for (const block of blocks) {
    const file = saved(block);
    if (!file) continue;
    const mimeType = inlineFileMimeType(block.file);
    links.set(block.index, {
      type: 'resource_link',
      uri: pathToFileURL(file.path).href,
      name: file.name,
      ...(mimeType !== undefined && { mimeType }),
      size: file.size,
    });
  }
  if (links.size === 0) return data;
  return { ...data, content: data.content.map((part, index) => links.get(index) ?? part) };
}
