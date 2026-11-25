import type { AgentMessagePart } from '../agent-parts/parts';
import { raceAbort } from '../internal/abort-race';
import { assertPositiveSafeInteger } from '../internal/positive-integer';

/** Default largest single image accepted by an agent-executor driver (5 MiB). */
export const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Bounded stdout line ceiling for Claude CLI sessions (16 MiB): leaves headroom above the
 * 8 MiB outgoing stdin frame limit for `--replay-user-messages` metadata added on echo.
 */
export const CLAUDE_CLI_MAX_LINE_BYTES = 16 * 1024 * 1024;

/** Image MIME types accepted by Claude and Codex turn inputs. */
export type SupportedImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/** Image MIME types accepted by Claude and Codex turn inputs. */
export const SUPPORTED_IMAGE_MEDIA_TYPES: ReadonlySet<SupportedImageMediaType> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

/** Narrow a MIME type string to the image types supported by Claude and Codex. */
export function isSupportedImageMediaType(value: string): value is SupportedImageMediaType {
  return (
    value === 'image/png' ||
    value === 'image/jpeg' ||
    value === 'image/gif' ||
    value === 'image/webp'
  );
}

/** Common image-attachment options shared across agent-executor drivers. */
export interface DriverImageOptions {
  /** Read the bytes behind a `file` part's `reference`; without it a file part is refused. */
  resolveFile?: (reference: string) => Promise<Uint8Array>;
  /** Maximum decoded size of one image attachment in bytes. Default 5 MiB. */
  maxImageBytes?: number;
}

/** One validated, host-resolved part ready to encode in a driver's wire format. */
export type InlinedPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly mediaType: string; readonly base64: string };

/** Validate driver-level image bounds eagerly before any process is spawned. */
export function validateImageOptions(
  options: Pick<DriverImageOptions, 'maxImageBytes'>,
): void {
  assertPositiveSafeInteger('maxImageBytes', options.maxImageBytes);
}

/** Zero-copy base64 encoding of a `Uint8Array` view. */
export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

/**
 * Resolve one image attachment via the host's `resolveFile`, enforcing `maxImageBytes` and
 * non-empty binary output without leaking the reference or host path in thrown errors.
 */
export async function resolveImageBytes(
  reference: string,
  options: {
    resolveFile: (reference: string) => Promise<Uint8Array>;
    maxImageBytes: number;
  },
): Promise<Uint8Array> {
  assertPositiveSafeInteger('maxImageBytes', options.maxImageBytes);
  let bytes: unknown;
  try {
    bytes = await options.resolveFile(reference);
  } catch {
    // Never forward `reference` or host filesystem error messages/causes across the boundary.
    throw new Error('Failed to resolve image input');
  }
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('resolveFile must return a Uint8Array');
  }
  if (bytes.byteLength === 0) {
    throw new RangeError('The image is empty (0 bytes)');
  }
  if (bytes.byteLength > options.maxImageBytes) {
    throw new RangeError(
      `The image is ${bytes.byteLength} bytes, over maxImageBytes ${options.maxImageBytes}`,
    );
  }
  return bytes;
}

/**
 * Validate every part synchronously before the first `resolveFile` call, then resolve and
 * base64-encode every image attachment in order. Any refusal rejects the whole turn before
 * anything is sent to the engine.
 */
export async function inlineParts(
  parts: readonly AgentMessagePart[],
  options: DriverImageOptions & {
    driverLabel: string;
    signal?: AbortSignal;
  },
): Promise<InlinedPart[]> {
  const maxImageBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  assertPositiveSafeInteger('maxImageBytes', maxImageBytes);

  // Synchronous pre-pass: refuse unsupported part types, media types, or missing resolver
  // before any `resolveFile` call buffers bytes in memory.
  for (const part of parts) {
    if (part.type === 'text') continue;
    if (part.type !== 'file') {
      throw new TypeError(
        `${options.driverLabel} sends text and images, received ${part.type}`,
      );
    }
    if (!isSupportedImageMediaType(part.mediaType)) {
      throw new TypeError(
        `${options.driverLabel} sends PNG, JPEG, GIF or WebP images only, received a file of ${part.mediaType}`,
      );
    }
    if (options.resolveFile === undefined) {
      throw new TypeError('An image needs resolveFile to read its bytes');
    }
  }

  const resolved: InlinedPart[] = [];
  for (const part of parts) {
    if (part.type === 'text') {
      resolved.push({ type: 'text', text: part.text });
      continue;
    }
    if (part.type !== 'file' || options.resolveFile === undefined) continue;
    const read = resolveImageBytes(part.reference, {
      resolveFile: options.resolveFile,
      maxImageBytes,
    });
    const bytes = options.signal ? await raceAbort(read, options.signal) : await read;
    resolved.push({
      type: 'image',
      mediaType: part.mediaType,
      base64: bytesToBase64(bytes),
    });
  }
  return resolved;
}

/**
 * Serialize-guard an outgoing JSON frame against a byte limit without leaking payload bytes
 * or references in the error message.
 */
export function assertImageFrameBytes(serialized: string, maxBytes: number): void {
  const byteLength = Buffer.byteLength(serialized);
  if (byteLength > maxBytes) {
    throw new RangeError(
      `Turn input frame is ${byteLength} bytes, over the ${maxBytes}-byte frame limit`,
    );
  }
}

/**
 * Guard a session's `startTurn` while host attachments are resolved asynchronously: prevents
 * concurrent `startTurn` calls during `resolveFile` and re-checks session liveness after await.
 */
export function imageTurnStarter<
  TInput extends { readonly input: readonly AgentMessagePart[] },
  TTurn,
>(options: {
  driverLabel: string;
  busyMessage: string;
  imageOptions: DriverImageOptions;
  signal?: AbortSignal;
  check(input: TInput): void;
  dispatch(input: TInput, parts: readonly InlinedPart[]): TTurn | Promise<TTurn>;
}): (input: TInput) => Promise<TTurn> {
  let preparing = false;
  return async (input) => {
    if (preparing) throw new Error(options.busyMessage);
    options.check(input);
    preparing = true;
    let parts: readonly InlinedPart[];
    try {
      parts = await inlineParts(input.input, {
        ...options.imageOptions,
        driverLabel: options.driverLabel,
        signal: options.signal,
      });
    } finally {
      preparing = false;
    }
    options.check(input);
    return await options.dispatch(input, parts);
  };
}
