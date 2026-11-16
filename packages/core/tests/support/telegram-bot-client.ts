/**
 * A real grammY `Api` over a `fetch` that answers the way Bot API does, with the
 * outbound budget as its one transformer: the client a budgeted bot holds, minus
 * the network. Each request is recorded with its method, payload and the manual
 * clock's time, so a test measures what left and when.
 */
import { Api } from 'grammy';
import { telegramBudgetTransformer } from '../../src/entrypoints/telegram/grammy';
import type { ManualClock } from '../../src/entrypoints/testing';
import type { manualBudget } from './telegram-budget-clock';

export interface BotApiCall {
  readonly method: string;
  readonly payload: unknown;
  readonly chat: unknown;
  readonly at: number;
}

/** A Bot API answer, or `'hang'`: the request stays open until its signal aborts. */
export type BotApiAnswer = { readonly status: number; readonly body: unknown } | 'hang';

export const OK = { status: 200, body: { ok: true, result: { message_id: 1 } } } as const;

/** The answer to the `call`-th request of the client (counted from 1, across methods), a call of `method`. */
export type BotApiResponder = (call: number, method: string) => BotApiAnswer;

export function botClient(
  clock: ManualClock,
  budget: ReturnType<typeof manualBudget>['budget'],
  answerFor: BotApiResponder = () => OK,
): { api: Api; calls: BotApiCall[] } {
  const calls: BotApiCall[] = [];
  const respond = async (url: unknown, init?: RequestInit): Promise<Response> => {
    const payload: unknown = JSON.parse(String(init?.body));
    const method = String(url).split('/').at(-1) ?? '';
    calls.push({
      method,
      payload,
      chat: Reflect.get(Object(payload), 'chat_id'),
      at: clock.now(),
    });
    const answer = answerFor(calls.length, method);
    if (answer === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
          once: true,
        });
      });
    }
    return Response.json(answer.body, { status: answer.status });
  };
  const fetchBotApi = Object.assign(respond, { preconnect: () => undefined });
  const api = new Api('123456:fixture-token', { fetch: fetchBotApi });
  api.config.use(telegramBudgetTransformer(budget));
  return { api, calls };
}
