/**
 * `telegramScreens<Ctx>()` — where a bot's screens are declared and composed.
 *
 * The bot's grammY context type is named once; every screen, group and handler
 * declared from here sees it. `create` checks the declaration as a whole — ids,
 * paths, that every screen with params has a load above it — and returns the
 * middleware.
 */
import type { Context } from 'grammy';
import { isRecord } from '../../internal/typed';
import type { ActionValue } from './callback-codec';
import { dispatchInput, dispatchPress, openScreen } from './dispatch';
import { renderDetachedButton } from './render';
import {
  createScreensRuntime,
  type TelegramScreens,
  type TelegramScreensConfig,
} from './runtime';
import { rootScopeCore, ScreenScope } from './screen';

export class TelegramScreensRoot<C extends Context> extends ScreenScope<
  C,
  Record<never, never>,
  undefined
> {
  /** Compose the declared screens into grammY middleware. */
  create(config: TelegramScreensConfig<C>): TelegramScreens<C> {
    return createTelegramScreens(config);
  }
}

/** Declare a bot's screens against its grammY context type. */
export function telegramScreens<C extends Context>(): TelegramScreensRoot<C> {
  return new TelegramScreensRoot(rootScopeCore<C>());
}

/** Params handed to `open`, checked to be what a button can carry. */
function linkParams(value: unknown): Readonly<Record<string, ActionValue>> {
  const params: Record<string, ActionValue> = {};
  if (value === undefined) return params;
  if (!isRecord(value))
    throw new TypeError('[stitchkit] telegram screens: params must be an object.');
  for (const [name, field] of Object.entries(value)) {
    if (typeof field !== 'string' && typeof field !== 'number') {
      throw new TypeError(
        `[stitchkit] telegram screens: param "${name}" must be a string or a number.`,
      );
    }
    params[name] = field;
  }
  return params;
}

function createTelegramScreens<C extends Context>(
  config: TelegramScreensConfig<C>,
): TelegramScreens<C> {
  const runtime = createScreensRuntime(config);
  const middleware = (): ReturnType<TelegramScreens<C>['middleware']> => async (ctx, next) => {
    if (!runtime.answers(ctx)) return next();
    const data = ctx.callbackQuery?.data;
    if (data !== undefined) {
      if (!data.startsWith(runtime.prefix) || !ctx.callbackQuery?.message) return next();
      return dispatchPress(runtime, ctx);
    }
    const message = ctx.message;
    if (message && (await dispatchInput(runtime, ctx, message))) return;
    return next();
  };
  return {
    middleware,
    open: async (ctx, screen, ...args) => {
      const [params, options] = args;
      const entry = runtime.registry.entryOf(screen);
      await openScreen(
        runtime,
        ctx,
        { entry, params: linkParams(params) },
        options?.previous ?? 'keep',
      );
    },
    button: (link) =>
      renderDetachedButton(link, runtime.prefix, (screen) => {
        const target = runtime.registry.entryOf(screen).definition;
        return { id: target.id, params: target.path.params };
      }),
    close: () => {
      for (const timer of runtime.timers) clearTimeout(timer);
      runtime.timers.clear();
    },
  };
}
