---
title: "ADR 0211: Telegram screens are declared views over grammY"
description: "A bot menu is a tree of declared screens whose views are reconciled against what the chat shows; it is middleware over the bot's own ctx.api and a grammY StorageAdapter, not an engine; navigation is the path tree; a press is trusted only if the pressed message carries it; the record is written after Telegram answers and the last write wins."
type: decision
status: accepted
created: 2026-09-28
updated: 2026-09-28
---

# ADR 0211 — Telegram screens are declared views over grammY

## Context

Every bot with a menu writes the same layer on top of its bot library: a router
from `callback_data` to a handler, a packer that fits a route and its arguments
into 64 bytes, code that edits the right message or sends a new one, a way to
wait for the next message, and a place to remember which messages the menu
occupies. In the consuming project that prompted this decision the layer was a
hand-written router of about 900 lines, and each screen still did part of the
work itself. The measured failures were the ones this layer invites:

- navigation state lived in process memory, so a release lost the menu's
  message ids and every "waiting for input" — a user's reply after a deploy went
  nowhere;
- buttons carried only a route: their arguments were lost, a button's action was
  packed as a placeholder, the 64-byte limit was checked by a log line at run
  time, and an outdated button could not be told apart;
- screens bypassed the router to edit their own messages, found a header by the
  convention "header id = body id − 1", and deleted error messages on a
  `setTimeout` that did not survive a restart;
- keyboards and loader data were `any`, `parse_mode` was patched onto the API
  client, and every screen read "message is not modified" and "message can't be
  edited" its own way.

grammY's plugins cover parts of this and not the whole. `@grammyjs/menu` is the
keyboard of one message, with string payloads and a render from `ctx`: no
screen of several messages, no typed params, no input. `@grammyjs/conversations`
is a replay engine in which every side effect has to be wrapped in
`conversation.external()`, which sits badly with application services that
already own their effects.

## Decision

**`stitchkit/telegram/screens` declares a bot's menus as screens and reconciles
their views against the chat.** A screen is a path, an optional load, actions,
input handlers and a pure view. The view says what the chat should show; a pure
reconciler compares it with the chat's record by message key and plans the
fewest calls — keep, edit the part that changed, or send and delete — keeping
the messages' order. An executor carries the plan out and absorbs the three
refusals a live chat produces ("not modified" is success; a message gone is sent
again with those after it; an undeletable message loses its buttons). Any other
refusal stops the update, and the transition does not happen: the record stays
on the screen the chat was on and lists every message the chat now shows, in
the chat's order.

**It is middleware over what the bot already has, not an engine (I5).** It
calls the bot's own `ctx.api`, stores through grammY's `StorageAdapter`, and
passes every update it does not own to `next()`. grammY is named in the
declarations and never imported at run time, so the entrypoint is an isolated
subpath leaf whose bundle stays free of it (I7), proven on the packed artifact
by the optional-peer matrix on Bun and Node.

**Navigation is the path tree.** A screen's parent is the nearest declared
screen whose path is a prefix of its own; `back` goes there. There is no history
stack to grow, to lose on restart or to disagree with the chat. A group shares a
path prefix, a params schema and a load that runs before every screen, action
and input under it — the one place access is checked, because params come from
a button and are user input. A screen with a param no load sees — none above
it, or one added below the last — is refused when the bot is composed. Input is
deleted before any load runs: it may be a secret, and a load may redirect or
fail.

**A press is trusted only as far as Telegram vouches for it (I12).** Telegram
sends the pressed message with its keyboard; `callback_data` that is not on that
keyboard was sent, not pressed, and never reaches a handler. What remains is
still parsed by the params and input schemas. Buttons carry typed values in a
compact codec; data past 64 bytes is kept in the record behind a random token.

**State is one small record per chat in a grammY `StorageAdapter`,** not the
application's `StateStore` or a keyspace: it is a single value per key, read and
written whole, with no need for watched reads or holding every chat in memory.
It never holds message text or input. It is written after Telegram answers, so
it never names a message that was not sent; a crash in between leaves the chat
ahead of its record, and the next press is handled as a press on a message the
record does not know. Updates of a chat are serialised within a process through
a bounded queue (I10); two processes on one chat are not coordinated, and the
last write wins.

**It lives in the `telegram` part.** The part's rule stays: it imports only
`internal`, and grammY only as types — a test holds both.

## Consequences

- A bot's menu code becomes declarations: the same screens a hand-written
  router needed ~900 lines to carry are typed end to end, from the path literal
  to `link` arguments and action inputs, and a missing param is a compile error.
- Deleting a user's input before its handler, pending messages, expiring
  remarks and "one live menu per chat" are behaviours of the library rather
  than conventions each screen reimplements.
- Reply keyboards, inline mode, media uploads and a history stack are out of
  scope; a screen is shown only in answer to an update (a notification carries
  `screens.button(link(…))` instead).
- A chat served by two processes at once can see a stale record; the next
  update repairs it. Serialising across processes would need a lock the
  application does not otherwise have, and is not taken on here.
- The entrypoint starts evolving (ADR 0103, ADR 0198).
