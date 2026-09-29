/**
 * From an outcome to the chat: which screen, then what the chat shows.
 *
 * `settleNavigation` follows an outcome to the screen it names — resolving it,
 * and following again when that screen's load answers with an outcome of its
 * own — collecting the toast and notices met on the way. `displayScreen`
 * renders the settled screen, reconciles it with what the chat shows, carries
 * the plan out and writes the chat's record — also when Telegram refused a
 * call halfway, so the record never claims less or more than the chat shows.
 */
import type { Context } from 'grammy';
import type { ActionValue } from './callback-codec';
import {
  deleteMessages,
  type ExecutionReport,
  executePlan,
  PlanInterrupted,
  type ScreenApi,
} from './execute';
import type { TelegramText } from './html';
import type { ScreenNotice, ScreenOutcome, ScreenToast } from './outcome';
import { planView, type ShownMessage, type ViewPlan } from './reconcile';
import type { RegisteredScreen } from './registry';
import { htmlOf, renderView } from './render';
import type { ScreensRuntime, ScreenTrigger } from './runtime';
import type { ResolvedScreen } from './screen-types';
import {
  RECORD_LIMITS,
  type ScreenChatState,
  type ScreenViewState,
  writeChatState,
} from './state';

/** Where a chat is, as far as navigation is concerned. */
export interface ScreenOrigin<C extends Context> {
  readonly entry: RegisteredScreen<C>;
  /** As a button or the record carries them; the screen's schema parses them on resolution. */
  readonly params: Readonly<Record<string, ActionValue>>;
}

export interface SettledNavigation<C extends Context> {
  /** Absent when the outcome leads nowhere — a stay with no screen to stay on. */
  readonly target:
    | { readonly entry: RegisteredScreen<C>; readonly resolved: ResolvedScreen }
    | undefined;
  readonly toast: ScreenToast | undefined;
  readonly notices: readonly ScreenNotice[];
}

/** Redirects a chain of loads may take before it is a loop. */
const MAX_REDIRECTS = 4;

function paramsFor<C extends Context>(
  entry: RegisteredScreen<C>,
  params: Readonly<Record<string, ActionValue>>,
): Readonly<Record<string, ActionValue>> {
  const values: Record<string, ActionValue> = {};
  for (const name of entry.definition.path.params) {
    const value = params[name];
    if (value !== undefined) values[name] = value;
  }
  return values;
}

export async function settleNavigation<C extends Context>(
  runtime: ScreensRuntime<C>,
  ctx: C,
  origin: ScreenOrigin<C> | undefined,
  outcome: ScreenOutcome,
): Promise<SettledNavigation<C>> {
  let toast = outcome.toastSpec;
  const notices = [...outcome.notices];
  let from = origin;
  let navigation = outcome.navigation;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let next: ScreenOrigin<C>;
    if (navigation.type === 'stay') {
      if (!from) return { target: undefined, toast, notices };
      next = from;
    } else if (navigation.type === 'back') {
      const parent = from?.entry.parent;
      if (!from || !parent) {
        throw new Error('[stitchkit] telegram screens: back() from a screen with no parent.');
      }
      next = { entry: parent, params: paramsFor(parent, from.params) };
    } else {
      const entry = runtime.registry.entryOf(navigation.screen);
      next = { entry, params: navigation.params };
    }
    const resolved = await next.entry.definition.resolve(ctx, next.params);
    if (resolved === 'invalid-params') {
      throw new Error(
        `[stitchkit] telegram screens: "${next.entry.definition.path.path}" refused the params it was sent with.`,
      );
    }
    if ('navigation' in resolved) {
      if (resolved.navigation.type === 'stay') {
        throw new Error(
          `[stitchkit] telegram screens: a load of "${next.entry.definition.path.path}" answered stay(); return data instead.`,
        );
      }
      toast = resolved.toastSpec ?? toast;
      notices.push(...resolved.notices);
      from = next;
      navigation = resolved.navigation;
      continue;
    }
    return { target: { entry: next.entry, resolved }, toast, notices };
  }
  throw new Error(
    `[stitchkit] telegram screens: loads redirected more than ${MAX_REDIRECTS} times in a row.`,
  );
}

/** What the new view is reconciled against. */
export type DisplayBase =
  /** What the chat's record says it shows. */
  | { readonly mode: 'state' }
  /** A message pressed outside that view. */
  | { readonly mode: 'foreign'; readonly message: ShownMessage }
  /** Nothing: the view is sent below and the old one left as it is. */
  | { readonly mode: 'new' }
  /** The old view is deleted and the new one sent below. */
  | { readonly mode: 'fresh' };

export interface DisplayRequest<C extends Context> {
  readonly ctx: C;
  readonly chat: string;
  readonly chatId: number;
  readonly state: ScreenChatState;
  readonly settled: SettledNavigation<C>;
  readonly base: DisplayBase;
  readonly trigger: ScreenTrigger;
  readonly started: number;
}

export async function sendText(
  api: ScreenApi,
  chatId: number,
  content: TelegramText,
): Promise<number> {
  return (await api.sendMessage(chatId, htmlOf(content), { parse_mode: 'HTML' })).message_id;
}

function planFor(
  base: DisplayBase,
  state: ScreenChatState,
  next: Parameters<typeof planView>[1],
  moves: boolean,
): ViewPlan {
  const current = state.view?.messages ?? [];
  if (base.mode === 'new') return planView([], next);
  if (base.mode === 'fresh' || moves) {
    const shown = base.mode === 'foreign' ? [...current, base.message] : current;
    return planView(shown, next, { fresh: true });
  }
  if (base.mode === 'state') return planView(current, next);
  // A press on a message the record does not know: a one-message view takes
  // that message over; a longer one is sent below, because its first message
  // would sit far up the chat and the rest at the bottom. Either way the old
  // view goes — one live menu per chat.
  const others = current.map((message) => message.id).filter((id) => id !== base.message.id);
  if (next.length === 1) {
    const adopted = planView([], next, { adopt: base.message });
    return { steps: adopted.steps, deletions: [...adopted.deletions, ...others] };
  }
  return planView([...current, base.message], next, { fresh: true });
}

function templateOf<C extends Context>(
  runtime: ScreensRuntime<C>,
  view: ScreenViewState | null,
): string | undefined {
  return view ? runtime.registry.byId(view.screen)?.definition.path.path : undefined;
}

/** Delete the chat's remarks whose time has come, and write the record. */
export async function sweepDue<C extends Context>(
  runtime: ScreensRuntime<C>,
  api: ScreenApi,
  chat: string,
  chatId: number,
): Promise<ScreenChatState> {
  const state = await runtime.readState(chat);
  const now = runtime.clock();
  const due = state.expiring.filter((remark) => remark.at <= now);
  if (due.length === 0) return state;
  const kept = await deleteMessages(
    api,
    chatId,
    due.map((remark) => remark.id),
  );
  if (kept.length > 0) runtime.emit({ type: 'message-kept', chat, messageIds: kept });
  const swept: ScreenChatState = {
    ...state,
    expiring: state.expiring.filter((remark) => remark.at > now),
  };
  await writeChatState(runtime.config.storage, chat, swept);
  return swept;
}

const nothingDone: ExecutionReport = {
  sent: 0,
  edited: 0,
  kept: 0,
  deleted: 0,
  undeleted: [],
};

/**
 * The record after a plan stopped halfway. The transition did not happen: the
 * chat stays on the screen it was on — its input, its params — while the
 * record lists every message the chat now shows of either render, in the
 * chat's order, and keeps the buttons of both, so whatever the user presses
 * next is understood and the next render repairs the rest.
 */
function interruptedRecord(
  previous: ScreenViewState | null,
  base: DisplayBase,
  drawn: ScreenViewState,
  shown: readonly ShownMessage[],
): ScreenViewState | null {
  // Sent below a view it was told to leave alone, the new view never covered
  // the old one's messages: they are still the chat's menu, and above it.
  const untouched = base.mode === 'new' ? (previous?.messages ?? []) : [];
  const messages = [...untouched, ...shown];
  if (messages.length === 0) return previous;
  const identity = previous ?? drawn;
  return {
    screen: identity.screen,
    params: identity.params,
    messages,
    tokens: { ...previous?.tokens, ...drawn.tokens },
  };
}

/** Make room for one more remark: the oldest goes first. */
async function evictOldestRemark<C extends Context>(
  runtime: ScreensRuntime<C>,
  api: ScreenApi,
  chat: string,
  chatId: number,
  remarks: ScreenChatState['expiring'][number][],
): Promise<void> {
  const oldest = remarks.shift();
  if (!oldest) return;
  const kept = await deleteMessages(api, chatId, [oldest.id]);
  if (kept.length > 0) runtime.emit({ type: 'message-kept', chat, messageIds: kept });
}

export async function displayScreen<C extends Context>(
  runtime: ScreensRuntime<C>,
  request: DisplayRequest<C>,
): Promise<void> {
  const { ctx, chat, chatId, state, settled, base } = request;
  const api = ctx.api;
  const persistent = settled.notices.filter((notice) => notice.expiresInMs === undefined);
  const expiring = settled.notices.filter((notice) => notice.expiresInMs !== undefined);
  const target = settled.target;
  // Rendered before anything is sent: a view the record could not hold is
  // refused while the chat is still untouched.
  const rendered = target
    ? renderView(target.resolved.render(), {
        prefix: runtime.prefix,
        resolver: runtime.registry.resolverFor(target.entry),
        params: target.resolved.params,
      })
    : undefined;
  let view = state.view;
  const remarks = [...state.expiring];
  let report = nothingDone;
  let failure: { readonly error: unknown } | undefined;

  try {
    if (target && rendered) {
      const plan = planFor(base, state, rendered.messages, persistent.length > 0);
      // A remark below the screen would split it the moment anything is sent,
      // and it belongs to the screen it was said on.
      const leaving = target.entry.definition.id !== state.view?.screen;
      if (remarks.length > 0 && (leaving || plan.steps.some((step) => step.op === 'send'))) {
        const kept = await deleteMessages(
          api,
          chatId,
          remarks.map((remark) => remark.id),
        );
        if (kept.length > 0) runtime.emit({ type: 'message-kept', chat, messageIds: kept });
        remarks.length = 0;
      }
      const drawn = (messages: readonly ShownMessage[]): ScreenViewState => ({
        screen: target.entry.definition.id,
        params: { ...target.resolved.params },
        messages: [...messages],
        tokens: { ...rendered.tokens },
      });
      for (const notice of persistent) await sendText(api, chatId, notice.content);
      try {
        const executed = await executePlan(api, chatId, plan);
        report = executed.report;
        view = drawn(executed.shown);
      } catch (error) {
        if (!(error instanceof PlanInterrupted)) throw error;
        view = interruptedRecord(state.view, base, drawn([]), error.shown);
        throw error.cause;
      }
      if (report.undeleted.length > 0) {
        runtime.emit({ type: 'message-kept', chat, messageIds: report.undeleted });
      }
    } else {
      for (const notice of persistent) await sendText(api, chatId, notice.content);
    }
    const now = runtime.clock();
    for (const notice of expiring) {
      if (remarks.length >= RECORD_LIMITS.remarks) {
        await evictOldestRemark(runtime, api, chat, chatId, remarks);
      }
      const delayMs = notice.expiresInMs ?? 0;
      remarks.push({ id: await sendText(api, chatId, notice.content), at: now + delayMs });
      runtime.scheduleSweep(api, chat, chatId, delayMs);
    }
  } catch (error) {
    failure = { error };
  }
  // Whatever stopped the update, the record says what the chat now shows.
  await writeChatState(runtime.config.storage, chat, { version: 1, view, expiring: remarks });
  if (failure) throw failure.error;
  if (target) {
    runtime.emit({
      type: 'transition',
      trigger: request.trigger,
      chat,
      from: templateOf(runtime, state.view),
      to: target.entry.definition.path.path,
      durationMs: Math.max(0, runtime.clock() - request.started),
      report,
    });
  }
}
