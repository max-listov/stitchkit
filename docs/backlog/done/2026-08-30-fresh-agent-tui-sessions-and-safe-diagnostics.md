---
title: Fresh Agent TUI sessions and safe diagnostics
description: Make a normal terminal launch start clean, keep durable history behind explicit resume, and record metadata-only lifecycle evidence.
type: task
status: done
created: 2026-08-30
updated: 2026-08-30
completed: 2026-08-30
---

# Fresh Agent TUI sessions and safe diagnostics

## Problem

The terminal host defaults every launch to the durable conversation named `main`. The `/clear`
command only hides the current viewport, so the next provider request still receives the previous
durable history. A fresh-looking terminal can therefore continue an unrelated earlier instruction.

The local JSONL diagnostic file records runtime payloads rather than a bounded metadata projection,
and it does not record host launch, conversation switches or clear semantics. It is simultaneously
too revealing and insufficient for reconstructing this lifecycle bug.

## Desired result

- A normal launch creates a fresh durable conversation with a collision-resistant identity.
- `initialConversationId` remains an explicit embedding-host override.
- `/clear` starts a fresh durable conversation without deleting the old one.
- `/resume` and `/sessions` are the only interactive paths back to durable conversations and keep
  using the existing conversation picker.
- The local TUI journal records launch, submit, conversation transition, run and close metadata
  without prompt text, reasoning text, tool arguments, provider causes or credentials.
- A bounded file policy prevents the diagnostic journal from growing forever.
- Regression coverage proves fresh launch identity, clear isolation, explicit resume routing and
  safe diagnostic projection.

## Acceptance

- [x] Two default launch resolutions produce different conversation identifiers.
- [x] An explicit initial conversation identifier is preserved.
- [x] `/clear` switches the controller and session descriptor to a new conversation.
- [x] `/resume` opens the durable conversation picker and selection restores the chosen identity.
- [x] Diagnostic records contain enough identifiers and transitions to reconstruct the incident.
- [x] Diagnostic records contain no user/model text, tool input or internal provider cause.
- [x] Targeted Bun tests and the full repository gate pass.

## Что сделано

- Normal launch now derives a collision-resistant conversation identity; an explicit
  `initialConversationId` remains authoritative.
- `/clear` switches both the runtime controller and local session descriptor to a fresh durable
  conversation. `/resume` and `/sessions` retain the existing bounded picker over old history.
- Each terminal host writes a rotating, mode-`0600`, per-session metadata journal. Runtime output,
  reasoning, prompt text, tool input, provider causes and credentials are removed before admission;
  live journals and the eight newest inactive session journals are retained.
- A real starter launch and real `/clear` input verified fresh identity, descriptor convergence and
  the exact `host-started` → `conversation-changed(reason: clear)` journal transition.

## Регрессия

- `packages/tui/tests/run.test.ts` — `creates a fresh conversation by default`; `preserves an
  explicit embedding-host conversation`.
- `packages/tui/tests/commands.test.ts` — `makes clear start clean and keeps old history behind
  explicit resume`.
- `packages/tui/tests/session.test.ts` — `routes authenticated external submissions through the
  live host`.
- `packages/tui/tests/diagnostics.test.ts` — `projects runtime transitions without text, tool input
  or internal causes`; `writes a bounded schema-validated lifecycle journal per terminal session`.
- `bun run verify` — full repository gate green after implementation.
