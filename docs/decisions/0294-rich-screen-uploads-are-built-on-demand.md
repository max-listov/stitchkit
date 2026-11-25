---
title: "ADR 0294: Rich screen uploads are built on demand"
description: A versioned factory lets grammY upload a file while screen reconciliation compares a small, stable fingerprint.
type: decision
status: accepted
amends: ["0211"]
created: 2026-11-18 08:39 +07:00
updated: 2026-11-18 10:01 +07:00
---

# ADR 0294 — Rich screen uploads are built on demand

Amends the media-upload clause of ADR 0211. Serves **I5**, **I7** and **I8**.

## Context

A Telegram screen can contain a photo that the bot can read locally. Telegram
can refuse to fetch the same photo by URL. grammY accepts its own `InputFile`
in the rich payload for both `sendRichMessage` and `editMessageText`. An
`InputFile` can hold a one-shot stream. Inspecting that stream to compare two
views would consume the input before grammY could send it.

## Decision

A view message may be `richUpload: { contentKey, build }` — a content of its
own beside `text`, `rich` and the media kinds, so `rich` keeps the Bot API's
inline type and code that reads or rewrites it is untouched. The application supplies a
stable revision for the entire rich payload and constructs fresh grammY input
in `build`. The planner fingerprints the revision. The executor calls the
factory when it needs to send or edit content, including a replacement send
after Telegram refuses an edit. grammY handles multipart encoding.

## Consequences

The same revision survives a process restart through the chat's existing
fingerprint. Applications must change the revision when rich text, media or
their order changes. A keyboard edit needs no file. `rich` objects with
URLs or Telegram file IDs retain their existing comparison and JSON transport.
A second form inside `rich` was refused: a union there stops compiling the
code that spreads or reads an inline rich message.
