# Telegram bots

`stitchkit/telegram` holds what the Bot API itself asks of every bot, with no
bot library; `stitchkit/application/grammy` makes a grammY bot a set of
application resources. Together they are what a bot is assembled from, so that
a bot's own code is its product and nothing else. A generated bot to start from:
`bun create stitchkit my-bot --template telegram-bot`. Why it is shaped this
way: [ADR 0201](../decisions/0201-a-telegram-bot-is-assembled-from-primitives.md).

| Job | Where |
|---|---|
| the bot as resources: command menu, then long polling with updates admitted by batch | `grammyBotResources` — [application kernel](application-kernel.md#optional-grammy-adapter) |
| a bot on a webhook: set only where it is this process's, updates recorded before Telegram is answered | `claimTelegramWebhook`, `createTelegramUpdateIntake`, `receiveTelegramWebhook` — [below](#a-bot-on-a-webhook) |
| text for Telegram's HTML: Markdown converted, markup cleaned, cut to the limit, checked | `stitchkit/telegram/html` — [below](#message-markup) |
| widgets: send, change their data, answer their queries, under the token's budget | `telegramWidgetApi` from `stitchkit/telegram/grammy` — [below](#widgets) |
| the process journal | `createJsonLogger` from `stitchkit/observability` |
| the operator's chat: product events, apart from the journal | `createTelegramOperatorChannel` |
| a broadcast that survives crashes, deploys and Ctrl-C | `runTelegramBroadcast` |
| a file the local Bot API server wrote to disk | `createTelegramLocalFiles` |
| the waveform of a voice message: packed for `sendVoice`, drawn in a page | `readTelegramVoiceWaveform`, `stitchkit/telegram/voice` — [below](#voice-waveforms) |
| why a send was refused | `classifyTelegramSendFailure` — [auth and errors](auth-and-errors.md#telegram-mini-apps) |
| Mini App `initData` | `verifyTelegramInitData` — [auth and errors](auth-and-errors.md#telegram-mini-apps) |
| one Bot API call without a bot library | `callTelegramBotApi` |
| menus: screens, buttons, actions, input and message editing | `stitchkit/telegram/screens` — [Telegram screens](telegram-screens.md) |

## The journal

A bot's journal is `createJsonLogger`: one JSON object per line on standard
output, in pino's shape — numeric `level` (`debug` 20, `info` 30, `warn` 40,
`error` 50), `time` in epoch milliseconds, `msg` — so `pino-pretty` reads it on
a terminal and a supervisor matching `"level":50` sees errors. Unlike pino, an
`Error` under *any* key is written with its name, message, stack and cause; an
error logged as `{ error }` does not become `"error":{}`, and its own fields —
a `TelegramBotApiError`'s `error_code` and `parameters.retry_after` — are on the
line beside them.

A bot token is masked wherever it appears — a request URL in an error message,
a local Bot API file path — with no configuration: `123456:[redacted]` keeps the
bot's id, which is public and is what tells two bots apart in one journal. So is
the password in an address and a query parameter named as a secret (`?token=`).

```ts
import { createJsonLogger } from 'stitchkit/observability'

export const logger = createJsonLogger({
  level: env.LOG_LEVEL,
  fields: { service: 'my-bot' },
})

logger.error('Application startup failed', { error })
```

A provider's key, a webhook secret or a database password has no shape a
pattern could guess, so the journal also masks exact values — and the
environment already names them. `secretValuesFromEnv` collects every variable
named as a token, secret, key, password or credential, the password and secret
query values inside any URL variable (`DATABASE_URL`), and each URL-encoded:

```ts
import { createJsonLogger, secretValuesFromEnv } from 'stitchkit/observability'

export const logger = createJsonLogger({
  sensitiveValues: secretValuesFromEnv(process.env),
})
```

A string of your own — a message for a person, a report — masks bot tokens with
`redactTelegramBotToken(text)` from `stitchkit/telegram`.

A key added to the environment is masked from its first line; a URL's user name
is left alone, since it names a role that appears in ordinary text.

The error line contract, for whatever recognises a failure from the journal: a
line whose `level` is `50` or more is an error. There is no separate `fatal`;
an unrecoverable end is an `error` line followed by a non-zero exit.

## One token, one outbound budget

Telegram counts a bot's bulk messages per token, not per campaign, handler or
module. `telegramOutboundBudget` is that budget once: every alias of one token
in the process gets the same object, another token gets another, and every send
through it spends its weight. → [ADR 0274](../decisions/0274-a-telegram-token-has-one-outbound-budget.md).

```ts
import { telegramOutboundBudget } from 'stitchkit/telegram'
import { telegramBudgetTransformer } from 'stitchkit/telegram/grammy'

const budget = telegramOutboundBudget({
  token: env.BOT_TOKEN,
  messagesPerSecond: 24,
})

// The one transformer of the bot's client. No second limiter, no second
// scheduler: campaigns, replies and every other send of this token share it.
bot.api.config.use(telegramBudgetTransformer(budget))
```

`telegramBudgetTransformer` is the whole wiring for grammY. Without it the
adapter is `budget.run(method, payload, signal, () => previous(method, payload, signal))`
inside your own `config.use` closure; that works too, but grammY types its signal
as the `abort-controller` polyfill's, so the closure has to pass `undefined` or
cast, and a send cancelled in the queue then waits for its slot and fails as
`unknown`. The transformer takes grammY's signal as it is.

- **The token is the identity, not the sender.** Two bot objects built from one
  token share the budget; two different tokens do not. The registry keeps a
  128-bit identity, never the credential, and `stats()` contains no token.
- **A message is the unit, and unknown methods fail closed.** `sendMediaGroup`
  and `sendPaidMedia` cost their media length, `copyMessages` and
  `forwardMessages` cost their message ids, and a follow-up call to action after
  an album costs one more. `sendWidget`, `sendSharedWidget` and
  `editMessageWidgetData` each cost one; Telegram counts
  [a widget data edit as a sent message](https://core.telegram.org/bots/widgets#changing-the-state),
  including an inline edit without `chat_id`. Only the explicitly classified
  free list (`FREE_METHODS`) costs zero — reads, ordinary edits of already-sent
  messages, deletions, administration, `sendChatAction`, `answerWidgetQuery` and
  `editSharedWidgetData` (whose own edit limit is separate from this token
  budget). Any Bot API method the budget does not know — such as a newer method
  Telegram added — costs **one** message and, on a 429, pauses its `chat_id` (or
  the whole token when the payload carries no chat) rather than passing through
  unbudgeted.
- **Two lanes share one rate.** A call is `interactive` by default; a campaign passes
  `{ lane: 'bulk' }` to `run` or `acquire`, or installs
  `telegramBudgetTransformer(budget, { lane: 'bulk' })` on its own `Api`. A waiting
  interactive call is granted first, so a reply never queues behind recipients;
  the wait it can still see is the interval of the grant before it, up to one
  album. Bulk runs at whatever rate replies leave, and the sum never exceeds
  `messagesPerSecond`.
- **The first send after idle is immediate; the rest are spaced.** This is a
  strict budget, not a bucket that saves a burst: at 24/s the next send is due
  one interval later. When a pause ends, one send is released at the deadline and
  the queue continues one interval at a time, never as a stampede.
- **A 429 holds the chat that got it.** Telegram words a group's limit, a chat's
  pace and the bot's own limit alike, and only the addressee differs, so `run`
  pauses the `chat_id` of the refused send and every other chat of the token goes
  on at the shared rate. A person's reply does not wait behind a notification
  group on its limit, and neither does a campaign. Refusals from
  `tokenPauseChats` different chats (default 3) inside `tokenPauseWindowMs`
  (default 5000) are read as the bot's own limit and pause the whole token, and so
  does a 429 with no chat in the payload. `stats().pausedChats` counts the chats
  on a pause; `stats().pausedForMs` is the token's.
- **A chat known to hit its limit can keep a 429 to itself.** A notification group
  runs into its per-minute limit as a matter of course. `{ refusal: 'call' }` on `run`,
  or `telegramBudgetTransformer(budget, { refusal: 'call' })` on that group's own `Api`,
  makes the refusal concern that send alone: nothing pauses and nothing counts towards
  `tokenPauseChats`. The call still spends the budget and waits out other pauses, and
  what to do with the refused message stays the caller's decision.
- **A wait can be bounded.** A burst to one chat on pause otherwise queues without
  limit. `{ maxWaitMs }` on `run` or `acquire`, or on
  `telegramBudgetTransformer(budget, { maxWaitMs })`, ends a call that waited that
  long with `TelegramNotDispatchedError`, stage `queue`: nothing was sent and no
  message was spent, so repeating it is safe.
- **It paces; it does not retry.** `run` calls the send once. A 429 pauses for
  Telegram's `retry_after` (or `retryAfterFallbackMs` when Telegram gave none) and
  rethrows; the caller's retry policy decides what happens next.
  The refusal may be thrown or returned: a client transformer sits below the
  place where grammY turns Telegram's `{ ok: false, error_code: 429, … }` body into
  a `GrammyError`, so `run` reads that body too and hands it back unchanged.
  A 429 from a zero-cost call concerns that call and pauses nothing;
  `budget.pauseAfter(error, { chatId })` remains for a caller who decides otherwise, and pauses
  the token when it names no chat. A network failure is rethrown unchanged and stays `unknown`; a 5xx
  is rethrown unchanged and stays `server-error`. Neither is retried by the
  budget or pauses the token — repeating a send whose outcome is unknown is a
  decision, not a primitive's silent guess.
- **A wait can be cancelled.** `run`/`acquire` take an `AbortSignal`; a
  cancelled waiter spends no slot and calls no provider. Through
  `telegramBudgetTransformer` a send cancelled before it was handed to the client
  throws `TelegramNotDispatchedError` (`classifyTelegramSendFailure` says
  `not-dispatched`, safe to repeat); a send cancelled after it was handed on is
  the client's own error — not evidence that Telegram did not accept it — so
  keep the outcome unknown rather than retrying it as a definite failure.
- **Non-send retries wait without spending.** An ordinary edit or delete retry that got
  a 429 records the pause with `budget.pauseAfter(error, { chatId })`, then uses
  `await budget.waitUntilResumed(signal, { chatId })`; it shares that chat's pause
  and the token's, and takes no message slot. Without `chatId` it pauses the token.
  An `editMessageWidgetData` retry uses `run` instead: it costs another message.

`telegramBroadcastSender` and `telegramOperatorSender` still send through
`callTelegramBotApi`; they are not a second budget. Their returned function does
not expose the method and payload, so a product that uses one wraps the concrete
`sendMessage`/`copyMessage` call in `budget.run` where it knows both, or passes
its own sender. There is no generic wrapper around the opaque sender.
`runTelegramBroadcast` keeps its per-run `ratePerSecond` and the operator
channel keeps its per-chat `minIntervalMs`; those are caps of their own jobs,
not another token quota. The token budget is the binding shared cap.

## The operator channel

The chat where people read about new users, payments and failures is not the
journal. The journal must not lose a line to a slow network; the chat must not
slow the bot down. `post` returns at once and never throws; sends are paced
below Telegram's per-chat limit (one every 3 s by default), 429s wait the time
Telegram named up to `maxRetryAfterMs` (a minute by default; a longer flood wait
drops that message as `flood-wait` rather than hold the queue behind it), and
when the chat cannot keep up the oldest message is dropped and reported.

```ts
import { createTelegramOperatorChannel, telegramOperatorSender } from 'stitchkit/telegram'

const operators = createTelegramOperatorChannel<'users' | 'payments' | 'errors'>({
  chatId: env.OPERATOR_CHAT_ID,
  topics: { users: 2, payments: 3, errors: 4 },   // forum message_thread_id
  send: telegramOperatorSender({ token: env.BOT_TOKEN }),
  onDropped: (drop) => logger.warn('Operator message dropped', { ...drop }),
})

operators.post(`New user ${user.id}`, 'users')
```

Every message is masked before it leaves: a bot token always — bots post their
errors here, and an error about a local Bot API file carries the token in its
path — plus any `sensitivePatterns` and exact `sensitiveValues` the bot adds;
`telegramOperatorSender` also masks its own exact token, and with `parseMode:
'HTML'` repairs the markup — a text cut at Telegram's limit never leaves a tag
open.

A failure that repeats a hundred times, or a storm of a hundred different ones
when a database goes down, is a line with a count for the person reading, not a
hundred messages. `dedupe` sends one message per fingerprint per window — the
topic and the text with numbers, UUIDs and long identifiers blanked — and the
next one of that kind carries how many were held back; past `maxPerWindow`
messages in a window the rest are counted onto the next message sent:

```ts
const operators = createTelegramOperatorChannel<'errors'>({
  chatId: env.OPERATOR_CHAT_ID,
  send: telegramOperatorSender({ token: env.BOT_TOKEN }),
  sensitiveValues: secretValuesFromEnv(process.env),
  dedupe: {
    windowMs: 10 * 60_000,
    maxPerWindow: 20,
    repeatedLine: (count) => `Same again: ${count}`,
  },
})
```

Held-back messages reach `onDropped` as `repeated` or `over-budget`.

A bot that already sends its alerts itself — its own bot instance, its own retry
— takes the window alone instead of switching the channel off with parameters:

```ts
import { createTelegramOperatorDedupe } from 'stitchkit/telegram'

const admit = createTelegramOperatorDedupe<'errors'>({ windowMs: 10 * 60_000 })

const verdict = admit(text, 'errors')
if (verdict.send) await sendAlert(verdict.text) // the text carries the held-back counts
```

What to post stays the bot's. On the way down, drain it within the grace period
and close it: `drain: (context) => operators.drain(context.signal)`,
`close: () => operators.close()` in a resource.

## Broadcasts

A broadcast is a job with an end, so it is a function, not a resource:

```ts
import { runTelegramBroadcast, telegramBroadcastSender } from 'stitchkit/telegram'

const report = await runTelegramBroadcast({
  name: '2026-04-28-price-lock',
  directory: env.STATE_DIRECTORY,            // a state root, never the release tree
  recipients: () => audience.activeSubscribers(),
  send: telegramBroadcastSender({
    token: env.BOT_TOKEN,
    message: { copyFrom: { chatId: env.DRAFTS_CHAT_ID, messageId: 42 } },
  }),
  signal: stop.signal,
  onProgress: (progress) => logger.info('Broadcast', { ...progress }),
})
```

- **Resumable by name.** The audience is written once on the first run; running
  the same name again continues with that list. Progress is an append-only
  journal beside it, one line before and one after each send.
- **Nobody twice.** A send that was in flight when the process died is recorded
  `uncertain` and not repeated. A signal stops between sends, after the one in
  flight is recorded.
- **Refusals by meaning.** A blocked, deactivated or never-started recipient is
  `unreachable` and never addressed again. A 429 waits Telegram's
  `retry_after` and sends the same recipient again; a server error is retried
  with backoff up to `maxAttempts`, then `failed`. A message Telegram cannot
  parse is not the recipient's fault: the run **halts** with them still pending,
  so the run after the fix reaches them. An unknown transport outcome becomes
  `uncertain` immediately and halts the run; resume never sends to that recipient again.
- **Pacing** is `ratePerSecond`, 25 by default. `dryRun` counts and writes
  nothing. One runner per name: a second concurrent run is refused.

The same call works from a script (the process's signal) and inside a live
application (the application's signal, with admission held by the caller).
The recipient state contains Telegram ids: keep it in the state directory, out
of git.

### Injecting another transport's failure policy

`classify(error)` returns the public `TelegramBroadcastFailure` union. It lets
an application use its own client without adding that SDK to Stitchkit:

```ts
const report = await runTelegramBroadcast({
  name: 'announcement',
  directory: env.STATE_DIRECTORY,
  recipients: () => audience.activeSubscribers(),
  send: ({ recipient }) => client.sendMessage(recipient, message),
  classify(error) {
    if (isFloodWait(error))
      return { kind: 'retry-after', retryAfterMs: error.seconds * 1000,
        reason: 'provider-rate-limit' }
    if (isRecipientGone(error))
      return { kind: 'permanent', recipientUnreachable: true,
        reason: 'recipient-gone' }
    return { kind: 'ambiguous', reason: 'unknown-provider-outcome' }
  },
  maxRetryDelayMs: 60_000,
  signal: stop.signal,
})
```

The four variants are `retry-after` (exact `retryAfterMs`), `transient` (bounded
backoff), `permanent` (optionally `recipientUnreachable` or `stopBroadcast`), and
`ambiguous`. Retry variants certify that the failed attempt had no external
effect. Lack of an HTTP status does not establish that fact: a server may have
accepted the message before the connection failed. `ambiguous` durably records
`uncertain`, then halts; resuming the name skips that recipient.

`maxRetryDelayMs` defaults to 60 seconds. A provider wait above it halts with the
recipient pending; it is never shortened to send early. `maxAttempts` is an
integer from 1 to 100, `maxRetryDelayMs` is an integer from 0 to 2,147,483,647,
and pacing/progress intervals must fit native timers. The optional
`sleep(milliseconds, signal)` receives cancellation; the runner also stops waiting
when the signal aborts if a custom sleeper ignores it. A send already in flight
finishes and is recorded before stopping.

Without `classify`, known Bot API 429, unreachable-recipient, malformed-message,
server-error and not-dispatched behavior remains. Unknown/no-status failures now halt as
uncertain, rather than being automatically retried. Existing custom `send`
implementations that relied on those retries must supply an explicit classifier
for proven pre-effect failures. `report.halt` now carries
`TelegramBroadcastFailure`; inspect `halt.kind` instead of the old send-failure
`scope`/`retryable` fields.

The runner uses the shared process-instance lock and checks its generation before
sends and journal writes. The audience and initial journal directory entry are
synced before sending. Lost ownership cannot write a stale delivered receipt or
start another send; the persisted intent becomes uncertain on recovery. Old
pid-only broadcast locks have unknown ownership and require recovery after their
writers are verified stopped, rather than automatic age-based deletion.

The installed
[`telegram-broadcast-classifier.mjs`](../../packages/core/scripts/consumer-lane/fixtures/minimal/src/telegram-broadcast-classifier.mjs)
fixture checks injected rate limits, ambiguity/no resend, wait budgets and abort
on Bun and Node without a client SDK.

## A transport that knows whether a request left

`fetch` folds establishing the connection and waiting for the answer into one failure. From that
failure nobody can say whether Telegram saw the message, so the senders above treat every network
failure as unknown: a broadcast records the recipient `uncertain` and the operator channel drops
the message rather than risk a duplicate. On a route that sometimes fails to connect at all, that
loses messages that never left.

`createTelegramBotTransport()` connects first and writes the request only on an established
connection. Every failure before the first byte is written is `TelegramNotDispatchedError`
(`stage`: `lookup`, `connect` or `request`), and `classifyTelegramSendFailure` reads it as
`not-dispatched` — `retryable`, with `evidence: 'transport'`. A broadcast retries it as
`transient`; the operator channel sends it again. A failure after the request was written stays
an outcome nobody can know.

```ts
import { createTelegramBotTransport, telegramOperatorSender } from 'stitchkit/telegram'

const transport = createTelegramBotTransport()
const send = telegramOperatorSender({ token: env.BOT_TOKEN, fetch: transport })
```

Pass it as `fetch` to `callTelegramBotApi`, `telegramBroadcastSender`, `telegramOperatorSender`
or the webhook calls. Addresses come in the system resolver's order with no family forced; the
next address starts 250 ms later (Happy Eyeballs), and a round with no connection is repeated
with new sockets inside `connectBudgetMs` (default 5 s, which also bounds the address lookup; each
round waits `connectAttemptMs`, default 2 s). The answer must arrive within `responseTimeoutMs` (default 30 s) and fit
`maxResponseBytes` (default 1 MiB). It speaks HTTP/1.1 over `https:`, and over `http:` for a
local Bot API server, and it uses no proxy: where the network needs one, keep `fetch`.

## Widgets

A widget (Bot API 10.4) is HTML that the Telegram app runs and draws inside a message, with data
of its own the bot changes and queries it sends to the bot. grammY 1.46 does not type the three
methods, and a bot that reaches for them tends to build a second client and with it a second
limiter. `telegramWidgetApi` takes the client the bot already has and calls the methods through
its `api.raw`, so the client's transformers — the outbound budget among them — run every call:

```ts
import { telegramOutboundBudget } from 'stitchkit/telegram'
import { telegramBudgetTransformer, telegramWidgetApi } from 'stitchkit/telegram/grammy'

bot.api.config.use(telegramBudgetTransformer(telegramOutboundBudget({ token: env.BOT_TOKEN })))
const widgets = telegramWidgetApi(bot.api)

const message = await widgets.sendWidget(
  { chat_id, html, chat_data: state, allow_queries: true, reply_markup },
  { signal },
)
await widgets.editMessageWidgetData(
  { chat_id, message_id: message.message_id, chat_data: next },
  { signal },
)
await widgets.answerWidgetQuery({ widget_query_id: query.id, data: answer }, { signal })
```

The parameters are the Bot API's, by their Bot API names, so the call reads as the grammY call it
becomes once grammY types the method. A field is sent when it is not `undefined`: `chat_data: ''`
reaches Telegram and removes the data, an omitted field keeps it. An edit names `chat_id` with
`message_id`, or `inline_message_id`, and changes `chat_data`, `public_data` or both.

- **Limits are checked before the request, in UTF-8 bytes.** `TELEGRAM_WIDGET_LIMITS`: HTML 1–32768
  bytes and at most 4096 after zlib level 9; `chat_data`, `public_data` and an answer 0–1024; query
  data 1–64. One emoji is four bytes, one Cyrillic letter two. NUL and an unpaired surrogate are
  refused too. A refused value throws `ZodError` naming its field and size: nothing was sent, and
  the same input will be refused again, so a durable sender records it as failed rather than
  retrying. `TelegramWidgetHtmlSchema` and `TelegramWidgetDataSchema` are the same checks for a
  sender that wants its own margin first.
- **The compressed size is an estimate.** It is measured with the runtime's own zlib at level 9,
  and zlib builds differ by tens of bytes near 4096 — Node's output is smaller than Bun's on the
  same HTML — while Telegram does not say which it runs. HTML that compresses close to the limit
  can pass here and be refused by Telegram; keep a margin below 4096.
- **A send and an edit cost one message; an answer costs none.** Telegram counts a data edit as a
  sent message, so both wait for the token's schedule and a 429 pauses their chat; an inline edit
  has no chat and a 429 on it pauses the token. `answerWidgetQuery` waits for no slot and no pause:
  Telegram expects the answer within `TELEGRAM_WIDGET_LIMITS.answerWindowMs` (15 s).
- **What happens to a call is said by its error.** An already aborted `signal`, or one aborted
  while the call waits for its slot, throws `TelegramNotDispatchedError` — nothing left, safe to
  send again. A request handed to the client is never repeated: a failure after that point may
  have been delivered, and a send whose outcome is unknown is the caller's to settle.
  `message is not modified` on an edit is success. A successful answer that is not what the method
  returns — `true` where a message was due, as a grammY webhook reply gives — is an error with the
  parse failure as its `cause`: the request was sent and its outcome is unknown.
- **Queries are answered at intake.** `widget_query` must be in the webhook's or polling's
  `allowed_updates`; grammY's `Update` type does not name it yet, so read
  `update.widget_query` with `parseTelegramWidgetQuery`. It returns `{ query }`, or `{ id, error }`
  for a query that does not parse — an unknown `type` or data outside 1–64 bytes — whose id is
  enough to answer it with a refusal rather than leave the widget waiting, or `undefined` without
  an id. Telegram's message, chat and query objects are parsed loosely: fields it adds later pass
  through.
- **Shared widgets are not here.** `is_shared`, `sendSharedWidget`, `editSharedWidgetData` and
  `shared_widget_query` are outside this API; in production Telegram sends widgets to private
  chats only.

The installed
[`telegram-widget-api.mjs`](../../packages/core/scripts/consumer-lane/fixtures/minimal/src/telegram-widget-api.mjs)
fixture runs the packed methods through the packed budget transformer on Bun and Node with no
grammY installed.

## Message markup

`stitchkit/telegram/html` is Telegram's HTML parse mode as a tree, with no peer
and no DOM, so a server sending a message and a browser previewing it share one
parser. Text written by someone else — a model, an editor, an owner's greeting —
becomes markup Telegram accepts: synonyms renamed (`strong` → `b`), block tags
turned into line breaks, a link kept only with an `href` Telegram opens,
anything Telegram forbids (a tag it does not know, formatting inside `code`, a
quote inside a quote) left as its words. An element nested more than 32 deep
keeps its words and loses its tag, so parsing stays linear in the markup.

```ts
import { sanitizeTelegramHtml, splitTelegramHtml } from 'stitchkit/telegram/html'

for (const part of splitTelegramHtml(summary)) {
  await ctx.reply(part, { parse_mode: 'HTML' })
}
```

Telegram's limits — 4096 for a message, 1024 for a caption (`{ limit:
TELEGRAM_CAPTION_LIMIT }`) — count the text after the markup is parsed, so a
text is cut by what the reader sees, not by the length of its tags. A cut
prefers a paragraph, then a line, then a space; it never splits a character or
a custom emoji, and an element open across it is closed in one part and opened
again, attributes and all, in the next. A custom emoji or a `tg-time` longer than
the limit cannot be cut: `splitTelegramHtml` refuses it with a `RangeError`
rather than send a part over the limit or an empty one, and a truncation cuts
before it. `truncateTelegramHtml` keeps one part
with an ellipsis; `telegramHtmlText` is what the reader sees; `parseTelegramHtml`
gives the nodes to render a preview or an email from. `checkTelegramHtml` says,
without repairing anything, what Telegram would refuse — for an editor that
should warn a person rather than change their text.

When the source is GitHub-flavored Markdown — an assistant's reply, a media
caption, or a fallback where rich messages are unavailable — convert it through
the same tree with `markdownToTelegramHtml`, then cut the HTML with
`splitTelegramHtml`, which counts what the reader sees:

```ts
import {
  markdownToTelegramHtml,
  splitTelegramHtml,
  TELEGRAM_CAPTION_LIMIT,
  truncateTelegramHtml,
} from 'stitchkit/telegram/html'

const caption = truncateTelegramHtml(markdownToTelegramHtml(notes), {
  limit: TELEGRAM_CAPTION_LIMIT,
})
for (const part of splitTelegramHtml(markdownToTelegramHtml(report))) {
  await ctx.reply(part, { parse_mode: 'HTML' })
}
```

Converting first matters: a table becomes aligned text in `<pre>`, and its
padding can make the rendered text several times longer than its Markdown.

`markdownToTelegramHtml` builds canonical `TelegramHtmlNode[]` nodes and renders
them through `renderTelegramHtml`, so every output passes `checkTelegramHtml`
and is a fixed point of `sanitizeTelegramHtml`. Conversion takes time linear in
the text, and nesting deeper than 32 quotes, `<details>` blocks or inline styles
stays text, so no input can exhaust the stack. It converts bold (`**`, `__`),
italic (`*`, `_`), strikethrough (`~~`), spoilers (`||`), underline (`<u>`), inline and
fenced code blocks (backticks or tildes; unclosed fences stay literal plain
text), safe links (`http:`, `https:`, `tg:`, `mailto:` only, with balanced
parentheses in URLs), headings (`#`–`######` → `<b>`), nested lists and
checkboxes (`☐` / `☑`), blockquotes (`<blockquote>` with inline formatting,
links and code), GFM tables (`<pre>`), `<details>`/`<summary>`, horizontal
rules, and valid Telegram HTML entities while escaping raw `<`, `>`, `&` and
non-Telegram entities such as `&nbsp;` or `&apos;`. A link is kept by the same
fixed rules in every runtime, React Native included: a scheme Telegram opens, a
host for `http:`/`https:` (an optional port up to 65535), something after
`tg:`/`mailto:`, and no whitespace or control character anywhere.
An inline Markdown link with a literal `"` in its destination stays visible as
source text. To include a quotation mark in the URL, write `%22`; the converter
preserves that escape. Quotes in the label or around an optional title are fine. The rule
applies before entity decoding: `&quot;` in a destination still round-trips as
`&quot;` in the HTML `href`.

In a `<details>` block the summary becomes a bold heading. A tag on its own
line adds no visible line; blank lines the author left between the heading
and the body, or at the end of a nonempty body, are retained.

Plain text stays plain. Every emphasis delimiter keeps to word boundaries: it
opens only where no letter or digit stands before it and closes only where none
follows, so `2*3*4`, `a*b or c*d`, `SKU-12*34` and `snake_case_name` convert to
themselves, while `**bold**` and `*italic*` beside spaces and punctuation still
convert. A run of delimiters is judged at its edges as one. A link whose
destination the rules refuse is not dropped and does not become a link: its
source stays visible as text, so `[click](javascript:alert(1))` reads exactly
so.

What lists and tables look like: a list item is `• ` (a numbered one keeps its
number), and a nested item is indented two spaces per level with the same
marker — `• a` then `  • b`. A table is one `<pre>` block of aligned columns,
cells separated by ` | ` and the header underlined with `-` joined by `+`:

```text
a | b
--+--
1 | 2
```

`splitTelegramMarkdown` is for text that stays Markdown after the cut, sent
where the Markdown itself is rendered. It cuts along line boundaries so each Markdown
chunk stays within `limit` UTF-16 code units of Markdown (default
`TELEGRAM_TEXT_LIMIT`) — not of rendered text. A fenced block split across
chunks is closed in one and reopened in the next, a table split across chunks
repeats its header row and separator, and both repeats count against the
limit. It never emits an empty orphan fence chunk, and throws
`TelegramMarkdownSplitError` (`invalid-limit` or `line-exceeds-limit`) when
`limit` is not a positive safe integer or a single line cannot fit together
with the fence or table header repeated before it.

## A bot on a webhook

A webhook is one place in all of Telegram, and `setWebhook` takes it without
asking whose it was: a staging host or a developer's machine started with the
production token takes the production bot with one call. `claimTelegramWebhook`
sets it only where it already points here — address *and* secret — or where the
bot names the current owner's host as the one it takes over from (`'none'` when
there is no webhook: a bot on long polling is somebody's bot too). Telegram never
returns the secret, so the address carries an `owner` tag derived from it; a
copy of the production address with another secret is refused as
`other-secret` instead of quietly installing its own.

```ts
import {
  checkTelegramWebhook,
  claimTelegramWebhook,
  createTelegramUpdateIntake,
  receiveTelegramWebhook,
  sqliteTelegramUpdateStore,
} from 'stitchkit/telegram'
import { Database } from 'bun:sqlite'
import type { Update } from 'grammy/types'

const webhook = { token: env.BOT_TOKEN, url: env.WEBHOOK_URL, secret: env.WEBHOOK_SECRET }
const updateStore = sqliteTelegramUpdateStore({ database: new Database(env.UPDATES_DB) })

const intake = createTelegramUpdateIntake<Update>({
  store: updateStore,
  handle: (update) => bot.handleUpdate(update),
  onFailure: (failure) => logger.warn('Update failed', { ...failure }),
})

// start: set the webhook, then handle what was recorded before the restart
await bot.init()
await claimTelegramWebhook({ ...webhook, takeoverFrom: env.WEBHOOK_TAKEOVER_FROM })
await intake.start()

// the route
const route = (request: Request) =>
  receiveTelegramWebhook(request, { secret: webhook.secret, accept: intake.accept })

// stop admission: `await intake.close()` waits for the handlers in flight
```

A refusal names the owner's host, never its path — a foreign webhook's path may
itself be a secret — and says what to pass: set the takeover for one start and
remove it. `checkTelegramWebhook` on a timer notices a webhook that moved
elsewhere, which this process cannot see any other way.

**Moving to it from a claim of your own.** A bot that tagged its webhook itself
holds an address this one does not recognise, so the first claim is refused —
`other-secret` when the address is the same, `owned-elsewhere` otherwise — and
names its own host. Start once with `takeoverFrom` set to that host, then remove
it. The tag is derived from the secret with a fixed context, so it is the same
across stitchkit releases: that takeover is needed once per bot, not per
upgrade. A secret rotation is a new owner, and takes a takeover too.

**The update is recorded before Telegram is answered.** A handler that runs
longer than Telegram waits — a large file from a local Bot API server — gets the
same update again while it still works, and a process that answers and then
dies loses the update for good. `receiveTelegramWebhook` answers 200 once the
intake recorded the body; the handler runs after, outside the request. Updates
of one chat run in order, other chats alongside (`maxConcurrent`, 32). An
attempt holds a lease it renews while the handler lives; a sweep takes over what
was left — `pending` whose process never got to it (`pendingGraceMs`), `failed`
whose retry is due, `processing` whose process died. `start` schedules the whole
queue the last process left, page by page and without waiting for
`pendingGraceMs`, and an update accepted meanwhile takes its place behind it, so
a crash keeps each chat in order however long the queue was. The queue sits in
memory while it drains, as it did in the process that accepted it. `close`
waits for the handlers running and leaves the rest of the queue recorded. Order
holds inside one process for updates handled in their turn: the attempt a crash
interrupted comes when its lease lapses, a failed update at its retry and one
the store refused to claim at a later sweep, each after later updates of its
chat. An old release draining beside a new one shares its queue, so the two can
run updates of one chat side by side. A failure is retried with
backoff or after Telegram's `retry_after`; one Telegram said repeating cannot
fix (a refused message, a blocked user) is abandoned; `maxAttempts` (5) ends
the rest. Delivery is at least once: a handler that finished but could not be
recorded as finished runs again.

Use `handleAttempt` when the handler needs the immutable attempt fence and an
ownership-loss signal. A signal asks slow work to stop; the fence is what
authorizes a domain write. Check it through a transaction-bound reference store
inside the same database transaction as that write:

```ts
handleAttempt: async (update, { fence, ownerLost }) => {
  ownerLost.throwIfAborted()
  await database.transaction(async (tx) => {
    const transactionStore = postgresTelegramUpdateStore({
      query: (text, parameters) => tx.query(text, parameters),
      createTable: false,
    })
    if (!(await transactionStore.owns(fence, Date.now()))) return
    await applyDomainTransition(tx, update)
  })
}
```

The fence contains the claim's own `{ updateId, attempt, claimId }`. The opaque
`claimId` is persisted and never reused, so an old handler cannot adopt either
a newer attempt or a pruned and recreated `updateId`. Existing `handle(update)`
remains unchanged, including direct functions whose own optional second
argument has a different meaning.

For a final obligation, configure `handleExhaustion`. The reference store keeps
the terminal record unacknowledged until this handler resolves, including
across restart; a throw leaves it for the next sweep. Delivery is at least once,
so use the complete `{ updateId, attempt, claimId }` as an idempotency key in
the consumer database:

```ts
handleExhaustion: ({ updateId, attempt, claimId, update, error }) =>
  recordFinalFailureOnce({ key: `telegram:${updateId}:${attempt}:${claimId}`, update, error })
```

This reuses the update row and table. Without `handleExhaustion`, terminal
abandonment retains its previous behavior.

With grammY the handler is `bot.handleUpdate`, which wraps a middleware's error
in a `BotError`; the intake unwraps it, so `retry`, `onFailure` and the error
stored with the update are what the middleware threw — a `retry` that returns
`false` for the bot's own terminal error sees that error.

The base store remains the six atomic steps of `TelegramUpdateStore`; `due` is
paged, continuing strictly after `afterUpdateId`. A
`TelegramUpdateFencedStore` adds `claimOwned`, `renewOwned`, `owns` and
`settleOwned`; `TelegramUpdateDurableStore` adds the final-obligation methods.
Reference stores implement both, so the bot's own database holds the fence and
final obligation without a second queue:

| Store | Takes |
|---|---|
| `sqliteTelegramUpdateStore` | a `bun:sqlite` `Database` or `node:sqlite` `DatabaseSync` as it is |
| `postgresTelegramUpdateStore` | one `query(text, parameters)` over the client the bot already holds |
| `memoryTelegramUpdateStore` | nothing — tests, or a bot that accepts losing unhandled updates to a restart |

```ts
import { postgresTelegramUpdateStore } from 'stitchkit/telegram'

// Bun
postgresTelegramUpdateStore({ query: (text, parameters) => sql.unsafe(text, [...parameters]) })
// Prisma
postgresTelegramUpdateStore({
  query: (text, parameters) => prisma.$queryRawUnsafe(text, ...parameters),
  createTable: false, // the migration below owns the table
})
// pg
postgresTelegramUpdateStore({
  query: (text, parameters) => pool.query(text, [...parameters]).then((result) => result.rows),
})
```

Each rule is one conditional statement, so a claim is atomic across every
process sharing the table. By default the table is created on first use; where
migrations own the schema, `postgresTelegramUpdateStoreDdl(table)` is the
statement to put in one. Apply it before using `handleAttempt` or
`handleExhaustion`; it adds `claim_id` idempotently. Legacy `handle(update)`
uses base PostgreSQL operations that do not reference that column. SQLite adds
the column automatically and tolerates two rolling processes racing the
migration. A direct base-store claim with `durableExhaustion: true` also opts
into the column-backed durable capability.

A store of your own — over an ORM, another database — is put through the same
rules the shipped ones are, concurrent claims included:

```ts
import { checkTelegramUpdateStore } from 'stitchkit/telegram'

test('our update store keeps the rules', async () => {
  expect(await checkTelegramUpdateStore(() => ourStore(freshTable()))).toEqual([])
})
```

A store that reads and then writes in two statements passes every test with one
process and runs one update twice in production; the check races eight claims
against each other to catch it.

## Files from a local Bot API server

A local `telegram-bot-api` keeps downloaded files under `<dir>/<bot token>/`,
and a bot sharing that directory reads them from disk and deletes them when
done. `file_path` comes from a server over the network, so it is resolved only
inside the bot's directory — `../`, an absolute path elsewhere and a link
pointing out are refused, judged on real paths.

```ts
import { createTelegramLocalFiles } from 'stitchkit/telegram'

const files = createTelegramLocalFiles({ root: env.BOT_API_FILES_ROOT, token: env.BOT_TOKEN })

const { file_path } = await ctx.getFile()
const path = await files.resolve(file_path)   // throws TelegramLocalFileError
// … process it …
await files.remove(file_path)
```

The recommended variable for the root is **`BOT_API_FILES_ROOT`** — the
server's `--dir`, absolute, as the bot's process sees it. A relative `file_path`
(a server without `--local`) and an absolute one inside the bot's directory (a
server with `--local`) both resolve. A refusal carries a reason
(`root-not-absolute`, `bot-directory-unavailable`, `outside-bot-directory`,
`missing`, `not-a-file`) and never the path or the token. `files.check()`
answers whether the directory is there to read and delete from; a resource that
throws on `{ ready: false }` in `start` keeps the bot from answering before it
can read its media.

## Voice waveforms

A voice message carries its waveform: the bars under the play button, 100
levels of 5 bits. The public Bot API takes no waveform in `sendVoice`, so
Telegram draws its own. A local Bot API server that takes one says so in
`getMe` with `supports_voice_waveform: true` and `voice_waveform_version: 1`.

The waveform is computed from a decoded side copy of the recording. The file
being sent stays byte for byte what it was:

```ts
import { readTelegramVoiceWaveform } from 'stitchkit/telegram'
import { readTelegramVoiceWaveformSupport } from 'stitchkit/telegram/voice'

// ffmpeg -nostdin -i voice.ogg -map 0:a:0 -ac 1 -ar 8000 -f s16le wave.pcm
const waveform = await readTelegramVoiceWaveform(pcmPath, { signal })

if (!readTelegramVoiceWaveformSupport(await bot.api.getMe()).supported) {
  throw new Error('this Bot API server draws its own waveform')
}
const options = { duration, waveform } satisfies Parameters<typeof bot.api.sendVoice>[2] & {
  waveform: string
}
await bot.api.sendVoice(chatId, new InputFile(oggPath), options)
```

The levels follow Telegram Desktop. Each of the 100 parts keeps its loudest
sample, and the scale is 1.8 times the mean of those peaks, never below 2500
of 16-bit PCM. A loud passage does not flatten the quiet ones to nothing, and
a quiet recording is not stretched to look loud. Silence stays at zero. The
PCM is read in chunks, so a long recording is never held in memory; at 8 kHz,
six hours of audio is under 350 MB of PCM. A file with no sample or one cut
inside a sample is refused with `TelegramVoiceWaveformError` (`empty-pcm`,
`truncated-pcm`), and the waveform is never made up.

Whether a server that does not declare support still gets the voice is the
bot's decision. It can refuse to send, or send without the field and let
Telegram draw the bars. `readTelegramVoiceWaveformSupport` reads any answer:
`supported` means version 1, and `version` is what the server declared, or
`null` when it declared nothing.

`stitchkit/telegram/voice` has no peer and touches no file, so a page drawing
the bars reads the same format: `unpackTelegramVoiceWaveform(waveform)` gives
the levels `0`–`31`, 100 for a waveform packed here and as many as it holds
for one Telegram drew itself. `packTelegramVoiceWaveform(peaks)` packs 100
peaks already found by other means.
