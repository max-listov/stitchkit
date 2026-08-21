---
title: "Release calibre is a written rule and a gate; cancellation bounds are pinned"
description: "Закрыть остаток ревью client-disconnect: точная граница обхода cause chain в тесте, обоснование defensive guard, записанное правило выбора patch/minor и машинный запрет breaking-as-patch."
type: task
status: done
created: 2026-08-21
updated: 2026-08-21
completed: 2026-08-21 05:05 +0000
related:
  - docs/backlog/done/2026-08-21-client-disconnect-propagation-hardening.md
  - docs/backlog/done/2026-08-21-client-closed-http-request-cancellation.md
  - docs/decisions/0097-request-cancellation-is-an-opt-in-observability-outcome.md
---

# Release calibre is a written rule and a gate; cancellation bounds are pinned

## Зачем

Ревью реализации client-disconnect оставило три хвоста. Два — узкие, третий
оказался не тем, чем выглядел.

- Обход `cause` chain закреплён тестами на глубине 2 (позитив) и 9 (негатив).
  Сам документированный предел — восемь звеньев — не закреплён ни с одной
  стороны, поэтому off-by-one в `MAX_REQUEST_ABORT_CAUSE_DEPTH` или в условии
  цикла проходит мимо обеих проверок.
- Проверка `if (req.signal.aborted) onAbort()` после подписки на `abort`
  недостижима: guard в начале функции уже бросил бы, а между ними нет ни одного
  `await`. Без объяснения она читается как недосмотр, и следующая правка её
  снесёт — вместе с защитой от появления `await` выше.
- Калибр релиза был назван в ревью как «`### Added` обязан ехать минором».
  Проверка истории это опровергает: `0.48.1` выпустил `stitchkit/testing`, а
  `0.49.1` — `forceTimeoutMs`, обе патчами. Настоящий дефект не в выбранном
  номере, а в отсутствии записанного правила: `AGENTS.md` определяет только
  breaking → minor и молчит про всё остальное, поэтому два агента подряд
  выбирали калибр по-разному и оба могли сослаться на прецедент.

Опасное направление при этом ровно одно. Каретка потребителя (`^0.56.0` <
`0.57.0`) — единственный механизм, который делает переход через breaking
осознанным. Breaking, выпущенный патчем, забирается на обычном `install`
молча, то есть ровно тот исход, ради предотвращения которого политика breaking
changes и существует. Обратное направление (аддитив минором) стоит лишнего
апгрейда и вреда не наносит.

## Результат

- Тест закрепляет предел обхода `cause` с обеих сторон: восьмое звено ещё
  распознаётся, девятое уже нет.
- Defensive guard в bounded reader объяснён на месте: он делает подписку
  корректной по построению, а не по нелокальному инварианту.
- `AGENTS.md` отвечает на вопрос «какой номер двигать» для любого релиза, а не
  только для breaking.
- Breaking, оформленный как patch bump, отклоняется машинно на пути релиза, а не
  замечается на ревью.
- Гейт не переписывает историю: все выпущенные версии обоих пакетов проходят его
  без исключений.

## План

- [x] Добавить boundary-тест на inclusive предел `cause` traversal.
- [x] Обосновать комментарием defensive guard в `readRequestText`.
- [x] Записать правило выбора patch/minor в `AGENTS.md` от каретной семантики.
- [x] Реализовать `assertVersionCalibre` и включить его в `validateReleaseTag`.
- [x] Покрыть гейт тестами и проверить его на реальной истории обоих changelog.
- [x] Прогнать полный `bun run verify`.

## Acceptance

- [x] Мутация `depth <= MAX` → `depth < MAX` роняет ровно один тест
      (проверено прогоном с временно изменённой константой).
- [x] Breaking-секция в patch bump отклоняется с сообщением, называющим
      предыдущую версию и причину; та же секция в minor проходит.
- [x] Аддитивный patch и первый релиз в changelog проходят гейт.
- [x] `releasedVersionsInOrder` игнорирует версии внутри code fence.
- [x] Все 68 версий `CHANGELOG.md` и 7 версий starter changelog проходят гейт.
- [x] `bun run verify` зелёный; version, commit, tag и publish не выполняются.

## Что сделано

- [x] `packages/core/tests/http-client-disconnect.test.ts` case `the abort-reason
      cause walk is inclusive at its documented depth limit` проверяет пару
      8 → `499` и 9 → `503` в одном тесте, поэтому off-by-one в любую сторону
      падает.
- [x] `packages/core/src/server/request-body.ts` — комментарий объясняет, почему
      недостижимая сегодня проверка остаётся: она защищает подписку от `await`,
      добавленного выше в будущем.
- [x] `AGENTS.md` раздел `Releasing` получил абзац **Which number moves**: минор
      зарезервирован под breaking, всё остальное — patch, с прецедентами
      `0.48.1` и `0.49.1`.
- [x] `scripts/release-plan.ts` — `releasedVersionsInOrder` и
      `assertVersionCalibre`, вызываемый из `validateReleaseTag`, то есть на том
      же пути, что и проверка версии пакета и извлечение release notes.
- [x] `scripts/release-plan.test.ts` cases `a breaking change may not ship as a
      patch — the caret would carry it silently`, `the same breaking notes pass
      as a minor, and additive notes pass as a patch`, `the first release in a
      changelog has no predecessor to compare against` и `version headings are
      read in order and ignore fenced examples`.
- [x] Гейт прогнан по реальной истории: 68 + 7 версий, ноль отклонённых.
- [x] Version, commit, tag, publish и deploy не выполнялись.

## Не входит

- Гейт на аддитив, выпущенный минором: он не создаёт риска для потребителя.
- Изменение самой классификации client-disconnect — она закрыта предыдущими
  задачами.
