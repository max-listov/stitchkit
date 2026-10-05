/**
 * What a load, an action or an input answers with.
 *
 * One value, built by chaining, read once by the runtime: where the chat goes
 * next and what it hears on the way. `void` from a handler is `stay()` — show
 * this screen again with fresh data — so a handler that only changes data
 * returns nothing and the screen follows.
 *
 * - `toast` answers the press itself: the small notification Telegram shows
 *   over the chat. One per press; the last one wins.
 * - `notice` without a lifetime is a receipt that stays in the chat: it is
 *   posted and the screen moves below it, so the conversation reads in order.
 * - `notice` with `expiresInMs` is a remark below the screen that removes
 *   itself; the screen stays where it is.
 */

import { MAX_TIMER_MS } from '../../internal/timers';
import type { ActionValue } from './callback-codec';
import type { TelegramText } from './html';
import type { AnyTelegramScreen, ScreenLinkArgs } from './screen-types';

export type ScreenNavigation =
  | { readonly type: 'stay' }
  | { readonly type: 'back' }
  | {
      readonly type: 'go';
      readonly screen: AnyTelegramScreen;
      readonly params: Readonly<Record<string, ActionValue>>;
    };

export interface ScreenToast {
  readonly text: string;
  /** Show it as an alert the user must dismiss, not a passing notification. */
  readonly alert: boolean;
}

export interface ScreenNotice {
  readonly content: TelegramText;
  /** Removed after this many milliseconds; absent, it stays. */
  readonly expiresInMs?: number;
}

export interface NoticeOptions {
  /** Removed after this many milliseconds, at most 2³¹ − 1 (a timer's limit); absent, it stays. */
  readonly expiresInMs?: number;
}

/** Telegram's limit for the text of a press answer. */
const TOAST_LIMIT = 200;

export class ScreenOutcome {
  // Nominal: data that happens to have these fields is still data.
  readonly #outcome = true;
  readonly navigation: ScreenNavigation;

  /** An outcome, told apart from data by its private brand rather than its shape. */
  static is(value: unknown): value is ScreenOutcome {
    return typeof value === 'object' && value !== null && #outcome in value;
  }
  readonly toastSpec: ScreenToast | undefined;
  readonly notices: readonly ScreenNotice[];

  constructor(
    navigation: ScreenNavigation = { type: 'stay' },
    toast: ScreenToast | undefined = undefined,
    notices: readonly ScreenNotice[] = [],
  ) {
    this.navigation = navigation;
    this.toastSpec = toast;
    this.notices = notices;
  }

  /** Show the current screen again, with fresh data. */
  stay(): ScreenOutcome {
    return new ScreenOutcome({ type: 'stay' }, this.toastSpec, this.notices);
  }

  /** Show another screen. */
  go<TScreen extends AnyTelegramScreen>(
    screen: TScreen,
    ...params: ScreenLinkArgs<TScreen>
  ): ScreenOutcome {
    const [values] = params;
    return new ScreenOutcome(
      { type: 'go', screen, params: values ?? {} },
      this.toastSpec,
      this.notices,
    );
  }

  /** Show the parent screen. */
  back(): ScreenOutcome {
    return new ScreenOutcome({ type: 'back' }, this.toastSpec, this.notices);
  }

  /** Answer the press with a notification (or an alert). */
  toast(text: string, options: { readonly alert?: boolean } = {}): ScreenOutcome {
    // Telegram counts characters, not UTF-16 units: an emoji is one.
    const length = [...text].length;
    if (length > TOAST_LIMIT) {
      throw new RangeError(
        `[stitchkit] telegram screens: a toast is at most ${TOAST_LIMIT} characters (got ${length}).`,
      );
    }
    return new ScreenOutcome(
      this.navigation,
      { text, alert: options.alert ?? false },
      this.notices,
    );
  }

  /** Post a message: a receipt that stays, or a remark that expires. */
  notice(content: TelegramText, options: NoticeOptions = {}): ScreenOutcome {
    const { expiresInMs } = options;
    if (
      expiresInMs !== undefined &&
      (!Number.isInteger(expiresInMs) || expiresInMs <= 0 || expiresInMs > MAX_TIMER_MS)
    ) {
      throw new RangeError(
        `[stitchkit] telegram screens: expiresInMs must be a positive integer up to ${MAX_TIMER_MS}.`,
      );
    }
    const notice: ScreenNotice =
      expiresInMs === undefined ? { content } : { content, expiresInMs };
    return new ScreenOutcome(this.navigation, this.toastSpec, [...this.notices, notice]);
  }
}

/** The builders every handler context carries; each starts a fresh outcome. */
export interface ScreenOutcomeBuilders {
  stay(): ScreenOutcome;
  go<TScreen extends AnyTelegramScreen>(
    screen: TScreen,
    ...params: ScreenLinkArgs<TScreen>
  ): ScreenOutcome;
  back(): ScreenOutcome;
  toast(text: string, options?: { readonly alert?: boolean }): ScreenOutcome;
  notice(content: TelegramText, options?: NoticeOptions): ScreenOutcome;
}

export function outcomeBuilders(): ScreenOutcomeBuilders {
  const start = new ScreenOutcome();
  return {
    stay: () => start.stay(),
    go: (screen, ...params) => start.go(screen, ...params),
    back: () => start.back(),
    toast: (text, options) => start.toast(text, options),
    notice: (content, options) => start.notice(content, options),
  };
}
