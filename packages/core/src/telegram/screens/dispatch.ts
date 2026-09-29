/**
 * The three ways a chat reaches a screen: a press, a message, an open.
 *
 * A press is trusted only as far as Telegram vouches for it. Telegram sends
 * the pressed message along with its keyboard, and a `callback_data` that is
 * not on that keyboard was not pressed — it was sent (MTProto lets a client
 * send any bytes) — so it never reaches a handler. What remains is still user
 * input: params go through the screen's schema and every load above it before
 * an action runs.
 */
import type { Context } from 'grammy';
import type { MaybeInaccessibleMessage, Message } from 'grammy/types';
import { classifyTelegramEditRefusal } from '../send-failure';
import { type ActionValue, decodeInput, decodeParams, parseCallback } from './callback-codec';
import {
  type DisplayBase,
  type ScreenOrigin,
  type SettledNavigation,
  sendText,
  settleNavigation,
  sweepDue,
} from './display';
import { deleteMessages } from './execute';
import type { TelegramText } from './html';
import { outcomeBuilders, ScreenOutcome } from './outcome';
import type { ShownMessage } from './reconcile';
import type { RenderedKind } from './render';
import type { ScreenStaleReason, ScreensRuntime, ScreenTrigger } from './runtime';
import type { ScreenInputKind } from './screen-types';
import type { ScreenChatState } from './state';

type Press = {
  readonly id: string;
  readonly data: string;
  readonly message: MaybeInaccessibleMessage;
};

function onKeyboard(message: MaybeInaccessibleMessage, data: string): boolean {
  if (message.date === 0 || !('reply_markup' in message)) return false;
  return (message.reply_markup?.inline_keyboard ?? []).some((row) =>
    row.some((button) => 'callback_data' in button && button.callback_data === data),
  );
}

function kindOfMessage(message: MaybeInaccessibleMessage): RenderedKind {
  if (message.date === 0) return 'text';
  if ('photo' in message && message.photo) return 'photo';
  if ('video' in message && message.video) return 'video';
  if ('animation' in message && message.animation) return 'animation';
  if ('audio' in message && message.audio) return 'audio';
  if ('document' in message && message.document) return 'document';
  if ('rich_message' in message && message.rich_message) return 'rich';
  return 'text';
}

/** The input kind of a message, for `.on(...)`; animations also carry `document`. */
export function inputKindOf(message: Message): ScreenInputKind | undefined {
  if (message.text !== undefined) return 'text';
  if (message.rich_message) return 'rich';
  if (message.photo) return 'photo';
  if (message.animation) return 'animation';
  if (message.video) return 'video';
  if (message.video_note) return 'video_note';
  if (message.voice) return 'voice';
  if (message.audio) return 'audio';
  if (message.document) return 'document';
  if (message.sticker) return 'sticker';
  if (message.location) return 'location';
  if (message.contact) return 'contact';
  return undefined;
}

function isCommand(message: Message): boolean {
  const first = message.entities?.[0];
  return first?.type === 'bot_command' && first.offset === 0;
}

function originOf<C extends Context>(
  runtime: ScreensRuntime<C>,
  state: ScreenChatState,
): ScreenOrigin<C> | undefined {
  const view = state.view;
  const entry = view ? runtime.registry.byId(view.screen) : undefined;
  return view && entry ? { entry, params: view.params } : undefined;
}

type Decoded<C extends Context> =
  | {
      readonly entry: NonNullable<ReturnType<ScreensRuntime<C>['registry']['byId']>>;
      readonly params: Readonly<Record<string, ActionValue>>;
      readonly action: string | undefined;
      readonly input: Readonly<Record<string, ActionValue>> | undefined;
      readonly detached: boolean;
    }
  | ScreenStaleReason;

function decodePress<C extends Context>(
  runtime: ScreensRuntime<C>,
  press: Press,
  state: ScreenChatState,
): Decoded<C> {
  if (press.message.date === 0) return 'inaccessible';
  if (!onKeyboard(press.message, press.data)) return 'forged';
  let parsed = parseCallback(press.data.slice(runtime.prefix.length));
  if (parsed?.kind === 'token') {
    const body = state.view?.tokens[parsed.token];
    if (body === undefined) return 'unknown-token';
    parsed = parseCallback(body);
    if (parsed?.kind === 'token') return 'malformed';
  }
  if (!parsed) return 'malformed';
  const entry = runtime.registry.byId(parsed.screen);
  if (!entry) return 'unknown-screen';
  const names = entry.definition.path.params;
  const values = decodeParams(parsed.segments.slice(0, names.length));
  if (!values || values.length !== names.length) return 'invalid-params';
  const rest = parsed.segments.slice(names.length);
  const input = parsed.action === undefined ? undefined : decodeInput(rest);
  if (parsed.action === undefined ? rest.length > 0 : input === null) return 'invalid-input';
  const params: Record<string, ActionValue> = {};
  for (const [index, name] of names.entries()) params[name] = values[index] ?? null;
  return {
    entry,
    params,
    action: parsed.action,
    input: input ?? undefined,
    detached: parsed.detached,
  };
}

async function staleOutcome<C extends Context>(
  runtime: ScreensRuntime<C>,
  ctx: C,
  reason: ScreenStaleReason,
): Promise<ScreenOutcome | undefined> {
  const result = await runtime.config.onStale?.({ ctx, reason, ...outcomeBuilders() });
  return ScreenOutcome.is(result) ? result : undefined;
}

/** What a press leads to: the screen it names, the outcome of its action, or a stale answer. */
async function settlePress<C extends Context>(
  runtime: ScreensRuntime<C>,
  ctx: C,
  press: Press,
  state: ScreenChatState,
): Promise<{ settled: SettledNavigation<C>; detached: boolean; navigated: boolean }> {
  const origin = originOf(runtime, state);
  const decoded = decodePress(runtime, press, state);
  const stale = async (reason: ScreenStaleReason) => {
    const outcome = await staleOutcome(runtime, ctx, reason);
    return {
      settled: outcome
        ? await settleNavigation(runtime, ctx, origin, outcome)
        : { target: undefined, toast: undefined, notices: [] },
      detached: false,
      navigated: false,
    };
  };
  if (typeof decoded === 'string') return stale(decoded);
  const { entry, params, action, input, detached } = decoded;
  const resolved = await entry.definition.resolve(ctx, params);
  if (resolved === 'invalid-params') return stale('invalid-params');
  const here: ScreenOrigin<C> = { entry, params };
  if (ScreenOutcome.is(resolved)) {
    return {
      settled: await settleNavigation(runtime, ctx, here, resolved),
      detached,
      navigated: true,
    };
  }
  if (action === undefined) {
    return {
      settled: { target: { entry, resolved }, toast: undefined, notices: [] },
      detached,
      navigated: true,
    };
  }
  const result = await resolved.runAction(action, input);
  if (typeof result === 'string') return stale(result);
  const settled = await settleNavigation(
    runtime,
    ctx,
    { entry, params: resolved.params },
    result ?? new ScreenOutcome(),
  );
  return { settled, detached, navigated: navigates(result) };
}

function navigates(outcome: ScreenOutcome | undefined): boolean {
  return outcome !== undefined && outcome.navigation.type !== 'stay';
}

/**
 * A handler that called `open` has shown its screen; drawing its own outcome
 * over it would put the chat's record back on the screen it left. What it may
 * still say is a toast — the answer to the press.
 */
function assertOpenStands(navigated: boolean, settled: SettledNavigation<Context>): void {
  if (navigated || settled.notices.length > 0) {
    throw new Error(
      '[stitchkit] telegram screens: a handler that calls open() shows that screen; return nothing or a toast.',
    );
  }
}

/** Run one chat operation; a thrown error goes to `onError`, whose outcome is shown. */
async function guarded<C extends Context>(
  runtime: ScreensRuntime<C>,
  ctx: C,
  trigger: ScreenTrigger,
  chat: string,
  chatId: number,
  operation: () => Promise<void>,
  answer?: (settled: SettledNavigation<C> | undefined) => Promise<void>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    const onError = runtime.config.onError;
    if (!onError) throw error;
    const result = await onError(error, { ctx, trigger, ...outcomeBuilders() });
    if (!ScreenOutcome.is(result)) return;
    const state = await runtime.readState(chat);
    const settled = await settleNavigation(runtime, ctx, originOf(runtime, state), result);
    await answer?.(settled);
    await runtime.display({
      ctx,
      chat,
      chatId,
      state,
      settled,
      base: { mode: 'state' },
      trigger,
      started: runtime.clock(),
    });
  }
}

export async function dispatchPress<C extends Context>(
  runtime: ScreensRuntime<C>,
  ctx: C,
): Promise<void> {
  const query = ctx.callbackQuery;
  const message = query?.message;
  if (!query?.data || !message) return;
  const chat = runtime.chatKey(ctx);
  if (chat === undefined) {
    // A chat the application keeps no record for: the press is answered, not left spinning.
    await ctx.api.answerCallbackQuery(query.id);
    return;
  }
  const press: Press = { id: query.id, data: query.data, message };
  const chatId = message.chat.id;
  let answered = false;
  const answer = async (settled: SettledNavigation<C> | undefined): Promise<void> => {
    if (answered) return;
    answered = true;
    const toast = settled?.toast;
    try {
      await ctx.api.answerCallbackQuery(
        press.id,
        toast ? { text: toast.text, show_alert: toast.alert } : undefined,
      );
    } catch (error) {
      // A press answered after Telegram stopped waiting is not a failure of the screen.
      if (classifyTelegramEditRefusal(error) !== 'query-expired') throw error;
    }
  };
  try {
    await runtime.exclusive(ctx, chat, () =>
      guarded(
        runtime,
        ctx,
        'press',
        chat,
        chatId,
        async () => {
          const started = runtime.clock();
          const state = await sweepDue(runtime, ctx.api, chat, chatId);
          const { settled, detached, navigated } = await settlePress(
            runtime,
            ctx,
            press,
            state,
          );
          if (runtime.openedDuring(ctx)) {
            assertOpenStands(navigated, settled);
            await answer(settled);
            return;
          }
          await answer(settled);
          const known =
            state.view?.messages.some((shown) => shown.id === message.message_id) ?? false;
          const pressed: ShownMessage = {
            key: `pressed-${message.message_id}`,
            id: message.message_id,
            kind: kindOfMessage(message),
            fingerprint: null,
          };
          const base: DisplayBase = detached
            ? { mode: 'new' }
            : known
              ? { mode: 'state' }
              : { mode: 'foreign', message: pressed };
          await runtime.display({
            ctx,
            chat,
            chatId,
            state,
            settled,
            base,
            trigger: 'press',
            started,
          });
        },
        answer,
      ),
    );
  } finally {
    await answer(undefined);
  }
}

/** Whether the message was taken as input; `false` hands it to the next handler. */
export async function dispatchInput<C extends Context>(
  runtime: ScreensRuntime<C>,
  ctx: C,
  message: Message,
): Promise<boolean> {
  const chat = runtime.chatKey(ctx);
  const kind = inputKindOf(message);
  if (chat === undefined || kind === undefined || isCommand(message)) return false;
  const chatId = message.chat.id;
  return runtime.exclusive(ctx, chat, async () => {
    // Until the record says otherwise the message is the screens': a storage
    // that cannot answer fails the update instead of passing a reply meant for
    // a screen on to whatever handles text next.
    let taken = true;
    await guarded(runtime, ctx, 'input', chat, chatId, async () => {
      const started = runtime.clock();
      const state = await sweepDue(runtime, ctx.api, chat, chatId);
      const origin = originOf(runtime, state);
      const definition = origin?.entry.definition;
      if (
        !origin ||
        !definition?.inputKinds.includes(kind) ||
        !definition.acceptsParams(origin.params)
      ) {
        taken = false;
        return;
      }
      if (!definition.keepsInput(kind)) {
        // Before any load or handler, whatever they do: input can be a secret.
        const kept = await deleteMessages(ctx.api, chatId, [message.message_id]);
        if (kept.length > 0) runtime.emit({ type: 'message-kept', chat, messageIds: kept });
      }
      const resolved = await definition.resolve(ctx, origin.params);
      if (resolved === 'invalid-params') {
        throw new Error(
          `[stitchkit] telegram screens: "${definition.path.path}" refused params it accepted a moment ago.`,
        );
      }
      const display = (settled: SettledNavigation<C>, base: DisplayBase) =>
        runtime.display({
          ctx,
          chat,
          chatId,
          state,
          settled,
          base,
          trigger: 'input',
          started,
        });
      if (ScreenOutcome.is(resolved)) {
        await display(await settleNavigation(runtime, ctx, origin, resolved), {
          mode: 'state',
        });
        return;
      }
      const input = resolved.input(kind);
      if (!input) {
        throw new Error(
          `[stitchkit] telegram screens: "${definition.path.path}" declared "${kind}" input it does not take.`,
        );
      }
      const pending: number[] = [];
      let outcome: ScreenOutcome | undefined;
      try {
        outcome = await input.handle(message, async (content: TelegramText) => {
          pending.push(await sendText(ctx.api, chatId, content));
        });
      } finally {
        if (pending.length > 0) await deleteMessages(ctx.api, chatId, pending);
      }
      const settled = await settleNavigation(
        runtime,
        ctx,
        { entry: origin.entry, params: resolved.params },
        outcome ?? new ScreenOutcome(),
      );
      if (runtime.openedDuring(ctx)) {
        assertOpenStands(navigates(outcome), settled);
        return;
      }
      await display(
        { ...settled, toast: undefined },
        input.keepMessage ? { mode: 'fresh' } : { mode: 'state' },
      );
    });
    return taken;
  });
}

export async function openScreen<C extends Context>(
  runtime: ScreensRuntime<C>,
  ctx: C,
  origin: ScreenOrigin<C>,
  previous: 'keep' | 'delete',
): Promise<void> {
  const chat = runtime.chatKey(ctx);
  const chatId = ctx.chat?.id;
  if (chat === undefined || chatId === undefined) {
    throw new Error('[stitchkit] telegram screens: open() needs an update from a chat.');
  }
  await runtime.exclusive(ctx, chat, () =>
    guarded(runtime, ctx, 'open', chat, chatId, async () => {
      const started = runtime.clock();
      const state = await sweepDue(runtime, ctx.api, chat, chatId);
      const outcome = new ScreenOutcome({
        type: 'go',
        screen: origin.entry.screen,
        params: origin.params,
      });
      const settled = await settleNavigation(runtime, ctx, undefined, outcome);
      const base: DisplayBase = previous === 'delete' ? { mode: 'fresh' } : { mode: 'new' };
      await runtime.display({
        ctx,
        chat,
        chatId,
        state,
        settled: { ...settled, toast: undefined },
        base,
        trigger: 'open',
        started,
      });
      runtime.markOpened(ctx);
    }),
  );
}
