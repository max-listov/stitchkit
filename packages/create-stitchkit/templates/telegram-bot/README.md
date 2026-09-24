# Stitchkit Telegram Bot

A long-polling Telegram bot assembled from Stitchkit primitives. The product is
`src/handlers.ts`; everything else is the assembly every bot needs and none
should write again.

## Start

```bash
cp .env.example .env
# Fill BOT_TOKEN.
bun run dev
```

## Shape

- `src/handlers.ts` — the product: commands, messages, what goes to the operators' chat.
- `src/application.ts` — the resource graph: `database` → (`telegram-files`) →
  (`operator-channel`) → `telegram-configuration` → `telegram-polling`. Queues, an
  HTTP server for payment webhooks, schedules and metrics go between the database
  and the bot.
- `src/index.ts` — the entry point: environment, journal, signals, and the one
  policy for a poller that ended on its own (shut down, exit 1, let the supervisor
  restart).
- `src/runtime-bindings.ts` — where a deployment platform's state publisher is
  attached, without the bot importing it anywhere else.
- `src/log.ts` — the journal: one JSON line per event, `"level":50` is an error.
- `tests/application.test.ts` — the whole life of the bot against a stand-in for Telegram.

Updates are admitted by batch: nothing is fetched while the application is not
ready, and a batch taken before a stop is finished before the offset is
confirmed, so a restart neither loses nor repeats an update.

## Commands

```bash
bun run check   # types
bun run lint
bun test
bun run build   # dist/index.js, started by `bun run start`
```
