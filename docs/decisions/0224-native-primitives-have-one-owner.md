---
title: "ADR 0224: Общие IO primitives имеют одного владельца"
description: Files расширяется явно, canonical JSON сохраняет bytes, команды используют нейтральный механизм, retry требует recipient authority.
type: decision
status: active
created: 2026-10-01 20:44 +07:00
updated: 2026-10-01 21:03 +07:00
participants:
  - role: authored
    harness: Codex
    model: GPT-6
    at: 2026-10-01 20:44 +07:00
---

# ADR 0224 — Общие IO primitives имеют одного владельца

## Решение

Files atomic/managed writers используют единый publication owner. Default atomic file fsync
сохраняется; directory durability и create без overwrite выбираются явно. Post-publication error
несёт published=true. Managed read получает opt-in leaf/link/stability checks и observed metadata;
trusted ancestors не превращаются в hostile containment от дополнительных path checks.

Canonical JSON production API принадлежит primitives и делегирует existing serializer. Общая
plain-JSON validation переиспользуется durability и canonical boundary. UTF-16 sort и ручная сборка
members сохраняют historical digest bytes; strict public boundary имеет finite depth/nodes/bytes.

Конечные native commands принадлежат нейтральному process owner. Agent-runtime адаптирует его
через существующую sandbox policy с mandatory limits. Новый process entrypoint начинает evolving.
Binary IO, environment policy, streaming caller lifetime и bounded cleanup объявлены явно. Native
leaf не становится supervisor/PTY и не обещает убить descendants, покинувших POSIX группу.

## Внешние эффекты

Append-before-run и process-local in-flight не являются межпроцессным atomic claim. Existing
local-step durability требует caller-owned execution lease и сохраняет sticky uncertain. Existing
domain-event outbox даёт application-owned atomic claim и delivered/retryable/terminal/unknown;
это иной protocol, который не заменяет indexed receipt store и recipient reconciliation автоматически.

Hash отсутствия, timeout, missing local row или null не доказывают, что старый recipient request
не завершится позже. Общий verified-absence retry отклонён без recipient-side fence либо стабильной
idempotency capability. Не создаётся второй delivery engine и не расширяется at-most-once promise.
Reconcile должен освобождать caller await на abort/deadline и игнорировать поздний результат.
