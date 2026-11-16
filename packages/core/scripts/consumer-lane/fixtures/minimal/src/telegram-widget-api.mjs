import assert from 'node:assert/strict';
import { TELEGRAM_WIDGET_LIMITS, telegramOutboundBudget } from 'stitchkit/telegram';
import { telegramBudgetTransformer, telegramWidgetApi } from 'stitchkit/telegram/grammy';

/**
 * The packed widget methods with no grammY installed: a structural client whose
 * `raw` proxy runs every call through the packed budget transformer, as grammY's
 * does, and answers like Bot API. Importing both entrypoints here already proves
 * neither loads grammY at run time.
 */
function structuralClient(budget, answer) {
  const calls = [];
  const transformer = telegramBudgetTransformer(budget);
  const raw = new Proxy(
    {},
    {
      get: (_target, method) => async (payload, signal) => {
        const response = await transformer(
          async (name, body) => {
            calls.push({ method: name, payload: body });
            return answer(name);
          },
          String(method),
          payload,
          signal,
        );
        if (!response.ok) throw Object.assign(new Error(response.description), response);
        return response.result;
      },
    },
  );
  return { api: { raw }, calls };
}

const budget = telegramOutboundBudget({ token: `packed-widget-${crypto.randomUUID()}` });
const results = {
  sendWidget: {
    ok: true,
    result: { message_id: 9, chat: { id: 5, type: 'private' }, widget: { html: '<b>w</b>' } },
  },
  editMessageWidgetData: {
    ok: false,
    error_code: 400,
    description: 'Bad Request: message is not modified',
  },
  answerWidgetQuery: { ok: true, result: true },
};
const { api, calls } = structuralClient(budget, (method) => results[method]);
const widgets = telegramWidgetApi(api);

const sent = await widgets.sendWidget({ chat_id: 5, html: '<b>w</b>', chat_data: '' });
assert.equal(sent.message_id, 9);
await widgets.editMessageWidgetData({ chat_id: 5, message_id: 9, chat_data: '{"v":1}' });
await widgets.answerWidgetQuery({ widget_query_id: 'q', data: '' });
assert.deepEqual(
  calls.map((call) => call.method),
  ['sendWidget', 'editMessageWidgetData', 'answerWidgetQuery'],
);
assert.deepEqual(calls[0]?.payload, { chat_id: 5, html: '<b>w</b>', chat_data: '' });
assert.deepEqual(calls[2]?.payload, { widget_query_id: 'q', data: '' });
const stats = budget.stats();
assert.equal(stats.messages, 2, 'send and edit spend one message each, the answer none');

const overLimit = await widgets
  .answerWidgetQuery({
    widget_query_id: 'q',
    data: 'x'.repeat(TELEGRAM_WIDGET_LIMITS.dataBytes + 1),
  })
  .catch((error) => error);
assert.equal(overLimit?.name, 'ZodError');
const controller = new AbortController();
controller.abort(new Error('stopped'));
const cancelled = await widgets
  .sendWidget({ chat_id: 5, html: '<b>w</b>' }, { signal: controller.signal })
  .catch((error) => error);
assert.equal(cancelled?.name, 'TelegramNotDispatchedError');
assert.equal(calls.length, 3, 'refused and cancelled calls send nothing');

console.log('packed telegram widget api: ok');
