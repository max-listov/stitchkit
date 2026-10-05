# Telegram screens

`stitchkit/telegram/screens` turns a bot's menus into declared screens. A screen
says what the chat should show — a message or several, with their buttons — and
the runtime decides what to send, what to edit in place and what to delete. It
is grammY middleware: it answers the presses and messages that belong to a
screen and hands every other update to the next handler. Why it is shaped this
way: [ADR 0211](../decisions/0211-telegram-screens-are-declared-views-over-grammy.md).

```bash
bun add grammy zod
```

grammY is the bot's own; screens use its `ctx.api` and name its types, and
nothing imports grammY at run time.

## A menu, end to end

A bot that lets its owner manage projects: a list, a project's page, a
two-message greeting screen and a screen that waits for the new greeting.

```ts
import { back, html, link, telegramScreens } from 'stitchkit/telegram/screens'
import { z } from 'zod'

export const tg = telegramScreens<BotContext>()

export const home = tg.screen('/')
  .load((c) => listProjects(c.ctx.from?.id))
  .view(({ data: projects }) => ({
    text: html`<b>Your projects</b>`,
    keyboard: [
      ...projects.map((project) => [link(project.name, projectPage, { projectId: project.id })]),
      [link('➕ New project', newProject)],
    ],
  }))

// A group shares a path prefix, a params schema and a load. The load runs
// before every screen under it — its load, its actions, its input — and is
// where access is checked: params arrive from a button, so they are input.
const owned = tg.group('/project/:projectId', { params: z.object({ projectId: z.uuid() }) })
  .load(async (c) => {
    const project = await findProject(c.params.projectId)
    return project?.ownerId === c.ctx.from?.id ? project : c.go(home).toast('Project not found')
  })

export const projectPage = owned.screen('/')
  .action('archive', async (c) => {
    await archiveProject(c.data.id)
    return c.toast('Archived').go(home)
  })
  .view(({ data: project, params, act }) => ({
    text: html`📁 <b>${project.name}</b>\n\nStatus: ${project.status}`,
    keyboard: [
      [link('👋 Greeting', greeting, params)],
      project.status === 'active' && [act.archive('🗄 Archive')],
      [back('« Back')],
    ],
  }))

export const greeting = owned.screen('/greeting')
  .action('clear', (c) => clearGreeting(c.data.id))       // nothing returned: stay, redrawn
  .action('rule', z.object({ every: z.boolean() }), (c) => setRule(c.data.id, c.input.every))
  .view(({ data: project, params, act }) => project.greeting
    ? [
        { key: 'header', text: html`<b>New members receive ↓</b>` },
        {
          text: project.greeting,                              // a plain string is escaped
          keyboard: [
            [link('✏️ Edit', greetingEdit, params), act.clear('🗑 Clear')],
            [act.rule(project.every ? 'Every message' : 'First message only', { every: !project.every })],
            [back('« Back')],
          ],
        },
      ]
    : { text: html`🗑 <b>No greeting.</b>`, keyboard: [[back('« Back')]] })

export const greetingEdit = owned.screen('/greeting/edit')
  .on('text', async (c) => {
    if (c.text.length < 3) return c.notice(html`❌ Too short`, { expiresInMs: 5_000 })
    await c.pending('⏳')
    await saveGreeting(c.data.id, c.text)
    return c.notice(html`<blockquote>✅ Greeting saved</blockquote>`).back()
  })
  .view(() => ({ text: html`📝 Send the new greeting ↓`, keyboard: [[back('« Back')]] }))
```

```ts
// bot.ts
const screens = tg.create({
  screens: [home, projectPage, greeting, greetingEdit],
  storage: myStorageAdapter,      // any grammY StorageAdapter
})
bot.use(screens)
bot.command('start', (ctx) => screens.open(ctx, home))
bot.catch((error) => logger.error('update failed', { error }))
```

## The model

- **A screen** is a path, an optional `load`, any number of `action` and `on`,
  and a `view`. `load` comes first or not at all — actions and input read what
  it returned — and `view` ends the declaration.
- **Params** come from the path literal: `/project/:projectId` gives
  `params.projectId`. A group's or screen's `params` schema parses them (a
  `z.coerce.number()` makes a number). The schema must accept what it produces,
  because a button carries the parsed value and the schema parses it again when
  it is pressed: `z.coerce.number()` does, `z.string().transform(Number)` does
  not and is a compile error. A `link` to a screen whose path has params must
  carry them; a link to a screen without params takes none — both are compile
  errors.
- **The parent** of a screen is the nearest declared screen whose path is a
  prefix of its own, by segments. `back()` and the `back('« Back')` button go
  there. There is no history stack: navigation is a tree of paths, so it
  survives a restart and never grows.
- **`load`** returns data, or an outcome instead of data — `c.go(home).toast('…')`
  shows another screen. A chain of such redirects stops after four steps.
- **`view`** is a pure function of `ctx`, `params`, `data` and `act`. It returns
  one message or several. A message has exactly one content — `text`, `rich`
  (a Bot API rich message), or a media file id or URL (`photo`, `video`,
  `animation`, `document`, `audio`) with an optional `caption` — plus
  `keyboard`, `key` and, for text, `linkPreview`. Rows and buttons may be
  `false`, `null` or `undefined`, so a conditional button is `cond && [...]`.
- **Text** is a string, which is always escaped, or a `TelegramHtml` from the
  `html` tag, whose interpolations are escaped. `html.raw(markup)` marks markup
  that is already safe and `html.join(parts, separator)` joins pieces. Every
  message is sent with `parse_mode: 'HTML'` set explicitly, so an application's
  own `parse_mode` transformer changes nothing.

## Outcomes

A load, an action and an input handler answer with an outcome, built by
chaining; returning nothing is `stay()`.

| Builder | Does |
|---|---|
| `c.stay()` | show this screen again, with fresh data |
| `c.go(screen, params?)` | show another screen |
| `c.back()` | show the parent screen |
| `c.toast(text, { alert? })` | answer the press — up to 200 characters; the last toast wins |
| `c.notice(content)` | a receipt that stays: posted, and the screen moves below it |
| `c.notice(content, { expiresInMs })` | a remark under the screen that removes itself — `expiresInMs` up to 2³¹ − 1, a timer's limit |

A remark is removed when its time comes, on the chat's next update after that,
before anything new is sent into the chat and when the chat leaves its screen —
so a screen is never split by a remark. A chat keeps at most 100 remarks; the
oldest is removed to make room for the next. After a message there is no press
to answer, so an input handler has no `toast`.

## What the chat shows: reconciliation

Each message of a view has a key: `key` when given, otherwise `'main'` for the
last message and `s0`, `s1`, … for the ones before it. Between two views,
messages with the same key are the same message, and only what changed is
edited:

| From → to | Call |
|---|---|
| nothing changed | none |
| only the keyboard | `editMessageReplyMarkup` |
| text → text, rich → rich | `editMessageText` |
| text or rich → media, media → media | `editMessageMedia` |
| a caption | `editMessageCaption` |
| media → text or rich, text ↔ rich | delete and send |

Order holds: once a message has to be sent, every message after it is sent
too, and a message is deleted only after its replacement is in the chat. So
"header + body" → "body" edits the body in place and deletes the header, and
the reverse sends both and deletes the old body.

When Telegram refuses a step:

- **"message is not modified"** is success.
- **A message gone or not editable** — deleted by the user, too old — is sent
  again with every message after it.
- **A deletion refused** (Telegram deletes only messages younger than 48 hours)
  strips the message's buttons instead and reports it as `message-kept`. A
  message the user already deleted counts as deleted.
- **Anything else** — a rate limit, a network failure, HTML Telegram cannot
  parse — stops the update, and the transition does not happen: the record stays
  on the screen the chat was on, so its input still answers, and lists every
  message the chat now shows, in the chat's order, with the buttons of both
  renders. The next update repairs the rest. A receipt or a remark Telegram
  refuses stops the update the same way, with the view already drawn recorded.

A view is checked before anything is sent: at most 100 messages, keys of 1 to
64 characters, at most 100 buttons whose address is kept in the record. A view
past these fails in the handler's place, with the chat untouched.

## Buttons and presses

A screen button's `callback_data` is
`‹prefix›‹screen id›[.‹action›](:‹param›)*(:‹key›=‹value›)*`. Values are typed,
a UUID takes 24 bytes, and data that would pass Telegram's 64 bytes is kept in
the chat's record behind a token derived from it — the same button renders the
same token, so an unchanged keyboard is never edited. A screen's id is a
short hash of its path, or its explicit `id` — give one to a screen whose path
may change, so buttons already in chats keep working.

A press is answered exactly once, after the outcome is known and before the
chat is edited. It is trusted only as far as Telegram vouches for it: the
`callback_data` must be on the keyboard of the message it came with, otherwise
the press was forged (a client can send any bytes) and goes to `onStale`.

A press on a message the record does not know — an older menu higher up — is
answered in place: a one-message view takes that message over, a longer view is
sent below it and the pressed message is deleted. Either way the recorded
view is removed: one live menu per chat.

For a message the screens do not own — a notification from the backend —
`screens.button(link('🔑 Refresh token', refreshToken, { botId }))` makes a
button that opens the screen below and leaves the notification as it is.

## Input

`.on(kinds, handler, { keepMessage? })` takes a message while the screen is
shown. Kinds: `text`, `rich`, `photo`, `video`, `animation`, `document`,
`audio`, `voice`, `video_note`, `sticker`, `location`, `contact`. A screen may
have several `.on`; a message of a kind no `.on` takes, and every command
(`/start`), go to the next handler.

The user's message is deleted **before** any load or the handler runs — input
can be a secret, such as a bot token, and a load may redirect or fail — unless
`keepMessage: true`; then the view is sent below the message. A message for a
screen whose record cannot be read is not passed on to the next handler: the
update fails, and `onError` decides. `c.pending(text)` shows a "working on it" message that is
removed when the handler ends, however it ends. `c.message` is the message as
Telegram sent it; it is never stored.

## Opening a screen

`screens.open(ctx, screen, params?, { previous })` shows a screen as a new
message at the bottom of the chat, from a command, a deep link or a handler.
The previous view stays (`'keep'`, the default) or is deleted (`'delete'`).
Called from inside a handler of the same chat, it runs at once rather than
waiting behind the update that called it, and the screen it opened stands: the
handler may still answer the press with a toast, and returning a navigation or
a notice as well is an error — drawn after it, the handler's own outcome would
put the record back on the screen the chat left.

## State and concurrency

One record per chat, in any grammY `StorageAdapter<ScreenChatState>`, under
`screens:<chat id>` by default (`chatKey` changes it; it never collides with a
grammY session). It holds the shown screen, its params, message ids with
fingerprints of their content, overflow tokens and expiring remarks — never
message text or input. A record from another schema version is set aside
(`state-discarded`); a storage failure is an update failure.

Updates of one chat are handled one at a time within a process. Two processes
serving one chat — releases overlapping, a webhook fan-out — are not
serialised: the last write wins. The record is written after Telegram answers,
so it never names a message that was not sent — and it is written when Telegram
refused halfway too.

## Configuration

| Option | Default | Does |
|---|---|---|
| `screens` | — | the declared screens; ids, paths and access are checked at `create` |
| `storage` | — | where each chat's record survives a restart |
| `chatKey` | `screens:<chat id>` | the storage key of a chat's record |
| `callbackPrefix` | `~` | what every screen button's `callback_data` starts with |
| `chats` | `'private'` | `'all'` answers in groups too, where any member can press or type |
| `onStale(c)` | answered silently | a press nothing can answer, with its `reason`; its outcome is shown |
| `onError(error, c)` | none | a load, action or input that threw; its outcome is shown |
| `onEvent(event)` | none | `transition`, `state-discarded`, `message-kept`, `sweep-failed` (a remark's timer could not delete it) — never message text |
| `clock` | `Date.now` | the time expiring remarks are measured by |

Without `onError` the press is answered silently and the error reaches
`bot.catch` — which a bot must set. `screens.close()` cancels pending expiry
timers on the way down; a remark left behind is removed on the chat's next
update.

## Security

- **A group's `load` checks access** for every screen, action and input under
  it. A param added below the last load is unchecked until a load of its own
  runs: `create` refuses a screen whose params no load sees.
- **Never `html.raw(c.text)`** — or anything else a user wrote. `html` escapes
  interpolations; `raw` is for markup the application built.
- Private chats only by default: in a group anyone could press an owner's menu.
- A forged `callback_data` never reaches a handler; params and action input
  still go through their schemas.

## Testing

`createScreenTestChat(bot)` takes the application's own `Bot` — its middleware,
commands and error boundary in their real order — and answers its Bot API calls
from memory. Updates go through `bot.handleUpdate`, and an error reaches
`bot.catch` as it does under long polling.

```ts
import { Bot, MemorySessionStorage } from 'grammy'
import { createScreenTestChat } from 'stitchkit/telegram/screens'

const chat = createScreenTestChat(makeBot(new MemorySessionStorage()))
await chat.send('/start')
await chat.press('Alpha')
expect(chat.messages.at(-1)?.text).toBe('📁 <b>Alpha</b>')
expect(chat.calls.map((call) => call.method)).toEqual(['sendMessage', 'answerCallbackQuery', 'editMessageText'])
```

It keeps the Telegram rules screens depend on — an edit that changes nothing is
"not modified", a deleted message cannot be edited, HTML it cannot parse, text
past 4096 characters, a caption past 1024 and `callback_data` past 64 bytes are
refused — and offers `failNext` to
refuse a call, `deleteByUser`, `pressData` for a forged press and
`restart(bot)` for a new process over the same storage.

## Not included

Reply keyboards, inline mode, media uploads (`InputFile`) in a view, showing a
screen without an update (use `screens.button` in a notification), converting
an incoming message to HTML, and a history stack.
