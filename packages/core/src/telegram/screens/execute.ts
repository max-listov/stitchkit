/**
 * Carrying out a view plan through the Bot API.
 *
 * The plan is what should work; this is what to do when Telegram disagrees.
 * Three refusals are expected in a live chat and none of them is a failure of
 * the screen:
 *
 * - **"message is not modified"** — the edit asked for what is already there
 *   (content the record never saw, an adopted message). It is success.
 * - **the message is gone or cannot be edited** — deleted by the user, or not
 *   ours. That message and every one after it are sent anew, because a new
 *   message lands at the bottom and the order must hold.
 * - **a deletion refused** — Telegram lets a bot delete only messages younger
 *   than 48 hours, and a network can drop the call. The view is already right
 *   without it; the message loses its buttons instead (an edit has no age
 *   limit), so no stale menu stays live, and its id is reported.
 *
 * Anything else — a rate limit, a payload Telegram cannot parse, a network
 * failure — stops the plan. What was already done is not undone: the
 * {@link PlanInterrupted} error carries the messages the chat now shows, with
 * the ones whose content is uncertain marked unknown, so the chat's record is
 * written true and the next render repairs the rest.
 */
import type { Api } from 'grammy';
import type {
  InlineKeyboardMarkup,
  InputRichMessage,
  LinkPreviewOptions,
  ParseMode,
} from 'grammy/types';
import { classifyTelegramEditRefusal, classifyTelegramSendFailure } from '../send-failure';
import type { PlanStep, ShownMessage, ViewPlan } from './reconcile';
import type { OutgoingMessage } from './render';

/** The Bot API methods screens call — `ctx.api` provides them. */
export type ScreenApi = Pick<
  Api,
  | 'sendMessage'
  | 'sendRichMessage'
  | 'sendPhoto'
  | 'sendVideo'
  | 'sendAnimation'
  | 'sendDocument'
  | 'sendAudio'
  | 'editMessageText'
  | 'editMessageCaption'
  | 'editMessageMedia'
  | 'editMessageReplyMarkup'
  | 'deleteMessage'
  | 'answerCallbackQuery'
>;

export type ChatId = number;

export interface ExecutionReport {
  readonly sent: number;
  readonly edited: number;
  readonly kept: number;
  readonly deleted: number;
  /** Messages Telegram would not delete; they stay, without buttons. */
  readonly undeleted: readonly number[];
}

export interface ExecutedView {
  readonly shown: readonly ShownMessage[];
  readonly report: ExecutionReport;
}

/**
 * A plan stopped by a refusal the chat cannot absorb. `shown` is what the chat
 * shows now, top to bottom — absent when no call changed what the record says,
 * empty when nothing of the view is left. `redrawn` names the messages that
 * now show the new view, each with the tokens its keyboard carries; `sentIds`
 * are those of them this attempt sent.
 */
export class PlanInterrupted extends Error {
  constructor(
    readonly shown: readonly ShownMessage[] | undefined,
    readonly redrawn: ReadonlyMap<number, readonly string[]>,
    readonly sentIds: readonly number[],
    override readonly cause: unknown,
  ) {
    super('[stitchkit] telegram screens: a view was left half-drawn by a Bot API failure.', {
      cause,
    });
    this.name = 'PlanInterrupted';
  }
}

function linkPreview(message: OutgoingMessage): LinkPreviewOptions | undefined {
  return message.linkPreview === false ? { is_disabled: true } : undefined;
}

function markupOption(markup: InlineKeyboardMarkup | undefined) {
  return markup ? { reply_markup: markup } : {};
}

const HTML: ParseMode = 'HTML';

function captionOption(message: OutgoingMessage) {
  return message.html === undefined ? {} : { caption: message.html, parse_mode: HTML };
}

function richPayload(message: OutgoingMessage): InputRichMessage | Promise<InputRichMessage> {
  return message.richBuild ? message.richBuild() : (message.rich ?? {});
}

export async function sendOutgoing(
  api: ScreenApi,
  chatId: ChatId,
  message: OutgoingMessage,
): Promise<number> {
  const extra = { ...captionOption(message), ...markupOption(message.markup) };
  const source = message.media ?? '';
  switch (message.kind) {
    case 'text':
      return (
        await api.sendMessage(chatId, message.html ?? '', {
          parse_mode: HTML,
          link_preview_options: linkPreview(message),
          ...markupOption(message.markup),
        })
      ).message_id;
    case 'rich':
      return (
        await api.sendRichMessage(
          chatId,
          await richPayload(message),
          markupOption(message.markup),
        )
      ).message_id;
    case 'photo':
      return (await api.sendPhoto(chatId, source, extra)).message_id;
    case 'video':
      return (await api.sendVideo(chatId, source, extra)).message_id;
    case 'animation':
      return (await api.sendAnimation(chatId, source, extra)).message_id;
    case 'document':
      return (await api.sendDocument(chatId, source, extra)).message_id;
    case 'audio':
      return (await api.sendAudio(chatId, source, extra)).message_id;
  }
}

async function editOutgoing(
  api: ScreenApi,
  chatId: ChatId,
  step: Extract<PlanStep, { op: 'edit' }>,
  rich: InputRichMessage | undefined,
): Promise<void> {
  const { message, parts, id } = step;
  const markup = markupOption(message.markup);
  if (message.kind === 'text' || message.kind === 'rich') {
    if (!parts.content) {
      await api.editMessageReplyMarkup(chatId, id, markup);
    } else if (rich) {
      await api.editMessageText(chatId, id, rich, markup);
    } else {
      await api.editMessageText(chatId, id, message.html ?? '', {
        parse_mode: HTML,
        link_preview_options: linkPreview(message),
        ...markup,
      });
    }
    return;
  }
  if (parts.media) {
    await api.editMessageMedia(
      chatId,
      id,
      { type: message.kind, media: message.media ?? '', ...captionOption(message) },
      markup,
    );
  } else if (parts.content) {
    await api.editMessageCaption(chatId, id, { ...captionOption(message), ...markup });
  } else {
    await api.editMessageReplyMarkup(chatId, id, markup);
  }
}

function shownFrom(id: number, message: OutgoingMessage): ShownMessage {
  return { key: message.key, id, kind: message.kind, fingerprint: message.fingerprint };
}

/**
 * Delete messages; a message Telegram will not delete loses its buttons
 * instead. Returns the ids that stayed. Never throws: by the time anything is
 * deleted the new view is in the chat, and failing on this last, optional step
 * would leave the chat's record behind the chat.
 */
export async function deleteMessages(
  api: ScreenApi,
  chatId: ChatId,
  ids: readonly number[],
): Promise<number[]> {
  const undeleted: number[] = [];
  for (const id of ids) {
    try {
      await api.deleteMessage(chatId, id);
    } catch (error) {
      // Already gone — the user deleted it: the deletion has nothing left to do.
      if (classifyTelegramEditRefusal(error) === 'message-gone') continue;
      undeleted.push(id);
      await api.editMessageReplyMarkup(chatId, id).catch(() => undefined);
    }
  }
  return undeleted;
}

export async function executePlan(
  api: ScreenApi,
  chatId: ChatId,
  plan: ViewPlan,
  previous: readonly ShownMessage[],
): Promise<ExecutedView> {
  const shown: ShownMessage[] = [];
  const visible = new Map(previous.map((message) => [message.id, message]));
  const deletions = [...plan.deletions];
  const redrawn = new Map<number, readonly string[]>();
  const sentIds: number[] = [];
  let foundMissing = false;
  let resending = false;
  let edited = 0;
  let kept = 0;
  const record = (id: number, message: OutgoingMessage) => {
    const entry = shownFrom(id, message);
    shown.push(entry);
    visible.set(id, entry);
    redrawn.set(id, message.tokenIds);
  };
  try {
    for (const step of plan.steps) {
      if (step.op === 'keep' && !resending) {
        shown.push(step.from);
        kept += 1;
        continue;
      }
      if (step.op === 'edit' && !resending) {
        // A factory failure happens before the API call and cannot have changed the chat.
        const rich =
          step.message.kind === 'rich' && step.parts.content
            ? await richPayload(step.message)
            : undefined;
        try {
          await editOutgoing(api, chatId, step, rich);
          edited += 1;
        } catch (error) {
          const refusal = classifyTelegramEditRefusal(error);
          if (refusal === 'not-modified') {
            kept += 1;
          } else if (refusal === 'message-gone' || refusal === 'message-locked') {
            if (refusal === 'message-gone') {
              visible.delete(step.id);
              foundMissing = true;
            }
            resending = true;
          } else {
            const failure = classifyTelegramSendFailure(error);
            if (failure.reason !== 'not-dispatched' && (failure.status ?? 500) >= 500) {
              // A lost reply may have followed a successful edit of this message.
              visible.set(step.id, { ...step.from, fingerprint: null });
              redrawn.set(step.id, step.message.tokenIds);
            }
            throw error;
          }
        }
        if (!resending) {
          record(step.id, step.message);
          continue;
        }
      }
      if (step.op !== 'send') deletions.push(step.id);
      const id = await sendOutgoing(api, chatId, step.message);
      sentIds.push(id);
      record(id, step.message);
    }
  } catch (error) {
    const snapshot =
      redrawn.size > 0 || foundMissing
        ? [...visible.values()].sort((left, right) => left.id - right.id)
        : undefined;
    throw new PlanInterrupted(snapshot, redrawn, sentIds, error);
  }
  const undeleted = await deleteMessages(api, chatId, deletions);
  return {
    shown,
    report: {
      sent: sentIds.length,
      edited,
      kept,
      deleted: deletions.length - undeleted.length,
      undeleted,
    },
  };
}
