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
| the process journal | `createJsonLogger` from `stitchkit/observability` |
| the operator's chat: product events, apart from the journal | `createTelegramOperatorChannel` |
| a broadcast that survives crashes, deploys and Ctrl-C | `runTelegramBroadcast` |
| a file the local Bot API server wrote to disk | `createTelegramLocalFiles` |
| why a send was refused | `classifyTelegramSendFailure` — [auth and errors](auth-and-errors.md#telegram-mini-apps) |
| Mini App `initData` | `verifyTelegramInitData` — [auth and errors](auth-and-errors.md#telegram-mini-apps) |
| one Bot API call without a bot library | `callTelegramBotApi` |

## The journal

A bot's journal is `createJsonLogger`: one JSON object per line on standard
output, in pino's shape — numeric `level` (`debug` 20, `info` 30, `warn` 40,
`error` 50), `time` in epoch milliseconds, `msg` — so `pino-pretty` reads it on
a terminal and a supervisor matching `"level":50` sees errors. Unlike pino, an
`Error` under *any* key is written with its name, message, stack and cause; an
error logged as `{ error }` does not become `"error":{}`.

```ts
import { createJsonLogger } from 'stitchkit/observability'
import { TELEGRAM_BOT_TOKEN_PATTERN } from 'stitchkit/telegram'

export const logger = createJsonLogger({
  level: env.LOG_LEVEL,
  fields: { service: 'my-bot' },
  sensitiveUrlPatterns: [TELEGRAM_BOT_TOKEN_PATTERN],
})

logger.error('Application startup failed', { error })
```

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
path — plus any `sensitivePatterns` the bot adds; `telegramOperatorSender` also
masks its own exact token. What to post stays the bot's. On the way down, drain it within the grace period
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
  so the run after the fix reaches them. So does Telegram being unreachable.
- **Pacing** is `ratePerSecond`, 25 by default. `dryRun` counts and writes
  nothing. One runner per name: a second concurrent run is refused.

The same call works from a script (the process's signal) and inside a live
application (the application's signal, with admission held by the caller).
The recipient state contains Telegram ids: keep it in the state directory, out
of git.

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
