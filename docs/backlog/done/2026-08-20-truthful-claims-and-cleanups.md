---
title: "Честность формулировок и мелкие хвосты батча"
description: Пять доков без completed, необъявленное сужение path-параметров, имя теста сильнее гарантии, дублирующийся проход уникальности и Windows-оговорка по O_NOFOLLOW.
type: task
status: done
created: 2026-08-20
updated: 2026-08-20
completed: 2026-08-20 15:17 +00:00
---

# Точность утверждений и хвосты

## Зачем

Отдельные мелочи, каждая из которых сама по себе не блокирует, но вместе они
размывают главную ценность проекта — что написанному можно верить буквально.

1. **Пять доков в `done/` без `completed:`** — `2026-08-20-async-operation-protocol`,
   `-async-rule-context-contributions`, `-composable-lifecycle-hooks`,
   `-managed-file-boundary-primitives`, `-transport-conformance-kit`
   (ровно пять самых крупных). Конвенция project-docs требует штамп.
2. **Необъявленное сужение path-параметров.** `server/context.ts` заменил
   локальный набор из 11 reserved-ключей на общий из 14: параметры маршрута с
   именами `files`, `signal`, `mcp` теперь молча отбрасываются. Изменение
   правильное, но по правилу «never break silently» ему нужна строка в
   `CHANGELOG.md`.
3. **Имя теста сильнее гарантии.** `tests/managed-file-boundary.test.ts` —
   «an already-aborted write performs no filesystem mutation»: реализация
   открывает temp (`O_CREAT|O_EXCL`) **до** первой проверки abort и удаляет его
   в `finally`; тест проверяет, что каталог пуст. Честная формулировка —
   «leaves no filesystem residue» (либо перенести проверку abort до `open`).
4. **Дублирующийся проход уникальности** в `defineAsyncOperation`: имена
   start/status/wait проверяются, затем `names.clear()` и полный повторный
   проход по всем шести. Первый проход — мёртвая работа.
5. **`O_NOFOLLOW` на Windows.** `constants.O_NOFOLLOW` там отсутствует, значит
   `constants.O_RDONLY | constants.O_NOFOLLOW` даёт `0` — флаг исчезает молча.
   Containment держится realpath + `isWithinDir`, так что дыры нет, но
   поведение расходится между платформами. Плюс `ManagedFilePathSchema` не
   отклоняет Windows-специфику (`CON`, `NUL`, хвостовые точка/пробел) — сейчас
   это неважно, потому что Windows не заявлен; важно, если кто-то его заявит.

## Результат

- Каждый закрытый док несёт `completed:`.
- CHANGELOG называет сужение path-параметров.
- Имя теста совпадает с доказанной гарантией.
- Мёртвый проход убран.
- Платформенная оговорка по `O_NOFOLLOW`/Windows-именам записана в research-
  ноте или ADR 0088, чтобы будущее заявление о Windows начиналось с неё.

## План

- [x] Проставить `completed:` пяти докам (реальная дата завершения работы, не
      дата правки).
- [x] Добавить в `CHANGELOG.md` строку `Fixed` про reserved path-параметры
      (`files`, `signal`, `mcp`).
- [x] Перенести `throwIfAborted()` до любого filesystem lookup/open и оставить
      сильное имя теста: already-aborted write действительно не мутирует FS.
- [x] Убрать первый проход `assertUniqueToolName` в `defineAsyncOperation`.
- [x] Дописать в research-ноту/ADR 0088 абзац про `O_NOFOLLOW` на Windows и про
      нерассмотренные Windows-имена в `ManagedFilePathSchema`.

## Acceptance

- [x] `rg -L 'completed:' docs/backlog/done` пуст.
- [x] Ни одно имя теста в затронутых файлах не заявляет больше, чем проверяет.
- [x] `bun run verify` зелёный.

## Что сделано

- [x] Docs lifecycle: пяти завершённым task-файлам добавлен фактический stamp
      `2026-08-20 12:53 +00:00`; `packages/core/tests/docs-hygiene.test.ts`
      теперь не пропускает новый done-док без `status: done` и `completed:`.
- [x] File boundary: `packages/core/src/files/boundary.ts` проверяет already-
      aborted signal до filesystem lookup/open; `O_NOFOLLOW` применяется только
      при наличии host flag.
- [x] Truth/docs: reserved route-key cut записан в `CHANGELOG.md`, Windows
      boundary — в `docs/decisions/0088-managed-files-bind-one-root.md` и
      `docs/research/2026-08-20-portable-managed-file-boundary.md`.
- [x] Cleanup: `packages/core/src/tools/async-operation.ts` оставляет один
      полный uniqueness pass после сборки optional capabilities.
- [x] Регрессия: packages/core/tests/managed-file-boundary.test.ts::an already-aborted write performs no filesystem mutation; packages/core/tests/docs-hygiene.test.ts::every done task has done status and a completed timestamp
