import { Bot, type BotConfig, type Context } from 'grammy';
import { createApplication } from 'stitchkit/application';
import {
  createGrammyWebhookResource,
  grammyPollingResource,
} from 'stitchkit/application/grammy';

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
console.log('grammy consumer: typed adapters ok');
