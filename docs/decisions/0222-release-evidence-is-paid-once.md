---
title: "ADR 0222: Кандидат релиза платит за доказательство один раз"
description: "Полный exact-SHA CI разрешает публикацию; локальный кандидат проходит fast gate, а полный локальный результат отдельно подтверждает fast subset."
type: decision
status: active
created: 2026-10-01 15:43 +07:00
updated: 2026-10-01 15:43 +07:00
participants:
  - role: authored
    harness: Codex
    model: GPT-6
    at: 2026-10-01 15:43 +07:00
---

# ADR 0222 — Кандидат релиза платит за доказательство один раз

## Решение

Кандидат отправляется в `release/X.Y.Z` после metadata preflight и fast gate.
Полный набор selected CI lanes проверяет точный SHA до fast-forward master и tag.
Полный portable local gate остаётся диагностическим инструментом и защищает
непроверенный прямой release push в master.

Зелёный полный или выбранный release gate сохраняет отдельную fast-attestation,
только если выполнил каждый fast step, включая frozen-lockfile install. Ключ fast
содержит tree/runtime; ключ heavy evidence также содержит PostgreSQL/browser
environment. Смена окружения не отменяет доказательство lint/types/tests, но
никогда не позволяет переиспользовать heavy evidence другого окружения.

Core publication artifact собирается один раз через существующий `prepack`.
Все проверки сборки и реальная Darwin qualification сохраняются. Tag workflow
публикует immutable artifact успешного exact-SHA push CI.

## Почему

Последовательный полный локальный прогон перед тем же полным CI повторяет
portable evidence. Release branch допускает исправление красного кандидата
до публикации; отдельный локальный heavy прогон не меняет publication authority.
Неполный fast subset и несовпадающие fingerprints не являются доказательством
для пропуска fast gate.

## Границы

Privacy scan выполняется при каждом push. Красный CI, другой SHA, отсутствующий
artifact и несовпадающие опубликованные bytes запрещают подтверждение релиза.
Полный local gate доступен явно; CI coverage, OIDC и protected publication
environment не ослабляются. Время upload acceptance и реальной npm availability
измеряется отдельно; сокращение опроса не ускоряет обработку реестром.

Serves P.
