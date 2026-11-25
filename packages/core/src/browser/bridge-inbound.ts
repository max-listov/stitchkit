/**
 * What the window makes of a frame the host sent: a frame, or the reason it was dropped and,
 * when the frame says so, the call it answered — that call is refused, never left waiting.
 */
import {
  type BridgeFrame,
  BridgeFrameSchema,
  type BridgeResponseFrame,
} from '../contract/bridge-envelope';
import { utf8ByteLength } from '../internal/bounded-body';
import { isRecord } from '../internal/typed';
import { BridgeFailureError, createUnusableReplyError } from './bridge-errors';

/** Reason an inbound bridge frame was dropped without failing the channel. */
export type BridgeDropReason = 'frame-too-large' | 'invalid-frame' | 'unknown-id';

/** A frame read from the host, or why it was dropped and which call it answered, if known. */
export type InboundFrame =
  | { readonly frame: BridgeFrame }
  | { readonly dropped: BridgeDropReason; readonly replyTo?: string };

/** The longest `windowInstance` a window takes: every id it sends stays addressable from a head. */
export const MAX_WINDOW_INSTANCE_LENGTH = 128;

/**
 * The longest id literal a reply head can carry: an id is `${windowInstance}:${counter}`, JSON
 * writes one character in at most six (`\u0001`), and a safe-integer counter has at most 16 digits.
 */
const MAX_ID_LITERAL = MAX_WINDOW_INSTANCE_LENGTH * 6 + 1 + 16;
const REPLY_HEAD_PREFIX = '{"v":1,"kind":"response","id":';

/**
 * The head `serveBridge` writes every reply with. A frame too large to parse is addressed from
 * it alone, so its call is refused without reading past the limit.
 */
const REPLY_HEAD = new RegExp(
  `^\\{"v":1,"kind":"(?:response|failure)","id":("(?:[^"\\\\]|\\\\.){1,${MAX_ID_LITERAL}}")`,
);
const REPLY_HEAD_LENGTH = REPLY_HEAD_PREFIX.length + MAX_ID_LITERAL + 2;

function replyIdFromHead(raw: string): string | undefined {
  const literal = REPLY_HEAD.exec(raw.slice(0, REPLY_HEAD_LENGTH))?.[1];
  if (literal === undefined) return undefined;
  try {
    const id: unknown = JSON.parse(literal);
    return typeof id === 'string' ? id : undefined;
  } catch {
    return undefined;
  }
}

/** The call a parsed frame that failed the schema answers, when it names one. */
function replyIdOf(value: unknown): string | undefined {
  if (!isRecord(value) || (value.kind !== 'response' && value.kind !== 'failure')) {
    return undefined;
  }
  return typeof value.id === 'string' ? value.id : undefined;
}

function dropped(reason: BridgeDropReason, replyTo: string | undefined): InboundFrame {
  return replyTo === undefined ? { dropped: reason } : { dropped: reason, replyTo };
}

/** Read one inbound frame, bounded by `maxFrameBytes` before `JSON.parse`. */
export function readInboundFrame(raw: unknown, maxFrameBytes: number): InboundFrame {
  if (typeof raw !== 'string') return { dropped: 'invalid-frame' };
  if (utf8ByteLength(raw) > maxFrameBytes) {
    return dropped('frame-too-large', replyIdFromHead(raw));
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return { dropped: 'invalid-frame' };
  }
  const parsed = BridgeFrameSchema.safeParse(parsedJson);
  if (!parsed.success) return dropped('invalid-frame', replyIdOf(parsedJson));
  return { frame: parsed.data };
}

/** The refusal of a call whose reply was dropped: the same host would send it again. */
export function droppedReplyError(
  reason: BridgeDropReason,
  maxFrameBytes: number,
): BridgeFailureError | TypeError {
  if (reason === 'frame-too-large') {
    return new BridgeFailureError(
      'frame-too-large',
      `Bridge reply frame exceeds this window's ${maxFrameBytes}-byte limit`,
    );
  }
  return createUnusableReplyError('Invalid bridge reply frame');
}

/**
 * The frame as this window's `Response`. The frame schema admits header values and a status text
 * this runtime's `Headers` and `Response` may refuse (a host whose `Headers` does not check them
 * sends a non-ByteString value): such a reply is refused, never left unanswered.
 */
export function buildResponseFromFrame(frame: BridgeResponseFrame): Response {
  try {
    const headers = new Headers();
    for (const [key, value] of frame.headers) {
      headers.append(key, value);
    }
    const nullBodyStatus =
      frame.status === 204 || frame.status === 205 || frame.status === 304;
    const body = nullBodyStatus ? null : (frame.body ?? '');
    return new Response(body, {
      status: frame.status,
      statusText: frame.statusText,
      headers,
    });
  } catch (cause) {
    throw createUnusableReplyError('Bridge reply cannot be read as a Response', cause);
  }
}
