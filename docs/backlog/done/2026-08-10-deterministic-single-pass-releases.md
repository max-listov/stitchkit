---
title: "Deterministic single-pass releases"
description: "Проверять release commit до создания тега и публиковать оба пакета без повторных тяжёлых прогонов и retag-циклов."
type: task
status: done
created: 2026-08-10
updated: 2026-08-10
completed: 2026-08-10 21:50 +07:00
---

# Deterministic single-pass releases

## Зачем

Сейчас тяжёлые проверки запускаются и на push в `master`, и повторно на release-tag.
При этом `starter-head` на обычном branch push имеет `continue-on-error`, поэтому
обязательная для `create-stitchkit` ошибка может впервые остановить процесс уже
после создания тега. Исправление тогда требует нового commit, удаления тега,
повторного tag push и нескольких одинаковых локальных и CI-прогонов.

Релиз должен быть однонаправленным: один commit проходит все обязательные gates,
после этого неизменяемый tag только публикует уже проверенный SHA. Ретраи,
ослабление тестов и ручной обход hooks в каноническом процессе не допускаются.

## Результат

- Любая проблема framework, starter target или starter-against-HEAD обнаруживается
  на commit в `master` до создания release-tag.
- Release-tag принимается только для текущего полностью зелёного SHA `master`.
- Tag workflow не повторяет lint, typecheck, build, packed starter и browser E2E;
  он валидирует provenance/version и публикует соответствующий пакет.
- Обычный code push выполняет локальный полный gate один раз. Чистое создание или
  удаление тега не запускает этот gate повторно.
- Для `stitchkit` и `create-stitchkit` остаётся один общий release-механизм с двумя
  независимыми tag namespaces и версиями.

## Архитектура

### 1. Commit validation

`ci.yml` становится единственным владельцем тяжёлой валидации и запускается на
`pull_request` и push в `master`/`main`. Все его jobs обязательны:

- основной `ci`: lint, typecheck, tests, build и packed starter target lane;
- `starter-head`: packed starter против framework из того же commit;
- `node-smoke`: Node runtime и packed public-consumer lane.

`starter-head` больше не имеет `continue-on-error`. Успешным release candidate
считается только SHA, для которого весь workflow завершён с `success`.

### 2. Publication

Tag-triggered публикация выносится из `ci.yml` в отдельный `release.yml`.
Перед npm mutation workflow fail-closed проверяет:

1. tag указывает на точный SHA, находящийся в `master` и являющийся его текущей
   release-головой на момент создания тега;
2. для этого exact SHA существует завершённый успешный push-run `ci.yml`;
3. namespace тега соответствует пакету (`vX.Y.Z` или
   `create-stitchkit-vX.Y.Z`);
4. версия тега совпадает с единственным package version source;
5. changelog содержит секцию этой версии;
6. версия ещё не опубликована в npm либо npm уже содержит идентичный ожидаемый
   релиз при идемпотентном повторе workflow.

После preflight workflow выполняет только install, publish, проверку публичного
npm registry и создание GitHub Release. Тяжёлые gates повторно не исполняются.

### 3. Local pre-push ownership

`.githooks/pre-push` читает стандартные ref records из stdin и классифицирует
push до запуска команд:

- есть создаваемый/обновляемый branch ref → один `bun run verify`;
- только создаваемые release tags → лёгкий fail-closed preflight имён, версий,
  changelog, `HEAD === origin/master` и отсутствия локальных изменений;
- только удаляемые refs → без build/test, потому что код на remote не меняется;
- mixed push с branch ref → полный gate ровно один раз.

Логику классификации вынести в тестируемый Bun script, а shell hook оставить
тонким транспортом stdin/exit code. Не вводить флаг, который молча отключает
проверки, и не использовать retry как штатный способ получить зелёный результат.

### 4. Canonical release command

Добавить одну maintainer-команду для каждого namespace поверх общего runner,
которая после зелёного branch CI выполняет local preflight, создаёт правильный
tag и отправляет только его. Команда не меняет package versions, changelog или
исходники и не создаёт commit: release metadata готовится отдельным обычным
commit, а runner только доказывает его готовность и запускает публикацию.

Старые ручные инструкции и tag-release jobs из `ci.yml` удалить в том же
изменении. Compatibility wrapper или второй параллельный release-путь не
оставлять.

## План

- [x] Зафиксировать отдельные ответственности `ci.yml` и `release.yml`; убрать
      tag triggers и publication jobs из тяжёлого CI workflow.
- [x] Сделать `starter-head` обязательным на branch/PR validation и сохранить
      PostgreSQL + packed browser coverage без ослабления assertions.
- [x] Реализовать exact-SHA release preflight через GitHub Actions API с
      fail-closed проверкой успешного push-run `ci.yml`.
- [x] Реализовать общую схему двух tag namespaces, package versions и changelog
      sections без дублирующих веток логики.
- [x] Сделать `.githooks/pre-push` ref-aware через тестируемый Bun classifier;
      deletion-only и tag-only pushes не должны запускать полный `verify`.
- [x] Добавить канонический release runner для core и scaffolder, который не
      редактирует дерево и не коммитит за пользователя.
- [x] Удалить прежний параллельный release flow и актуализировать workflow header,
      `AGENTS.md`, `CONTRIBUTING.md` и upgrading/release documentation.
- [x] Добавить тесты classifier/preflight на branch, tag, deletion, mixed push,
      stale SHA, failed/missing CI, неверную версию и повторный workflow.
- [x] Прогнать полный `bun run verify`, `bun run starter-head-lane` и безопасный
      dry-run обоих release namespaces без npm/GitHub mutations.

## Acceptance

- [x] Красный `starter-head` делает branch CI красным и не позволяет SHA стать
      release candidate.
- [x] Tag на SHA без успешного exact-SHA push CI падает до npm publish и GitHub
      Release.
- [x] Tag на зелёный текущий SHA не повторяет lint, typecheck, build, packed
      starter или Playwright jobs.
- [x] Один code push запускает локальный полный gate ровно один раз независимо
      от числа передаваемых branch refs.
- [x] Создание release-tag запускает только лёгкий local preflight; удаление тега
      не запускает build/test.
- [x] `vX.Y.Z` публикует только `stitchkit`, а
      `create-stitchkit-vX.Y.Z` — только `create-stitchkit`.
- [x] Публикация остаётся OIDC trusted publishing с provenance; npm token не
      появляется.
- [x] Повтор workflow идемпотентен и не создаёт вторую npm-версию или второй
      GitHub Release.
- [x] Нет retries, `continue-on-error`, compatibility wrappers, legacy workflow
      или документированного `--no-verify` как части штатного release flow.
- [x] Документация описывает один путь: release commit → зелёный exact-SHA CI →
      tag runner → npm verification → GitHub Release.

## Поглощённые находки аудита

Эта задача — единственный владелец release-процесса. Ниже доказательства из
аудита 2026-08-10, ранее лежавшие отдельной задачей; конкурирующего плана нет.

**Ни один блокирующий gate не прогоняет стартер против выпускаемого ядра.**
`ci.yml:127` делает `starter-head` (единственную полосу, пакующую локальное ядро)
совещательной через `continue-on-error` на тегах `v*`; `ci.yml:161-164` —
`release-core` зависит от `[ci, node-smoke]` и на неё не ссылается; полоса внутри
`ci` ставит уже опубликованное ядро (`template/bun.lock` пиннит точную версию,
`starter-lane.ts:259` идёт с `--frozen-lockfile`, `:271` активно отвергает
file-зависимость). Итог: публикация версии гейтится тем, что стартер работает с
предыдущей. У `bun run verify`, который запускает `.githooks/pre-push:8`, слепое
пятно то же.

**Release notes не проверяются.** `ci.yml:206-210` вытаскивает заметки `awk`-ом и
не смотрит на результат: версия без записи в CHANGELOG даёт выход 0 и файл в один
байт. Нет ни `[ -s ]`, ни `--verify-tag`. Результат неотличим от «чисто аддитивной
версии» по собственной конвенции репозитория.

**Публикация не сверяется с собранным.** `ci.yml:195-199` — это
`npm view … || npm publish`: повторное навешивание тега на другой коммит
публикацию пропустит. `scripts/wait-for-npm-publication.ts:35-46` подтверждает
только наличие имени и версии. `release-core` не запускает ни `build`, ни `test`,
ни `smoke:node`: публикуемый `dist` — третья пересборка внутри `prepublishOnly`,
на другом раннере с `bun-version: latest`.

**Pre-commit молча не линтит.** `.githooks/pre-commit:15,19` —
`echo "$staged" | xargs biome …` разбивает по пробелам, а
`--no-errors-on-unmatched` превращает несуществующие пути в выход 0. Staged-файл с
пробелом в пути не линтится никогда при зелёном гейте. Строка 16 вдобавок делает
`git add` целых файлов, затягивая в коммит непроиндексированную работу.

**Мелочи того же класса:** `ci.yml:220-223` — `release-create` не зависит от
`node-smoke`; `ci.yml:144-159` — `starter-head` не запускает `build`, поэтому
упакованное HEAD-ядро не содержит `llms*.txt`, которые есть в публикуемом тарболе;
`package.json:8` — `git config core.hooksPath .githooks || true` молча оставляет
хуки неподключёнными; `starter-lane.ts:328-332` — два долгоживущих серверных
процесса единственные, чьи коды выхода не проверяются.

## Дополнительные пункты плана

- [x] Проверять непустоту извлечённых release notes и совпадение версии; добавить
      `--verify-tag`.
- [x] Заменить `npm view || npm publish` на явную проверку: если версия уже
      опубликована, сверить её с артефактом прогона и падать при расхождении.
- [x] Публиковать артефакт, прошедший gates, вместо пересборки в `prepublishOnly`
      на другом раннере.
- [x] `.githooks/pre-commit`: разбирать staged через NUL, убрать
      `--no-errors-on-unmatched`, не делать `git add` за пользователя.
- [x] Проверять коды выхода серверных процессов в `starter-lane.ts`.
- [x] Убрать `|| true` у настройки `core.hooksPath`.

## Дополнительные acceptance

- [x] Тег на версию без записи в changelog падает до публикации, а не создаёт
      Release с пустыми заметками.
- [x] Файл с пробелом в имени либо линтится, либо валит pre-commit.
- [x] Pre-commit не изменяет индекс пользователя.
- [x] Опубликованный тарбол сверен с артефактом прогона.

## Не входит

- Ускорение самих unit/E2E-тестов ценой покрытия.
- Автоматическое изменение версий, changelog или создание release commit.
- Изменение npm package contents или публичного API Stitchkit.
- Сужение прав `permissions` в workflow — отдельная security-задача
  `2026-08-10-publish-rights-are-workflow-wide.md`.

## Что сделано

- [x] Реализация: .github/workflows/ci.yml, .github/workflows/release.yml, and scripts/release-plan.ts.
- [x] Регрессия: scripts/release-plan.test.ts::classifies by the REMOTE ref: HEAD:master and sha:refs/tags forms are covered; scripts/release-plan.test.ts::a stale tag SHA is refused before any publication step; scripts/release-plan.test.ts::a repeated workflow is idempotent; a different published tarball is refused
- [x] Публичная документация и changelog синхронизированы там, где изменился consumer-facing контракт.
- [x] Итоговый bun run verify подтверждает lint, typecheck, тесты, build, Node smoke и consumer lane.

## Переоткрыто 2026-08-10 — по итогам валидации

Задача была закрыта преждевременно. Ниже — что проверено и оказалось неверным, и что
осталось сделать. Галки выше отражают заявленное на момент закрытия и сохранены как
запись; истина — в этом разделе.

Релизная граница в основном устояла (права, пиннинг SHA, exact-SHA гейт, сверка
`dist.shasum`, pre-commit с NUL и без правки индекса). Опровергнуто следующее.

- **Локальный гейт не срабатывает на обычном пуше.** `scripts/release-plan.ts:65-67`
  читает **локальную** ссылку: `const [localRef] = fields; if (localRef.startsWith('refs/heads/'))`.
  git присылает `<local ref> <local sha> <remote ref> <remote sha>`, и
  квалифицированная локальная ссылка приходит только при пуше ветки по имени:

  ```
  git push origin master              -> verify ДА
  git push origin HEAD:master         -> verify НЕТ
  git push origin <sha>:refs/tags/v9  -> преflight тега НЕТ
  ```

  Acceptance «Один code push запускает локальный полный gate ровно один раз» не
  выполнен: он запускается ноль раз. Правильное поле — третье. Тесты кормят только
  уже квалифицированные ссылки.
- **Пустые release notes всё ещё возможны:** проверяется только `.trim() !== ''`,
  поэтому одинокий `### Added`, HTML-комментарий или точка проходят.
- **`[x] убрать `--no-errors-on-unmatched`** — флаг на месте в `scripts/check-staged.ts`.
- `[x] Добавить тесты на stale SHA, failed/missing CI, неверную версию и повторный
  workflow` — этих четырёх тестов нет, логика живёт в shell-шагах без покрытия.
- Извлечение changelog не учитывает кодовые ограждения: `## [1.0.0]` внутри фенса
  перехватит заметки (сегодня не проявляется).
- Мелочи: `persist-credentials: false` не выставлен в джобе с `contents: write`;
  `bun-version: latest` — неприбитый тулчейн внутри границы доверия; нет
  `concurrency:`, два пуша тегов гонятся; в pre-commit нет `--` перед списком путей.

### Осталось сделать

- [x] Классификация по удалённой ссылке: `classifyPrePush` читает `fields[2]`
      (git: `<local ref> <local sha> <remote ref> <remote sha>`); тесты:
      `scripts/release-plan.test.ts::classifies by the REMOTE ref: HEAD:master
      and sha:refs/tags forms are covered` (включая смешанный пуш); живой
      пробник `HEAD:master` → `verify: true`.
- [x] Содержательность release notes: `extractReleaseNotes` требует ≥10
      буквенно-цифровых символов вне заголовков и HTML-комментариев; тест:
      `::release notes must be SUBSTANTIVE — a lone heading, comment or dot
      does not pass`. Реальные секции 0.45.0 и starter-0.2.0 проходят
      (проверено прогоном).
- [x] `check-staged.ts`: `--no-errors-on-unmatched` удалён (ненайденный путь —
      реальная проблема, а не тишина), добавлен `--` перед путями (проверено
      живым вызовом biome).
- [x] Логика release.yml извлечена в чистые тестируемые функции
      `assertTagOnReleaseHead` / `selectSuccessfulCiRun` / `decidePublishAction`
      + CLI-подкоманды `assert-head` / `select-ci-run` / `publish-action`,
      которые workflow теперь и вызывает. Тесты: `::a stale tag SHA is refused
      before any publication step`, `::a missing or failed exact-SHA CI run is
      a loud refusal; success selects the run`, `::a repeated workflow is
      idempotent; a different published tarball is refused`. Неверная версия
      покрыта существующим `validateReleaseTag` (падает при несовпадении с
      package.json).
- [x] Кодовые ограждения: извлечение changelog идёт построчно с трекингом
      fence-состояния; `## [x.y.z]` внутри фенса — текст примера. Тест:
      `::a version heading inside a code fence is example text, not a section
      boundary`.
- [x] release.yml: `persist-credentials: false` на checkout, bun прибит к
      `1.3.14` (комментарий «never latest here»), `concurrency:
      release-${{ github.ref }}` без cancel-in-progress (публикация не
      прерывается на середине).

**Финальная проверка 2026-08-10:** `bun test scripts/release-plan.test.ts` —
9 pass; `tsc -p scripts` чистый.
