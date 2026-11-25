import { isRecord } from '../internal/typed';

/** The methods Telegram counts as sent messages, including widget data edits. */
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
  'sendRichMessageDraft',
  'sendChatJoinRequestWebApp',
  'sendSticker',
  'sendInvoice',
  'sendGame',
  'sendGift',
  'sendLivePhoto',
  'sendRichMessage',
  // Bot API 10.4 HTML widgets (newer than @grammyjs/types@5.0.0); verified against
  // https://core.telegram.org/bots/api#sendwidget, #sendsharedwidget, #editmessagewidgetdata
  // and https://core.telegram.org/bots/widgets#changing-the-state (data edits count as sends).
  'sendWidget',
  'sendSharedWidget',
  'editMessageWidgetData',
  'copyMessage',
  'copyMessages',
  'forwardMessage',
  'forwardMessages',
  'answerWebAppQuery',
]);

/**
 * The Bot API methods that send nothing a chat counts: reads, edits of a message
 * already sent, administration. Every other method costs one — a method this
 * list does not know, a new one Telegram added, is counted rather than let
 * through free, so the budget fails closed. Every method grammY's types name
 * (including deprecated property aliases) is classified here or as a send
 * (`tests/telegram-outbound-cost.test.ts`).
 */
const FREE_METHODS: ReadonlySet<string> = new Set([
  // Bot API 10.4 HTML widgets (newer than @grammyjs/types@5.0.0); verified against
  // https://core.telegram.org/bots/api#answerwidgetquery (15 s query reply) and
  // https://core.telegram.org/bots/api#editsharedwidgetdata (own 1/s shared-widget limit).
  'answerWidgetQuery',
  'editSharedWidgetData',
  'addStickerToSet',
  'answerCallbackQuery',
  'answerChatJoinRequestQuery',
  'answerGuestQuery',
  'answerInlineQuery',
  'answerPreCheckoutQuery',
  'answerShippingQuery',
  'approveChatJoinRequest',
  // Verified against https://core.telegram.org/bots/api#approvesuggestedpost: admin approval in a
  // direct messages chat returning True, not a bot-sent message.
  'approveSuggestedPost',
  'banChatMember',
  'banChatSenderChat',
  'close',
  'closeForumTopic',
  'closeGeneralForumTopic',
  'convertGiftToStars',
  'createChatInviteLink',
  'createChatSubscriptionInviteLink',
  'createForumTopic',
  'createInvoiceLink',
  'createNewStickerSet',
  'declineChatJoinRequest',
  'declineSuggestedPost',
  'deleteAllMessageReactions',
  'deleteBusinessMessages',
  'deleteChatPhoto',
  'deleteChatStickerSet',
  'deleteEphemeralMessage',
  'deleteForumTopic',
  'deleteMessage',
  'deleteMessageReaction',
  'deleteMessages',
  'deleteMyCommands',
  'deleteStickerFromSet',
  'deleteStickerSet',
  'deleteStory',
  'deleteWebhook',
  'editChatInviteLink',
  'editChatSubscriptionInviteLink',
  'editEphemeralMessageCaption',
  'editEphemeralMessageMedia',
  'editEphemeralMessageReplyMarkup',
  'editEphemeralMessageText',
  'editForumTopic',
  'editGeneralForumTopic',
  'editMessageCaption',
  'editMessageChecklist',
  'editMessageLiveLocation',
  'editMessageMedia',
  'editMessageReplyMarkup',
  'editMessageText',
  'editStory',
  'editUserStarSubscription',
  'exportChatInviteLink',
  'getAvailableGifts',
  'getBusinessAccountGifts',
  'getBusinessAccountStarBalance',
  'getBusinessConnection',
  'getChat',
  'getChatAdministrators',
  'getChatGifts',
  'getChatMember',
  'getChatMemberCount',
  // Deprecated Bot API alias for `getChatMemberCount` (`@grammyjs/types` property alias).
  'getChatMembersCount',
  'getChatMenuButton',
  'getCustomEmojiStickers',
  'getFile',
  'getForumTopicIconStickers',
  'getGameHighScores',
  'getManagedBotAccessSettings',
  'getManagedBotToken',
  'getMe',
  'getMyCommands',
  'getMyDefaultAdministratorRights',
  'getMyDescription',
  'getMyName',
  'getMyShortDescription',
  'getMyStarBalance',
  'getStarTransactions',
  'getStickerSet',
  'getUpdates',
  'getUserChatBoosts',
  'getUserGifts',
  'getUserPersonalChatMessages',
  'getUserProfileAudios',
  'getUserProfilePhotos',
  'getWebhookInfo',
  'giftPremiumSubscription',
  'hideGeneralForumTopic',
  // Deprecated Bot API alias for `banChatMember` (`@grammyjs/types` property alias).
  'kickChatMember',
  'leaveChat',
  'logOut',
  'pinChatMessage',
  'postStory',
  'promoteChatMember',
  'readBusinessMessage',
  'refundStarPayment',
  'removeBusinessAccountProfilePhoto',
  'removeChatVerification',
  'removeMyProfilePhoto',
  'removeUserVerification',
  'reopenForumTopic',
  'reopenGeneralForumTopic',
  'replaceManagedBotToken',
  'replaceStickerInSet',
  'repostStory',
  'restrictChatMember',
  'revokeChatInviteLink',
  'savePreparedInlineMessage',
  'savePreparedKeyboardButton',
  'sendChatAction',
  'setBusinessAccountBio',
  'setBusinessAccountGiftSettings',
  'setBusinessAccountName',
  'setBusinessAccountProfilePhoto',
  'setBusinessAccountUsername',
  'setChatAdministratorCustomTitle',
  'setChatDescription',
  'setChatMemberTag',
  'setChatMenuButton',
  'setChatPermissions',
  'setChatPhoto',
  'setChatStickerSet',
  'setChatTitle',
  'setCustomEmojiStickerSetThumbnail',
  'setGameScore',
  'setManagedBotAccessSettings',
  'setMessageReaction',
  'setMyCommands',
  'setMyDefaultAdministratorRights',
  'setMyDescription',
  'setMyName',
  'setMyProfilePhoto',
  'setMyShortDescription',
  'setPassportDataErrors',
  'setStickerEmojiList',
  'setStickerKeywords',
  'setStickerMaskPosition',
  'setStickerPositionInSet',
  'setStickerSetThumbnail',
  'setStickerSetTitle',
  'setUserEmojiStatus',
  'setWebhook',
  'stopMessageLiveLocation',
  'stopPoll',
  'transferBusinessAccountStars',
  'transferGift',
  'unbanChatMember',
  'unbanChatSenderChat',
  'unhideGeneralForumTopic',
  'unpinAllChatMessages',
  'unpinAllForumTopicMessages',
  'unpinAllGeneralForumTopicMessages',
  'unpinChatMessage',
  'upgradeGift',
  'uploadStickerFile',
  'verifyChat',
  'verifyUser',
]);

/** The methods whose cost is the length of one array in the payload. */
const WEIGHTED_METHODS: ReadonlyMap<string, string> = new Map([
  ['sendMediaGroup', 'media'],
  ['sendPaidMedia', 'media'],
  ['copyMessages', 'message_ids'],
  ['forwardMessages', 'message_ids'],
]);

/**
 * One counted call costs one; an empty or malformed weighted array still costs
 * one; a free method costs nothing; an unknown method costs one.
 */
export function sendCost(method: string, payload: unknown): number {
  if (FREE_METHODS.has(method)) return 0;
  if (!SEND_METHODS.has(method)) return 1;
  const field = WEIGHTED_METHODS.get(method);
  if (field === undefined || !isRecord(payload)) return 1;
  const value = payload[field];
  return Array.isArray(value) ? Math.max(1, value.length) : 1;
}

/** The two lists, for the test that keeps every known method in exactly one. */
export const OUTBOUND_METHOD_CLASSES = { send: SEND_METHODS, free: FREE_METHODS } as const;

/** The chat a call addresses; a Bot API `chat_id` is a number or an `@username`. */
export function chatOf(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const chat = payload.chat_id;
  return typeof chat === 'number' || typeof chat === 'string' ? String(chat) : undefined;
}
