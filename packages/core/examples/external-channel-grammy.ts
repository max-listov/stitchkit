import type { Bot, Context } from 'grammy';
import {
  createGrammyWebhookResource,
  grammyPollingResource,
} from 'stitchkit/application/grammy';
import type { ExternalChannelHarness, ExternalIngress } from './external-channel-harness';

export function composeGrammyExternalChannel<C extends Context>(config: {
  id: string;
  bot: Bot<C>;
  channel: ExternalChannelHarness;
  map(context: C): ExternalIngress | undefined | Promise<ExternalIngress | undefined>;
  mode: 'webhook' | 'polling';
}) {
  config.bot.use(async (context, next) => {
    const ingress = await config.map(context);
    if (!ingress) return next();
    await config.channel.ingest(ingress);
  });
  return config.mode === 'webhook'
    ? createGrammyWebhookResource({ id: config.id, bot: config.bot })
    : grammyPollingResource({ id: config.id, bot: config.bot });
}
