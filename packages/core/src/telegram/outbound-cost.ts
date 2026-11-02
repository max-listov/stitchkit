import { isRecord } from '../internal/typed';

/** The methods that produce a Telegram message and therefore spend the budget. */
const SEND_METHODS: ReadonlySet<string> = new Set([
  'sendMessage',
  'sendPhoto',
  'sendAudio',
  'sendDocument',
  'sendVideo',
  'sendAnimation',
  'sendVoice',
  'sendVideoNote',
  'sendPaidMedia',
  'sendMediaGroup',
  'sendLocation',
  'sendVenue',
  'sendContact',
  'sendPoll',
  'sendChecklist',
  'sendDice',
  'sendMessageDraft',
  'sendSticker',
  'sendInvoice',
  'sendGame',
  'sendGift',
  'sendGiveaway',
  'sendLivePhoto',
  'sendRichMessage',
  'copyMessage',
  'copyMessages',
  'forwardMessage',
  'forwardMessages',
  'answerWebAppQuery',
]);

/** The methods whose cost is the length of one array in the payload. */
const WEIGHTED_METHODS: ReadonlyMap<string, string> = new Map([
  ['sendMediaGroup', 'media'],
  ['sendPaidMedia', 'media'],
  ['copyMessages', 'message_ids'],
  ['forwardMessages', 'message_ids'],
]);

/** One message-producing call costs one; an empty or malformed array still costs one. */
export function sendCost(method: string, payload: unknown): number {
  if (!SEND_METHODS.has(method)) return 0;
  const field = WEIGHTED_METHODS.get(method);
  if (field === undefined || !isRecord(payload)) return 1;
  const value = payload[field];
  return Array.isArray(value) ? Math.max(1, value.length) : 1;
}

/** The chat a call addresses; a Bot API `chat_id` is a number or an `@username`. */
export function chatOf(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const chat = payload.chat_id;
  return typeof chat === 'number' || typeof chat === 'string' ? String(chat) : undefined;
}
