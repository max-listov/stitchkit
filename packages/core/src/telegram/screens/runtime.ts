/**
 * The screens of one bot, as grammY middleware.
 *
 * `bot.use(screens)` takes the presses whose `callback_data` carries this
 * runtime's prefix and the messages a shown screen takes as input; every other
 * update goes to the next handler untouched, and it is handed on outside the
 * chat's queue. `screens.open(ctx, screen)` shows a screen from a command or a
 * deep link; `screens.button(link(…))` puts a link to a screen into a message
 * the screens do not own — a notification.
 *
 * Every chat is handled one update at a time: read the chat's record, resolve
 * the screen, render, reconcile against what the chat shows, carry the plan
 * out, write the record. The record is written after Telegram has answered, so
 * it never names a message that was not sent; a crash in between leaves the
 * chat ahead of its record, and the next press is handled as a press on a
 * message the record does not know. Two processes serving one chat — builds
 * overlapping during a release, a webhook fan-out — are not serialised: the
 * last write wins.
 */
import type { Context, MiddlewareFn, MiddlewareObj } from 'grammy';
import type { InlineKeyboardButton } from 'grammy/types';
import { type DisplayRequest, displayScreen, sweepDue } from './display';
import type { ExecutionReport, ScreenApi } from './execute';
import type { ScreenOutcomeBuilders } from './outcome';
import { createScreenRegistry, type DeclaredScreen, type ScreenRegistry } from './registry';
import type { AnyTelegramScreen, ScreenHandlerResult, ScreenLinkArgs } from './screen-types';
import {
  type ChatQueue,
  createChatQueue,
  readChatState,
  type ScreenChatState,
  type TelegramScreenStorage,
} from './state';
import type { ScreenButton } from './view';

/** Why a press could not be answered by the screen it names. */
export type ScreenStaleReason =
  | 'malformed'
  | 'forged'
  | 'inaccessible'
  | 'unknown-token'
  | 'unknown-screen'
  | 'invalid-params'
  | 'unknown-action'
  | 'invalid-input';

export type ScreenTrigger = 'open' | 'press' | 'input';

export interface ScreenStaleContext<C extends Context> extends ScreenOutcomeBuilders {
  readonly ctx: C;
  readonly reason: ScreenStaleReason;
}

export interface ScreenErrorContext<C extends Context> extends ScreenOutcomeBuilders {
  readonly ctx: C;
  readonly trigger: ScreenTrigger;
}

/**
 * What happened, for the application's journal. Never carries message text:
 * screens are named by their path template, messages by id.
 */
export type ScreenEvent =
  | {
      readonly type: 'transition';
      readonly trigger: ScreenTrigger;
      readonly chat: string;
      /** The screen shown before, as its path template; absent when none was. */
      readonly from: string | undefined;
      readonly to: string;
      readonly durationMs: number;
      readonly report: ExecutionReport;
    }
  /** A stored record did not match this release's schema and was set aside. */
  | { readonly type: 'state-discarded'; readonly chat: string }
  /** Messages Telegram would not delete — an expired remark, the user's input. */
  | {
      readonly type: 'message-kept';
      readonly chat: string;
      readonly messageIds: readonly number[];
    }
  /**
   * Deleting expired remarks on their timer failed — no update was there to
   * carry the error. The chat's next update sweeps them again.
   */
  | { readonly type: 'sweep-failed'; readonly chat: string; readonly error: unknown };

export interface TelegramScreensConfig<C extends Context> {
  readonly screens: readonly DeclaredScreen<C>[];
  /** Where each chat's screen survives a restart — any grammY `StorageAdapter`. */
  readonly storage: TelegramScreenStorage;
  /** The storage key of a chat's record. Default: `screens:<chat id>`, apart from grammY sessions. */
  readonly chatKey?: (ctx: C) => string | undefined;
  /** What every screen button's `callback_data` starts with. Default `"~"`. */
  readonly callbackPrefix?: string;
  /** Which chats screens answer in. Default `'private'`: in a group any member could press or type. */
  readonly chats?: 'private' | 'all';
  /** A press this bot no longer understands, or that no button carried. Default: answered silently. */
  readonly onStale?: (c: ScreenStaleContext<C>) => ScreenHandlerResult;
  /**
   * A load, action or input that threw. Its outcome is shown instead; without
   * it the press is answered silently and the error reaches `bot.catch`.
   */
  readonly onError?: (error: unknown, c: ScreenErrorContext<C>) => ScreenHandlerResult;
  readonly onEvent?: (event: ScreenEvent) => void;
  /** Epoch milliseconds, for expiring notices. Default `Date.now`. */
  readonly clock?: () => number;
}

export interface OpenOptions {
  /** The view the chat showed: kept as it is (default) or deleted. */
  readonly previous?: 'keep' | 'delete';
}

export type OpenArgs<TScreen> =
  ScreenLinkArgs<TScreen> extends [params: infer P]
    ? [params: P, options?: OpenOptions]
    : ScreenLinkArgs<TScreen> extends [params?: infer P]
      ? [params?: P, options?: OpenOptions]
      : never;

export interface TelegramScreens<C extends Context> extends MiddlewareObj<C> {
  middleware(): MiddlewareFn<C>;
  /** Show a screen as a new message at the bottom of the chat. */
  open<TScreen extends AnyTelegramScreen>(
    ctx: C,
    screen: TScreen,
    ...args: OpenArgs<TScreen>
  ): Promise<void>;
  /** A link for a message the screens do not own; pressing it opens the screen below. */
  button(link: ScreenButton): InlineKeyboardButton.CallbackButton;
  /** Cancel pending expiry timers; remarks left behind are swept on the chat's next update. */
  close(): void;
}

/** Updates a single chat may have waiting before the next is refused. */
const MAX_PENDING_PER_CHAT = 16;

/** What dispatch and display share for one bot. */
export interface ScreensRuntime<C extends Context> {
  readonly registry: ScreenRegistry<C>;
  readonly config: TelegramScreensConfig<C>;
  readonly prefix: string;
  readonly clock: () => number;
  chatKey(ctx: C): string | undefined;
  answers(ctx: C): boolean;
  /** Run `task` alone in the chat; a call from inside the chat's own task runs inline. */
  exclusive<T>(ctx: C, chat: string, task: () => Promise<T>): Promise<T>;
  readState(chat: string): Promise<ScreenChatState>;
  display(request: DisplayRequest<C>): Promise<void>;
  /** `open` showed a screen for this update. */
  markOpened(ctx: C): void;
  /** Whether `open` showed a screen for this update — from inside its handler, its navigation stands. */
  openedDuring(ctx: C): boolean;
  scheduleSweep(api: ScreenApi, chat: string, chatId: number, delayMs: number): void;
  emit(event: ScreenEvent): void;
}

export interface OwnedScreensRuntime<C extends Context> extends ScreensRuntime<C> {
  /** Expiry timers not yet fired, so `close()` can cancel them. */
  readonly timers: Set<ReturnType<typeof setTimeout>>;
}

export function createScreensRuntime<C extends Context>(
  config: TelegramScreensConfig<C>,
): OwnedScreensRuntime<C> {
  const prefix = config.callbackPrefix ?? '~';
  if (prefix.length === 0 || /[#!]/.test(prefix)) {
    throw new Error(
      '[stitchkit] telegram screens: callbackPrefix must be non-empty and free of "#" and "!".',
    );
  }
  const queue: ChatQueue = createChatQueue(MAX_PENDING_PER_CHAT);
  const inside = new WeakSet<object>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const opened = new WeakSet<object>();
  const runtime: OwnedScreensRuntime<C> = {
    registry: createScreenRegistry(config.screens),
    config,
    prefix,
    clock: config.clock ?? Date.now,
    timers,
    chatKey: (ctx) =>
      config.chatKey ? config.chatKey(ctx) : ctx.chat ? `screens:${ctx.chat.id}` : undefined,
    answers: (ctx) => (config.chats ?? 'private') === 'all' || ctx.chat?.type === 'private',
    exclusive: async (ctx, chat, task) => {
      if (inside.has(ctx)) return task();
      return queue(chat, async () => {
        inside.add(ctx);
        try {
          return await task();
        } finally {
          inside.delete(ctx);
        }
      });
    },
    readState: async (chat) => {
      const read = await readChatState(config.storage, chat);
      if (read.discarded) runtime.emit({ type: 'state-discarded', chat });
      return read.state;
    },
    display: (request) => displayScreen(runtime, request),
    markOpened: (ctx) => {
      opened.add(ctx);
    },
    openedDuring: (ctx) => opened.has(ctx),
    scheduleSweep: (api, chat, chatId, delayMs) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        void queue(chat, () => sweepDue(runtime, api, chat, chatId)).catch((error: unknown) =>
          runtime.emit({ type: 'sweep-failed', chat, error }),
        );
      }, delayMs);
      timers.add(timer);
      // A remark left behind by a stopped process is swept on the chat's next update.
      if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    },
    emit: (event) => config.onEvent?.(event),
  };
  return runtime;
}
