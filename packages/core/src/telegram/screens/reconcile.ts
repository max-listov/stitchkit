/**
 * From what the chat shows to what it should show, in the fewest Bot API calls
 * that keep the chat in order.
 *
 * Telegram orders messages by when they were sent, and a sent message cannot
 * move. So a message is kept (and edited in place) only while the new view's
 * order allows it: walking the new view top to bottom, a message whose key the
 * chat already shows — below the last one kept, and editable into the new
 * shape — is kept. The first message that cannot be kept is sent, and so is
 * every message after it, because anything sent lands at the bottom; whatever
 * the chat showed and was not kept is deleted.
 *
 * Editable means what the Bot API can do in place: text into text and rich
 * into rich (`editMessageText`), text or rich into media and media into media
 * of any kind (`editMessageMedia`). Media into text or rich, and text into rich
 * or back, is a new message.
 *
 * The plan is data. Carrying it out — and recovering when Telegram refuses an
 * edit it allowed a moment ago — is `execute`'s.
 */
import type { MessageFingerprint, OutgoingMessage, RenderedKind } from './render';

/** A message the chat shows, as the chat's state remembers it. */
export interface ShownMessage {
  readonly key: string;
  readonly id: number;
  readonly kind: RenderedKind;
  /** `null` for a message whose content is not known — one adopted from a press. */
  readonly fingerprint: MessageFingerprint | null;
}

export interface EditParts {
  readonly content: boolean;
  readonly media: boolean;
  readonly markup: boolean;
}

export type PlanStep =
  | {
      readonly op: 'keep';
      readonly id: number;
      readonly from: ShownMessage;
      readonly message: OutgoingMessage;
    }
  | {
      readonly op: 'edit';
      readonly id: number;
      readonly from: ShownMessage;
      readonly message: OutgoingMessage;
      readonly parts: EditParts;
    }
  | { readonly op: 'send'; readonly message: OutgoingMessage };

export interface ViewPlan {
  /** The new view, top to bottom: each message kept, edited or sent. */
  readonly steps: readonly PlanStep[];
  /** Messages the chat showed that the new view does not keep. */
  readonly deletions: readonly number[];
}

const isMedia = (kind: RenderedKind): boolean => kind !== 'text' && kind !== 'rich';

export function isEditable(from: RenderedKind, to: RenderedKind): boolean {
  return isMedia(to) || from === to;
}

function stepFor(shown: ShownMessage, message: OutgoingMessage): PlanStep {
  const before = shown.fingerprint;
  const mediaChanged =
    shown.kind !== message.kind || before?.media !== message.fingerprint.media;
  const parts: EditParts = {
    content: before?.content !== message.fingerprint.content,
    media: isMedia(message.kind) && mediaChanged,
    markup: before?.markup !== message.fingerprint.markup,
  };
  return parts.content || parts.media || parts.markup
    ? { op: 'edit', id: shown.id, from: shown, message, parts }
    : { op: 'keep', id: shown.id, from: shown, message };
}

export interface PlanOptions {
  /**
   * The message a press came from, when it is not part of the view the chat
   * state knows. It becomes the first message of the new view if it can.
   */
  readonly adopt?: ShownMessage;
  /** Send the whole view anew below everything, deleting what was shown. */
  readonly fresh?: boolean;
}

export function planView(
  shown: readonly ShownMessage[],
  next: readonly OutgoingMessage[],
  options: PlanOptions = {},
): ViewPlan {
  if (options.fresh) {
    const deletions = [...shown.map((message) => message.id)];
    if (options.adopt) deletions.push(options.adopt.id);
    return { steps: next.map((message) => ({ op: 'send', message })), deletions };
  }
  const kept = new Set<number>();
  const steps: PlanStep[] = [];
  let cursor = 0;
  let sending = false;
  for (const [index, message] of next.entries()) {
    if (!sending) {
      const position = options.adopt
        ? -1
        : shown.findIndex((entry, at) => at >= cursor && entry.key === message.key);
      const candidate = options.adopt
        ? index === 0
          ? options.adopt
          : undefined
        : shown[position];
      if (candidate && isEditable(candidate.kind, message.kind)) {
        cursor = position + 1;
        kept.add(candidate.id);
        steps.push(stepFor(candidate, message));
        continue;
      }
      sending = true;
    }
    steps.push({ op: 'send', message });
  }
  const previous = options.adopt ? [options.adopt] : shown;
  const deletions = previous.filter((entry) => !kept.has(entry.id)).map((entry) => entry.id);
  return { steps, deletions };
}
