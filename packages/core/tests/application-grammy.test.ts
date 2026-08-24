import { describe, expect, test } from 'bun:test';
import {
  Bot,
  type BotConfig,
  type Context,
  type PollingOptions,
  type WebhookReplyEnvelope,
} from 'grammy';
import {
  createGrammyWebhookResource,
  type GrammyUpdate,
  GrammyWebhookUnavailableError,
  grammyPollingResource,
} from '../src/application/grammy';
import { createApplication } from '../src/application/kernel';

const botInfo: NonNullable<BotConfig<Context>['botInfo']> = {
  id: 1,
  is_bot: true,
  first_name: 'Managed test bot',
  username: 'managed_test_bot',
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

class ControlledBot extends Bot<Context> {
  pollingOptions?: PollingOptions;
  startCalls = 0;
  stopCalls = 0;
  initCalls = 0;
  updateCalls = 0;
  private resolvePolling: () => void = () => undefined;
  private rejectPolling: (error: unknown) => void = () => undefined;
  private updateBarrier: Promise<void> = Promise.resolve();
  private updateFailure: unknown;
  private stopFailure: unknown;
  private deferPollingCompletion = false;

  constructor() {
    super('test-token', { botInfo });
  }

  override init(): Promise<void> {
    this.initCalls += 1;
    return Promise.resolve();
  }

  override start(options?: PollingOptions): Promise<void> {
    this.startCalls += 1;
    this.pollingOptions = options;
    return new Promise<void>((resolve, reject) => {
      this.resolvePolling = resolve;
      this.rejectPolling = reject;
    });
  }

  ready(): Promise<void> {
    return Promise.resolve(this.pollingOptions?.onStart?.(botInfo));
  }

  crash(error: unknown): void {
    this.rejectPolling(error);
  }

  override stop(): Promise<void> {
    this.stopCalls += 1;
    if (this.stopFailure !== undefined) return Promise.reject(this.stopFailure);
    if (!this.deferPollingCompletion) this.resolvePolling();
    return Promise.resolve();
  }

  failStop(error: unknown): void {
    this.stopFailure = error;
  }

  holdPollingCompletion(): void {
    this.deferPollingCompletion = true;
  }

  finishPolling(): void {
    this.resolvePolling();
  }

  holdUpdates(barrier: Promise<void>): void {
    this.updateBarrier = barrier;
  }

  failUpdates(error: unknown): void {
    this.updateFailure = error;
  }

  override async handleUpdate(
    _update: GrammyUpdate<Context>,
    _webhookReplyEnvelope?: WebhookReplyEnvelope,
  ): Promise<void> {
    this.updateCalls += 1;
    await this.updateBarrier;
    if (this.updateFailure !== undefined) throw this.updateFailure;
  }
}

describe('grammY application adapters', () => {
  test('polling readiness comes from onStart and shutdown awaits the retained completion', async () => {
    const bot = new ControlledBot();
    const app = createApplication({
      id: 'polling',
      resources: [grammyPollingResource({ id: 'telegram', bot })],
    });
    const starting = app.start();
    await Promise.resolve();
    expect(bot.startCalls).toBe(1);
    expect(app.getSnapshot().ready).toBe(false);
    await bot.ready();
    await starting;
    expect(app.getSnapshot().ready).toBe(true);

    const result = await app.shutdown();
    expect(result.outcome).toBe('clean');
    expect(bot.stopCalls).toBe(1);
  });

  test('polling rejection after readiness is observed and removes application readiness', async () => {
    const bot = new ControlledBot();
    const errors: unknown[] = [];
    const app = createApplication({
      id: 'polling-crash',
      resources: [
        grammyPollingResource({
          id: 'telegram',
          bot,
          onError: (error) => void errors.push(error),
        }),
      ],
    });
    const starting = app.start();
    await Promise.resolve();
    await bot.ready();
    await starting;
    const failure = new Error('polling failed');
    bot.crash(failure);
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).toEqual([failure]);
    expect(app.getSnapshot()).toMatchObject({ ready: false, health: 'unhealthy' });
    await app.shutdown();
  });

  test('polling rejection before readiness rolls back through one bot stop', async () => {
    const bot = new ControlledBot();
    const app = createApplication({
      id: 'polling-before-ready',
      resources: [grammyPollingResource({ id: 'telegram', bot })],
    });
    const starting = app.start();
    await Promise.resolve();
    bot.crash(new Error('polling failed before ready'));

    await expect(starting).rejects.toThrow('polling failed before ready');
    expect(bot.stopCalls).toBe(1);
    await app.shutdown();
    expect(bot.stopCalls).toBe(1);
  });

  test('isolates a throwing polling error observer and reports failed stop truthfully', async () => {
    const bot = new ControlledBot();
    bot.failStop(new Error('stop failed'));
    let observerCalls = 0;
    const app = createApplication({
      id: 'polling-stop-failure',
      resources: [
        grammyPollingResource({
          id: 'telegram',
          bot,
          onError() {
            observerCalls += 1;
            throw new Error('observer failed');
          },
        }),
      ],
    });
    const starting = app.start();
    await Promise.resolve();
    await bot.ready();
    await starting;

    await expect(app.shutdown({ forceTimeoutMs: 20 })).resolves.toMatchObject({
      outcome: 'forced',
      cleanupComplete: false,
    });
    await Promise.resolve();
    expect(observerCalls).toBeGreaterThan(0);
    expect(bot.stopCalls).toBe(1);
  });

  test('shutdown during polling initialization bounds shutdown and settles start', async () => {
    const bot = new ControlledBot();
    const app = createApplication({
      id: 'polling-init-stop',
      resources: [grammyPollingResource({ id: 'telegram', bot })],
    });
    const starting = app.start();
    await Promise.resolve();
    const result = await app.shutdown({ gracePeriodMs: 1, forceTimeoutMs: 20 });
    expect(result.outcome).toBe('forced');
    await expect(starting).rejects.toThrow('stopped before reaching readiness');
    expect(bot.stopCalls).toBe(1);
  });

  test('uses the force budget for retained polling completion after bot stop', async () => {
    const bot = new ControlledBot();
    bot.holdPollingCompletion();
    const app = createApplication({
      id: 'polling-force-completion',
      resources: [grammyPollingResource({ id: 'telegram', bot })],
    });
    const starting = app.start();
    await Promise.resolve();
    await bot.ready();
    await starting;

    const shuttingDown = app.shutdown({ gracePeriodMs: 1, forceTimeoutMs: 100 });
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    expect(bot.stopCalls).toBe(1);
    bot.finishPolling();
    await expect(shuttingDown).resolves.toMatchObject({
      outcome: 'forced',
      cleanupComplete: true,
    });
    expect(bot.stopCalls).toBe(1);
  });

  test('webhook admission drains an accepted update and rejects later updates', async () => {
    const bot = new ControlledBot();
    let releaseUpdate: () => void = () => undefined;
    const barrier = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    bot.holdUpdates(barrier);
    const webhook = createGrammyWebhookResource({ id: 'telegram-webhook', bot });
    const app = createApplication({ id: 'webhook', resources: [webhook.resource] });
    await app.start();
    expect(bot.initCalls).toBe(1);

    const accepted = webhook.handleUpdate({ update_id: 1 });
    await Promise.resolve();
    const shuttingDown = app.shutdown();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await expect(webhook.handleUpdate({ update_id: 2 })).rejects.toBeInstanceOf(
      GrammyWebhookUnavailableError,
    );
    expect(bot.updateCalls).toBe(1);
    releaseUpdate();
    await accepted;
    await shuttingDown;
  });

  test('preserves the original webhook error when a synchronous error observer throws', async () => {
    const bot = new ControlledBot();
    const failure = new Error('handler failed');
    bot.failUpdates(failure);
    const webhook = createGrammyWebhookResource({
      id: 'telegram-webhook',
      bot,
      onError() {
        throw new Error('observer failed');
      },
    });
    const app = createApplication({ id: 'webhook-error', resources: [webhook.resource] });
    await app.start();

    await expect(webhook.handleUpdate({ update_id: 1 })).rejects.toBe(failure);
    await expect(app.shutdown()).resolves.toMatchObject({ cleanupComplete: true });
  });

  test('uses the force budget for accepted webhook middleware that settles after abort', async () => {
    const bot = new ControlledBot();
    let releaseUpdate: () => void = () => undefined;
    const barrier = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    bot.holdUpdates(barrier);
    const webhook = createGrammyWebhookResource({ id: 'telegram-webhook', bot });
    const app = createApplication({ id: 'webhook-force', resources: [webhook.resource] });
    await app.start();
    const accepted = webhook.handleUpdate({ update_id: 1 });
    await Promise.resolve();

    const shuttingDown = app.shutdown({ gracePeriodMs: 1, forceTimeoutMs: 100 });
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    releaseUpdate();
    await accepted;
    await expect(shuttingDown).resolves.toMatchObject({
      outcome: 'forced',
      cleanupComplete: true,
    });
  });
});
