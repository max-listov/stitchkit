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
| text for Telegram's HTML: cleaned, cut to the limit, checked | `stitchkit/telegram/html` — [below](#message-markup) |
| the process journal | `createJsonLogger` from `stitchkit/observability` |
| the operator's chat: product events, apart from the journal | `createTelegramOperatorChannel` |
| a broadcast that survives crashes, deploys and Ctrl-C | `runTelegramBroadcast` |
| a file the local Bot API server wrote to disk | `createTelegramLocalFiles` |
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

## The operator channel

The chat where people read about new users, payments and failures is not the
journal. The journal must not lose a line to a slow network; the chat must not
slow the bot down. `post` returns at once and never throws; sends are paced
below Telegram's per-chat limit (one every 3 s by default), 429s wait the time
Telegram named, and when the chat cannot keep up the oldest message is dropped
and reported.

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

Without `classify`, known Bot API 429, unreachable-recipient, malformed-message
and server-error behavior remains. Unknown/no-status failures now halt as
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

## Message markup

`stitchkit/telegram/html` is Telegram's HTML parse mode as a tree, with no peer
and no DOM, so a server sending a message and a browser previewing it share one
parser. Text written by someone else — a model, an editor, an owner's greeting —
becomes markup Telegram accepts: synonyms renamed (`strong` → `b`), block tags
turned into line breaks, a link kept only with an `href` Telegram opens,
anything Telegram forbids (a tag it does not know, formatting inside `code`, a
quote inside a quote) left as its words.

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
again, attributes and all, in the next. `truncateTelegramHtml` keeps one part
with an ellipsis; `telegramHtmlText` is what the reader sees; `parseTelegramHtml`
gives the nodes to render a preview or an email from. `checkTelegramHtml` says,
without repairing anything, what Telegram would refuse — for an editor that
should warn a person rather than change their text.

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

const intake = createTelegramUpdateIntake<Update>({
  store: sqliteTelegramUpdateStore({ database: new Database(env.UPDATES_DB) }),
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
whose retry is due, `processing` whose process died. A failure is retried with
backoff or after Telegram's `retry_after`; one Telegram said repeating cannot
fix (a refused message, a blocked user) is abandoned; `maxAttempts` (5) ends
the rest. Delivery is at least once: a handler that finished but could not be
recorded as finished runs again.

With grammY the handler is `bot.handleUpdate`, which wraps a middleware's error
in a `BotError`; the intake unwraps it, so `retry`, `onFailure` and the error
stored with the update are what the middleware threw — a `retry` that returns
`false` for the bot's own terminal error sees that error.

The store is an interface of six atomic steps (`TelegramUpdateStore`), so the
bot's own database holds it:

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
migrations own the schema, `postgresTelegramUpdateStoreSchema(table)` is the
statement to put in one.

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
