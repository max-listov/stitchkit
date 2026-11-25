import { Api, Bot, type BotConfig, type Context, MemorySessionStorage } from 'grammy';
import { createApplication } from 'stitchkit/application';
import {
  createGrammyWebhookResource,
  grammyPollingResource,
} from 'stitchkit/application/grammy';
import { telegramOutboundBudget } from 'stitchkit/telegram';
import { telegramBudgetTransformer, telegramWidgetApi } from 'stitchkit/telegram/grammy';
import {
  back,
  createScreenTestChat,
  html,
  link,
  type ScreenChatState,
  telegramScreens,
} from 'stitchkit/telegram/screens';

const botInfo: NonNullable<BotConfig<Context>['botInfo']> = {
  id: 1,
  is_bot: true,
  first_name: 'Packed bot',
  username: 'packed_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
  supports_guest_queries: false,
  needs_inline_query_location: false,
  has_topic_sidebar: false,
};
const pollingBot = new Bot<Context>('packed-token', { botInfo });
const webhookBot = new Bot<Context>('packed-token', { botInfo });
const polling = grammyPollingResource({ id: 'polling', bot: pollingBot, required: false });
const webhook = createGrammyWebhookResource({ id: 'webhook', bot: webhookBot });
const app = createApplication({ id: 'packed-grammy', resources: [webhook.resource] });
void polling;
void app;

// Screens: the params of `/item/:itemId` come from the path literal, and the
// test chat drives the packed middleware through a real `Bot`.
const tg = telegramScreens<Context>();
const home = tg.screen('/').view(() => ({
  text: html`<b>Items</b>`,
  keyboard: [[link('First', item, { itemId: '1' })]],
}));
const item = tg
  .screen('/item/:itemId')
  .load((c) => ({ name: `item ${c.params.itemId}` }))
  .view(({ data }) => ({ text: data.name, keyboard: [[back('« Back')]] }));
const screensBot = new Bot<Context>('packed-token', { botInfo });
const screens = tg.create({
  screens: [home, item],
  storage: new MemorySessionStorage<ScreenChatState>(),
});
screensBot.use(screens);
screensBot.command('start', (ctx) => screens.open(ctx, home));
const chat = createScreenTestChat(screensBot);
await chat.send('/start');
await chat.press('First');
if (chat.messages.at(-1)?.text !== 'item 1')
  throw new Error('screens: the press did not navigate');
screens.close();
// Budget: the transformer is typed by grammY's own `Transformer`, installs without a
// cast, and reads the 429 grammY returns as a response before it becomes an error.
const budget = telegramOutboundBudget({
  token: 'packed-budget-token',
  retryAfterFallbackMs: 60_000,
});
const budgetApi = new Api('packed-budget-token', {
  fetch: async () =>
    Response.json(
      { ok: false, error_code: 429, description: 'Too Many Requests' },
      { status: 429 },
    ),
});
budgetApi.config.use(telegramBudgetTransformer(budget));
await budgetApi.sendMessage(1, 'limited').catch(() => undefined);
if (budget.stats().pausedChats !== 1)
  throw new Error('budget: a returned 429 did not pause its chat');
// Widgets: the methods take grammY's own client and keyboard types, and run
// through its transformer, so a widget send spends one slot of the budget.
const widgetBudget = telegramOutboundBudget({ token: 'packed-widget-token' });
const widgetApi = new Api('packed-widget-token', {
  fetch: async () =>
    Response.json({
      ok: true,
      result: {
        message_id: 3,
        chat: { id: 1, type: 'private' },
        widget: { html: '<b>w</b>' },
      },
    }),
});
widgetApi.config.use(telegramBudgetTransformer(widgetBudget));
const sent = await telegramWidgetApi(widgetApi).sendWidget({
  chat_id: 1,
  html: '<b>w</b>',
  chat_data: '',
  reply_markup: { inline_keyboard: [[{ text: 'Open', url: 'https://example.com' }]] },
});
if (sent.message_id !== 3 || widgetBudget.stats().messages !== 1)
  throw new Error('widgets: the send did not spend exactly one budgeted message');
console.log('grammy consumer: typed adapters ok');
