---
title: "ADR 0223: Unit tests кандидата проверяет обязательный CI"
description: Структурный preflight release branch не повторяет unit tests и не выдаёт fast attestation.
type: decision
status: active
created: 2026-10-01 16:40 +07:00
updated: 2026-10-01 16:40 +07:00
participants:
  - role: authored
    harness: Codex
    model: GPT-6
    title: Stitchkit
    at: 2026-10-01 16:40 +07:00
---

# ADR 0223 — Unit tests кандидата проверяет обязательный CI

## Решение

Для release commit в remote release branch pre-push оставляет metadata, privacy,
frozen lockfile, lint и types. Все unit tests и selected lanes выполняет полный
exact-SHA push CI; только зелёное доказательство разрешает master/tag/npm.
Обычный push сохраняет fast gate, непроверенный прямой master — полный gate.
Смешанный push с обычной веткой не получает облегчённый профиль.

Candidate record называется `verify:candidate` и не является доказательством
`verify:fast`: в нём нет tests. Full/release fast-attestation по ADR 0222 сохраняется
только после полного fast subset. Полные diagnostic commands остаются доступными.
Это уточняет локальный candidate профиль ADR 0222, остальные его решения действуют.

## Причина и границы

Настоящие выпуски показали около 95s повторного локального test этапа перед теми
же обязательными тестами CI. Перенос этого этапа в единственный обязательный CI
не сокращает publication coverage. Другой SHA, PR-run и красный/отменённый CI
не разрешают публикацию. Protected npm OIDC, pins, privacy, native qualification
и проверка опубликованных bytes не меняются. Очереди GitHub/npm остаются измеряемым
внешним ожиданием; локальная экономия не является гарантией их длительности.

Serves P.
