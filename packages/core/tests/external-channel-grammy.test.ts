/**
 * The grammY composition from the agent-runtime guide, run rather than only
 * compiled: a mapped update reaches the channel, an unmapped one falls through
 * to the bot's own handlers, and the mode picks the managed resource.
 */
import { describe, expect, test } from 'bun:test';
import { Bot, type BotConfig, type Context } from 'grammy';
import type { Update } from 'grammy/types';
import { composeGrammyExternalChannel } from '../examples/agent-runtime/external-channel-grammy';
import type {
  ExternalChannelHarness,
  ExternalIngress,
} from '../examples/agent-runtime/external-channel-harness';

const botInfo: NonNullable<BotConfig<Context>['botInfo']> = {
  id: 1,
  is_bot: true,
  first_name: 'Example bot',
  username: 'example_bot',
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

function message(updateId: number, text: string): Update {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 0,
      chat: { id: 7, type: 'private', first_name: 'Ada' },
      from: { id: 7, is_bot: false, first_name: 'Ada' },
      text,
    },
  };
}

function channelRecording(ingested: ExternalIngress[]): ExternalChannelHarness {
  const unused = () => Promise.reject(new Error('not part of this example'));
  return {
    // The composition only ever calls `ingest`; the rest belongs to the harness.
    application: undefined as never,
    ingest: async (input) => {
      ingested.push(input);
      return { outcome: 'accepted', runId: `run-${input.updateId}` };
    },
    publish: unused,
    flush: unused,
    reconcile: unused,
  };
}

describe('grammY external channel example', () => {
  test('a mapped update is ingested and an unmapped one reaches the bot', async () => {
    const bot = new Bot<Context>('test-token', { botInfo });
    const ingested: ExternalIngress[] = [];
    const fellThrough: string[] = [];
    const resource = composeGrammyExternalChannel({
      id: 'telegram',
      bot,
      channel: channelRecording(ingested),
      mode: 'polling',
      map: (context) =>
        context.message?.text?.startsWith('/ask ')
          ? {
              updateId: String(context.update.update_id),
              principalId: String(context.from?.id),
              conversationId: String(context.chat?.id),
              replyTarget: String(context.chat?.id),
              text: context.message.text.slice('/ask '.length),
            }
          : undefined,
    });
    bot.on('message:text', (context) => {
      fellThrough.push(context.message.text);
    });

    await bot.handleUpdate(message(1, '/ask what is new?'));
    await bot.handleUpdate(message(2, 'hello'));

    expect(ingested).toEqual([
      {
        updateId: '1',
        principalId: '7',
        conversationId: '7',
        replyTarget: '7',
        text: 'what is new?',
      },
    ]);
    expect(fellThrough).toEqual(['hello']);
    // Polling mode hands back the managed resource itself.
    expect('id' in resource && resource.id).toBe('telegram');
  });

  test('webhook mode builds the webhook resource, which carries its own handleUpdate', () => {
    const resource = composeGrammyExternalChannel({
      id: 'hook',
      bot: new Bot<Context>('test-token', { botInfo }),
      channel: channelRecording([]),
      mode: 'webhook',
      map: () => undefined,
    });
    expect('handleUpdate' in resource && resource.resource.id).toBe('hook');
  });
});
