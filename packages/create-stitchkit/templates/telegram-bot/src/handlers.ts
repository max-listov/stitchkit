import type { Bot } from 'grammy';
import type { TelegramOperatorChannel } from 'stitchkit/telegram';
import type { Store } from './database';

/** The command menu Telegram shows; published by `telegram-configuration`. */
export const COMMANDS = [
  { command: 'start', description: 'Start' },
  { command: 'users', description: 'How many people found this bot' },
];

export type OperatorTopic = 'users' | 'errors';

export interface Product {
  readonly store: () => Store;
  readonly operators?: TelegramOperatorChannel<OperatorTopic>;
}

/** The product. Everything else in this project is the assembly around it. */
export function registerHandlers(bot: Bot, product: Product): void {
  bot.command('start', async (ctx) => {
    if (!ctx.from) return;
    const isNew = product
      .store()
      .rememberUser({ id: ctx.from.id, firstName: ctx.from.first_name });
    if (isNew) product.operators?.post(`New user ${ctx.from.id}`, 'users');
    await ctx.reply(`Hello, ${ctx.from.first_name}!`);
  });

  bot.command('users', (ctx) => ctx.reply(`${product.store().userCount()} people so far.`));

  bot.on('message:text', (ctx) => ctx.reply(ctx.message.text));
}
