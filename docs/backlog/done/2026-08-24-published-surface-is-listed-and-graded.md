---
title: "Every published entrypoint is listed, and says how settled it is"
description: "Таблица entrypoints отстала на три экспорта и врёт про их число, ROADMAP не знает о выпущенном agent-runtime, а читателю неоткуда узнать, какая поверхность устоялась, а какая ищет форму."
type: task
status: done
created: 2026-08-24
updated: 2026-08-24
completed: 2026-08-24 13:43 +0000
related:
  - docs/decisions/0098-optional-agent-application-runtime.md
  - docs/decisions/0102-managed-application-kernel.md
---

# Every published entrypoint is listed, and says how settled it is

## Зачем

Две проблемы живут в одной таблице, и чинить их порознь значит править один
файл дважды и получить конфликт.

**Перечисление отстало.** `packages/core/package.json` публикует шестнадцать
entrypoints. Таблица в `docs/guide/getting-started.md:29-43` — первое, что
читает новый потребитель, — несёт тринадцать строк: нет
`stitchkit/application`, `stitchkit/application/grammy`,
`stitchkit/application/opentelemetry`. Строка над таблицей
(`getting-started.md:26`) утверждает «stitchkit ships **eleven** entrypoints» —
это было верно ещё до появления обоих новых слоёв. `ROADMAP.md` описывает
`stitchkit/application` в разделе «In progress», хотя он выпущен в 0.59.2, а
`stitchkit/agent-runtime` не упомянут нигде, хотя занимает около 4 600 строк и
менялся в восьми релизах подряд.

Хуже всего отстал не человеческий документ, а агентский:
`skills/stitchkit/SKILL.md` — точка входа агента в проекте-потребителе, которую
`AGENTS.md` назначает картой всей потребительской поверхности, — не содержит ни
одного вхождения `agent-runtime` или `stitchkit/application`. Его frontmatter
`description` перечисляет поверхность для активации скилла и заканчивается на
file/multipart и деплое, так что агент в проекте на новых слоях может не
активировать скилл вовсе. Таблица optional peers не знает
`@openrouter/ai-sdk-provider`, `grammy` и `@opentelemetry/api`, объявленных в
`package.json`. Карта «задача → раздел документации» не содержит строк для трёх
страниц, которые зарегистрированы в `scripts/gen-llms.ts` и попадают в
`llms.txt` — то есть говорит агенту, что этих страниц не существует.

Мельче, но той же природы: таблица peer-зависимостей в `getting-started.md`
не содержит `grammy` и `@opentelemetry/api`, хотя `README.md` их перечисляет —
два документа расходятся между собой; описание `stitchkit/testing` в той же
таблице устарело (барель теперь несёт conformance-киты и race-хелперы); в
`README.md` абзац про `stitchkit/agent-runtime` стоит под заголовком про
Socket.IO, а перечень гайдов в нём не содержит agent runtime, хотя сам README
на этот гайд ссылается. И `CHANGELOG.md` не имеет link-reference для всего
диапазона от 0.48.1 до 0.59.4 — 25 версий рендерятся на GitHub и npm как
литеральный текст `[0.59.4]`, а `[Unreleased]` указывает на `v0.48.0`.

Расхождение этого рода не ловится ревью: экспорт добавляется, ни один документ
не трогается, всё зелёное.

**Зрелость не объявлена.** Пакет публикует поверхности очень разного возраста.
`defineContract`, HTTP-сервер, типизированный клиент, MCP и CLI не ломались
месяцами. `stitchkit/agent-runtime` появился в 0.56.2 и за следующие сутки
пережил три breaking-минора: 0.57.0 и 0.59.0 переопределили контракт
хранилища, 0.58.0 сменил дефолт проекции истории и редактирование
`internalCause`. Между 0.57.0 и 0.58.0 — 51 минута. `stitchkit/application`
вышел ещё через день.

Само по себе это нормально: до 1.0 форма ищется, и каждый разрыв честно описан.
Ненормально, что читателю неоткуда узнать, во что он вкладывается: оба новых
слоя поданы с той же авторитетностью, что и контрактное ядро. Потребитель,
выбирающий между `mountAgent` и `agent-runtime`, принимает решение без
ключевого факта.

Это не предупреждение «не используйте». Это объявление режима: одна поверхность
устоялась, другая активно ищет форму, и обе — легитимный выбор.

## Результат

- Таблица перечисляет каждый публикуемый экспорт, и вводная строка не называет
  число, которое устаревает при следующем экспорте.
- Каждая строка несёт объявленный уровень зрелости. Уровней два, различие
  операциональное: устоявшаяся поверхность меняется редко и по веской причине,
  развивающаяся может переопределяться в любом миноре.
- Уровень продублирован там, где его увидят до первого примера кода: шапка
  гайда соответствующего слоя и `docs/VISION.md`.
- `ROADMAP.md` называет выпущенные слои выпущенными.
- Новый экспорт, не попавший в таблицу или не получивший уровня, роняет
  проверку с именем пропущенного ключа.
- Перевод поверхности из развивающейся в устоявшуюся — отдельный ADR, а не
  правка формулировки.

## План

- [x] Дописать строки для `stitchkit/application`, `stitchkit/application/grammy`,
      `stitchkit/application/opentelemetry`, сверив формулировки с
      `docs/api/reference.md`.
- [x] Убрать из `getting-started.md:26` жёсткое число entrypoints.
- [x] Определить два уровня и записать их смысл одним абзацем: что потребитель
      вправе ожидать от каждого и чего не вправе.
- [x] Добавить колонку уровня и разметить: контракт, HTTP-сервер, Node-адаптер,
      клиент, tools, CLI, react, observability, files, testing, remote —
      устоявшиеся; `agent-runtime`, `agent-runtime/openrouter`, `application`,
      `application/grammy`, `application/opentelemetry` — развивающиеся. Спорные
      случаи назвать явно и обосновать.
- [x] Добавить строку уровня в шапку `docs/guide/agent-runtime.md` и
      `docs/guide/application-kernel.md`, до первого примера кода.
- [x] Отразить деление в `docs/VISION.md` рядом с принципами про опциональные
      рантаймы.
- [x] Перенести `stitchkit/agent-runtime` и `stitchkit/application` в «Now»
      `ROADMAP.md`; решить, чем становится опустевший раздел «In progress» —
      наполнить актуальным или убрать.
- [x] Расширить `packages/core/tests/reference-coverage.test.ts`: его карта
      `ENTRYPOINTS` (строка 22) сегодня поддерживается вручную и может разойтись
      с `package.json` молча. Сверять за один проход `package.json#exports` ↔
      `ENTRYPOINTS` ↔ строки таблицы `getting-started.md` ↔ наличие уровня в
      строке; отсутствие называет ключ.
- [x] Написать ADR 0103: зачем уровни, почему их два, и что перевод между
      уровнями требует отдельного ADR. Добавить строку в
      `docs/decisions/README.md`.
- [x] Обновить `skills/stitchkit/SKILL.md`: описание в frontmatter, таблица
      optional peers и карта «задача → раздел» получают оба новых слоя.
- [x] Свести таблицу peer-зависимостей `getting-started.md` с `README.md` и
      `AGENTS.md`; обновить описание `stitchkit/testing`.
- [x] Поправить в `README.md` (и его копии в `packages/core/`) положение абзаца
      про `agent-runtime` и перечень гайдов.
- [x] Восстановить link-reference в `CHANGELOG.md` для версий от 0.48.1 и
      направить `[Unreleased]` на текущую версию; проверить формой той же
      проверки, что и остальное.
- [x] Проверить, что `llms.txt` / `llms-full.txt` после `bun run build`
      отражают изменения.

## Acceptance

- [x] Каждый ключ `exports` из `package.json` присутствует в таблице
      `getting-started.md` и несёт уровень.
- [x] Тест падает, если добавить экспорт в `package.json`, не тронув таблицу, и
      сообщение называет пропущенный ключ.
- [x] Тест падает, если строка таблицы не несёт уровня.
- [x] Тест падает, если `ENTRYPOINTS` в `reference-coverage.test.ts` разошёлся с
      `package.json#exports`.
- [x] `getting-started.md` не содержит числа entrypoints в прозе.
- [x] `ROADMAP.md` перечисляет `stitchkit/agent-runtime` и
      `stitchkit/application` среди выпущенного.
- [x] Гайды обоих новых слоёв несут уровень в шапке.
- [x] ADR 0103 принят и внесён в индекс.
- [x] Никакая существующая версионная политика не изменена: правило «минор
      несёт breaking, патч аддитивен» остаётся общим для всего пакета.
- [x] `skills/stitchkit/SKILL.md` называет оба новых слоя в описании, в таблице
      peer-зависимостей и в карте разделов.
- [x] Ни одна версия `CHANGELOG.md` не остаётся без link-reference, и
      `[Unreleased]` указывает на актуальную версию.
- [x] `bun run verify` зелёный.

## Не входит

- Разделение на отдельные npm-пакеты: изоляция уже обеспечена отдельными
  entrypoints, опциональными peer-зависимостями и матрицей бандла из 0.59.4, а
  отдельный пакет добавляет вторую версию, второй релизный путь и дублирование
  гейтов. Задача сознательно делает дешёвый шаг вместо дорогого.
- Замедление темпа изменений в развивающихся слоях: объявление уровня служит
  ровно обратному — оно легализует темп.
- Гейт на полноту `docs/api/reference.md`: сегодня он покрывает все экспорты,
  отдельной проверки эта задача не вводит.

## Что сделано

- [x] Таблица entrypoints в `docs/guide/getting-started.md` перечисляет все
      шестнадцать экспортов и несёт колонку `Maturity`; жёсткое число
      «eleven entrypoints» из прозы убрано.
- [x] Разметка: одиннадцать stable, пять evolving (`agent-runtime`,
      `agent-runtime/openrouter`, `application`, `application/grammy`,
      `application/opentelemetry`).
- [x] Уровень продублирован там, где его увидят до первого примера кода: шапки
      `docs/guide/agent-runtime.md` и `docs/guide/application-kernel.md`, а
      также принципы в `docs/VISION.md`.
- [x] ADR 0103 принят и внесён в `docs/decisions/README.md`.
- [x] Гейт: packages/core/tests/reference-coverage.test.ts::every published export is covered by the reference walk; packages/core/tests/reference-coverage.test.ts::every published export has a guide row that declares its maturity — сверяет `package.json#exports` ↔ карту `ENTRYPOINTS` ↔ строки таблицы ↔ наличие уровня.
- [x] Зубы гейта проверены двумя мутациями: снятие уровня у строки и удаление
      строки целиком — каждая роняет тест, откат возвращает зелёный.
- [x] `ROADMAP.md`: раздел «In progress» переименован в «Shipped and evolving»,
      agent-runtime добавлен в перечень выпущенного.
- [x] `skills/stitchkit/SKILL.md` — точка входа агента потребителя — получил оба
      слоя в `description`, три недостающих optional peer и три строки в карте
      «задача → раздел», плюс абзац про уровни зрелости.
- [x] `CHANGELOG.md`: восстановлены link-reference для **25** версий от 0.48.1
      до 0.59.4, которые рендерились как литеральный текст; `[Unreleased]`
      переведён с `v0.48.0` на `v0.59.4...HEAD`.
- [x] `README.md` и его копия в `packages/core/`: абзац про `agent-runtime`
      перенесён из-под заголовка про Socket.IO, перечень гайдов дополнен agent
      runtime и migration recipes.
- [x] Таблицы optional peers в `getting-started.md` и `AGENTS.md` сведены с
      `package.json`; `AGENTS.md` также перечисляет все entrypoints и раскладку
      двух новых каталогов.

## Что всплыло по ходу

- [x] Сборка имеет собственный гейт `check-public-types`, о котором задача не
      знала, и он поймал мою же ошибку: `ApplicationResourceFailure.phase`
      ссылался на неэкспортированный `ResourceFailure`. Тип выведен наружу как
      `ApplicationResourcePhase`. То есть класс дефектов из соседней задачи
      частично уже закрыт машинно — это стоит знать.
