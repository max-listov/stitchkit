import { Bot, type BotConfig, type Context, MemorySessionStorage } from 'grammy';
import { createApplication } from 'stitchkit/application';
import {
  createGrammyWebhookResource,
  grammyPollingResource,
} from 'stitchkit/application/grammy';
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
console.log('grammy consumer: typed adapters ok');
