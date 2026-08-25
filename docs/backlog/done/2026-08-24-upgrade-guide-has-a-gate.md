---
title: "A migration section survives to its release instead of being overwritten"
description: "Текст миграции пишется под заголовком Unreleased, не промоутится при теге и затирается следующим breaking-изменением; восстановить потерянное и закрыть механизм проверкой."
type: task
status: done
created: 2026-08-24
updated: 2026-08-24
completed: 2026-08-24 13:09 +0000
related:
  - docs/guide/upgrading.md
  - scripts/release-plan.ts
---

# A migration section survives to its release instead of being overwritten

## Зачем

`docs/guide/upgrading.md` — единственное место, где breaking-изменение объяснено
не механически, а по последствиям: почему форма изменилась и что ещё
у потребителя перестанет компилироваться. `CHANGELOG.md` этого не несёт и не
должен.

Диагноз «разделы для 0.57.0–0.59.0 забыли написать» неверен. Их писали, и они
пропали. Механизм воспроизводится по истории файла:

- `123ec40` — релизный коммит **0.57.0** — добавил в `upgrading.md` раздел
  `## Unreleased migration: complete agent admission identity` (28 строк).
  Заголовок остался `Unreleased`: релизный коммит не промоутил его в
  `Released migration: 0.57.0`.
- `799725d` — следующая работа по агент-рантайму — **заменил** этот заголовок и
  его содержимое на `## Unreleased migration: normalized agent runtime
  persistence`. Текст миграции 0.57.0 не устарел и не был превзойдён — он был
  удалён.

Сегодня в файле на строке 51 живёт ровно один `## Unreleased migration:`,
описывающий 0.59.0, а материал 0.57.0 существует только в истории git и
восстанавливается через `git show 123ec40 -- docs/guide/upgrading.md`.

То есть отказывает не дисциплина написания, а **отсутствие промоушена при
релизе плюс единственность заголовка `Unreleased migration`**: следующий автор
естественным образом переиспользует занятую позицию. Это второй раз, когда файл
приходится чинить руками — перед 0.56.0 в нём тоже накопились непромоутнутые
`Unreleased`-разделы, и их сводили вручную.

Соседний прецедент машинной проверки уже есть: `assertVersionCalibre`
(`scripts/release-plan.ts:161`) отказывает релизу, где breaking-секция едет
патчем, и вызывается из `validateReleaseTag` — то есть работает и в `pre-push`,
и серверно в `preflight`.

## Результат

- Материал миграции 0.57.0 восстановлен из истории, 0.58.0 и 0.59.0 доведены до
  полноты; все три промоутнуты в `## Released migration: <version>`.
- Заголовок `## Unreleased migration:` перестаёт быть единственной позицией:
  либо он допускает несколько разделов, либо конвенция заменяется на такую, где
  затирание невозможно. Решение принимается в этой задаче и записывается в
  разделе «When you author a breaking change in stitchkit» того же файла.
- Релиз с `### ⚠️ Breaking changes` и без промоутнутого раздела отклоняется
  машинно, на том же пути, что проверка версии и notes.
- Проверка не требует переписывать историю: она смотрит только на версию,
  которая выпускается.

## План

- [x] Восстановить текст 0.57.0 из `git show 123ec40 -- docs/guide/upgrading.md`
      и промоутнуть в `## Released migration: 0.57.0`.
- [x] Написать `## Released migration: 0.58.0` по breaking-секции changelog:
      дефолт проекции истории (`leadingAssistant`) и редактирование
      `internalCause` в operator-событиях, с вторичными последствиями, которых
      нет в changelog.
- [x] Промоутнуть существующий раздел на строке 51 в
      `## Released migration: 0.59.0`.
- [x] Принять и записать конвенцию для незарелиженного материала так, чтобы
      второй breaking не мог затереть первый.
- [x] Реализовать проверку в `scripts/release-plan.ts`: если release notes
      выпускаемой версии содержат `### ⚠️ Breaking changes`, то
      `docs/guide/upgrading.md` обязан содержать
      `## Released migration: <version>`; иначе отказ с текстом, называющим
      версию и файл.
- [x] Ограничить проверку floor-версией `0.44.0` — это самый ранний
      существующий `Released migration`, а более старые breaking-версии уже
      покрыты разделами другой формы (`## Historical breaking migrations through
      0.44.0`, `## The 0.37 migration`). Floor записать константой с
      комментарием, а не молча.
- [x] Подключить проверку в `validateReleaseTag` рядом с `assertVersionCalibre`.
- [x] Покрыть тестами в `scripts/release-plan.test.ts`: breaking без раздела —
      отказ; breaking с разделом — проходит; аддитивная версия — проходит; версия
      ниже floor — проходит; заголовок внутри code fence не засчитывается.
- [x] Обновить `CONTRIBUTING.md` (описание хуков) и раздел про авторство
      breaking-изменений в `upgrading.md`.

## Acceptance

- [x] `## Released migration:` существует для 0.57.0, 0.58.0 и 0.59.0.
- [x] Раздел 0.57.0 содержит материал, восстановленный из `123ec40`, а не
      написанный заново.
- [x] В `upgrading.md` не остаётся ни одного `## Unreleased migration:`,
      описывающего уже выпущенную версию.
- [x] Проверка отклоняет релиз без раздела и называет точную версию и файл.
- [x] Проверка пропускает аддитивный релиз и любую версию ниже floor `0.44.0`.
- [x] Прогон проверки по всем версиям `CHANGELOG.md` начиная с `0.44.0` не
      отклоняет ни одной уже выпущенной; расхождение либо закрыто разделом, либо
      названо в задаче явно.
- [x] Проверка запускается и в `pre-push`, и в CI-preflight.
- [x] `bun run verify` зелёный.

## Не входит

- Написание разделов для breaking-версий ниже `0.44.0`: их покрывают сводные
  исторические разделы, и переписывать двадцать лет истории эта задача не
  требует.
- Проверка для `create-stitchkit`: собственного `upgrading.md` у scaffolder нет,
  и заводить его эта задача не предлагает.
- Автогенерация разделов из changelog: смысл раздела в том, чего в changelog
  нет.

## Что сделано

- [x] Текст миграции 0.57.0 восстановлен из `123ec40` и промоутнут в
      `## Released migration: 0.57.0` (`docs/guide/upgrading.md:133`).
- [x] Написан `## Released migration: 0.58.0` — дефолт проекции истории и
      редактирование `internalCause`, со вторичными последствиями, которых нет в
      changelog: проекция может вернуть меньше сообщений, чем хранится, и
      дашборд на `internalCause` слепнет тихо, потому что поле отсутствует, а не
      пусто.
- [x] Существовавший `## Unreleased migration: normalized agent runtime
      persistence` промоутнут в `## Released migration: 0.59.0`.
- [x] Конвенция записана в `## When you author a breaking change in stitchkit`:
      несколько `## Unreleased migration: <slug>` сосуществуют, переиспользовать
      чужой заголовок запрещено, релизный коммит промоутит все в один
      `## Released migration: X.Y.Z` с `###`-подразделами.
- [x] `scripts/release-plan.ts`: `assertMigrationSection` с floor-версией
      `MIGRATION_SECTION_FLOOR = '0.44.0'`, общие `BREAKING_HEADING` и
      `headingOutsideFences` (переиспользуются `assertVersionCalibre`), вызов из
      `validateReleaseTag` только для `target === 'core'`.
- [x] Регрессия: scripts/release-plan.test.ts::a breaking release must carry the migration section that explains it; scripts/release-plan.test.ts::an unpromoted heading does not satisfy the gate; scripts/release-plan.test.ts::additive releases and versions below the floor pass without a section; scripts/release-plan.test.ts::a migration heading inside a fenced example does not satisfy the gate
- [x] Обнаруженный при прогоне долг закрыт, а не обойдён: гейт отклонял
      исторические `0.46.0` и `0.49.0`; для обеих написаны разделы миграции.
      Прогон по всем 80 версиям `CHANGELOG.md` — ноль отклонённых.
- [x] `CONTRIBUTING.md` описывает состав preflight в `pre-push`.

## Что не сделано

- [x] Проверка для `create-stitchkit` не вводится: собственного `upgrading.md` у
      scaffolder нет, и заводить его как побочный эффект гейта неправильно.
      Гейт явно ограничен `target === 'core'`.
