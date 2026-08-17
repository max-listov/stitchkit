---
title: Дефолтное сообщение в определении доменной ошибки
description: message в ErrorDefinition получает типовой контракт, приоритет в фабрике и валидацию — вместо ключа, который сегодня принимается молча и никуда не доезжает.
type: task
status: done
created: 2026-08-17
updated: 2026-08-17
completed: 2026-08-17 14:04 +00:00
related: docs/decisions/0058-zod-first-domain-error-definitions.md
---

# Дефолтное сообщение в определении доменной ошибки

## Зачем

`defineErrors` объявляет код, HTTP-статус и Zod-схему деталей одним неизменяемым
реестром, но текст ошибки в определении **не типизирован**. Формально его надо
передавать на каждом `throw`: `errors.X({ message: '…' })`, иначе `AppError`
подставит сам код ([errors.ts:48](../../../packages/core/src/contract/errors.ts)).

Фактическая картина хуже, чем «поля нет». Excess-property check через
`const`-дженерик **молчит**, поэтому `defineErrors({ X: { status: 404, message:
'…' } })` компилируется уже сегодня, ключ доезжает во frozen `definitions`
([errors-factory.ts:143](../../../packages/core/src/contract/errors-factory.ts))
— и там умирает: фабрика его не читает, в `AppError` он не попадает, на провод
идёт код. То есть сейчас поле можно написать, оно выглядит рабочим и молча не
работает. Это хуже отсутствующего поля.

Задача даёт полю типовой контракт, приоритет в фабрике и валидацию. Прежняя
формулировка обоснования («блокер, из-за которого `defineErrors` никто не взял»)
снята как недоказуемая: `defineErrors` используется в стартовом примере и в
consumer-lane фикстуре этого же репозитория.

## Подтверждённая механика

Проверено валидаторами, ссылки выверены:

- `ErrorDefinition` — union `{ status; details?: never } | { status; details:
  ErrorDetailsSchema }` (`errors-factory.ts:29-32`).
- **Дискриминация union'а чиста:** `ErrorDetailsOutput` (`:37-41`),
  `DefinedAppError` (`:44-52`), `ErrorFactoryArguments` (`:58-76`) ключуются на
  `TDefinition extends { details: infer TSchema }`. Добавление двух optional-полей
  на обе ветки ничего не сдвигает — проверено компиляцией пробников.
- Рантайм-приём `options.message` — `errors-factory.ts:152-161` (не `:60-76`,
  там только типы аргументов). `defineErrors` — `:134`. `validateDefinition` —
  `:116`. `Object.freeze` — `:143-145`.
- **`definitions[code].message` сегодня не компилируется:**
  `FrozenErrorDefinitions = Readonly<TDefinitions[TCode]>` (`:87-89`), а
  `const`-вывод сохраняет только фактически написанные ключи → доступ по
  union-ключу даёт `TS2339`. Лечится нормализацией маппинга до
  `Readonly<T[K]> & { readonly message?: string }` — проверено, даёт
  `string | undefined`.
- **Сообщение не пересекает tool-границу.** `formatToolError` собирает
  `{ error, details?, _hint? }` без поля `message`
  ([tools/mount.ts:225-242](../../../packages/core/src/tools/mount.ts)), а
  `toolResultFromError` кладёт текст в `details` только когда `details` пуст:
  `details: appErr.details ?? { message: appErr.message }`
  (`tools/execute.ts:155`). Код со схемой деталей теряет текст. Это зафиксировано
  точным сравнением в `packages/core/tests/define-errors.test.ts:181-185`.
- **Обратный путь тоже теряет:** `toolErrorFromResult` восстанавливает
  `message = details.message ?? result.code` (`tools/execute.ts:168`).
- **Гипотеза «на 5xx сообщение скрабится» не подтвердилась:** `normalizeError`
  возвращает доменный `AppError` как есть (`internal/errors.ts:98`); скрабятся
  только `REALTIME_CONTRACT_VIOLATION` (`:95-97`) и сырой не-`AppError` throw
  (`:112-113`). HTTP-путь и `ApiError` в браузере (`browser/http.ts:33`,
  `:66-76`) текст доносят.
- **`hint` в определении конфликтует с глобальным `ErrorHintFn`:**
  `mount.ts:233-239` склеивает per-error и глобальный hint через пробел —
  дефолт в реестре начнёт удваивать подсказку.
- Формат ошибок валидации: `[stitchkit] Error "${code}" must declare …`
  (`errors-factory.ts:122-124`); пустая строка в репозитории проверяется через
  `trim() === ''` (`contract/define.ts:372-373`).
- Публичная поверхность не меняется — новых экспортов нет, снапшот
  `public-surface.json` не трогается.

## Результат

- `ErrorDefinition` принимает `message?: string`. **`hint` в объём не входит** —
  он удваивался бы с глобальным `errorHint`.
- Приоритет: аргумент вызова → поле определения → код (последнее — сегодняшнее
  поведение как нижний дефолт).
- `definitions[code].message` типизирован как `string | undefined` и читается по
  union-ключу, а не только точечно.
- Пустой `message` — ошибка на этапе объявления реестра, в формате, зеркальном
  проверке статуса.
- **Асимметрия транспортов принята и задокументирована:** объявленное сообщение
  идёт на HTTP и в типизированный клиент; модель-фейсинг конверт MCP/agent/CLI
  его не несёт и в этой задаче **не меняется** — смена этого конверта была бы
  breaking и отдельным решением.

## План

- [x] `message?: string` в обе ветки union `ErrorDefinition` (`:29-32`).
- [x] Нормализовать `FrozenErrorDefinitions` до
      `Readonly<TDefinitions[TCode]> & { readonly message?: string }` (`:87-89`) —
      без этого главный сценарий не компилируется, а литерал `'gone'` вместо
      `string` течёт в `.d.ts`.
- [x] Приоритет в рантайм-фабрике (`:152-161`): `options.message ??
      definition.message`.
- [x] `validateDefinition` (`:116`): если `message` задан — строка и
      `trim() !== ''`, иначе ошибка в формате `:122-124`.
- [x] Тесты в `packages/core/tests/define-errors.test.ts`: сообщение из
      определения попадает в `AppError.message`; аргумент вызова перебивает;
      реестр без `message` даёт код; пустая строка отвергается;
      `definitions[code].message` читается по union-ключу (тип-кейс);
      tool-проекция кода **с деталями** по-прежнему без текста — закрепить
      асимметрию тестом, а не оставлять её незамеченной.
- [x] ADR `docs/decisions/0077-error-definition-carries-its-message.md` —
      ADR 0058 дословно фиксирует форму `{ status, details? }`, а ADR
      неизменяемы; строка 0058 в `docs/decisions/README.md` — `Accepted —
      extended by 0077`.
- [x] `docs/guide/auth-and-errors.md`: раздел `defineErrors` (пример на
      `:331-336` демонстрирует ровно перебиваемый случай — переписать, иначе
      гайд учит держать текст на call-site) и абзац `:349-352` про проекции —
      добавить явную оговорку, что модель объявленного текста не видит.
- [x] `docs/api/reference.md:162` — строка `ErrorDefinition` описывает форму
      `{ status, details? }`.
- [x] `CHANGELOG.md` → `[Unreleased]`: `### Added` для типизированного `message`
      **плюс** пункт в `### ⚠️ Breaking changes` (раздел в 0.50.0 уже будет):
      реестр, который **уже** несёт строковый `message`, сегодня отдаёт на
      провод код, а после правки — объявленный текст. Класс узкий, но это
      изменение поведения, и по правилу «никогда молча» оно обязано быть
      названо.

## Acceptance

- [x] `defineErrors({ X: { status: 404, message: '…' } })` → `errors.X().message`
      равен объявленному тексту — `packages/core/tests/define-errors.test.ts`.
- [x] `errors.X({ message: '…' })` перебивает определение — кейс там же.
- [x] Реестр без `message` даёт `message === code` — регресс-кейс.
- [x] Пустой `message` — ошибка на этапе `defineErrors`.
- [x] `definitions[code].message` типизируется как `string | undefined` при
      доступе по union-ключу.
- [x] `define-errors.test.ts:181-185` (tool-проекция без текста) остаётся
      зелёным без правок — доказательство, что конверт тулов не тронут.
- [x] ADR 0077 существует; строка 0058 в `docs/decisions/README.md` помечена как
      расширенная.
- [x] `CHANGELOG.md` называет изменение поведения для реестров, уже несущих
      `message`.
- [x] `bun run verify` зелёный.

## Что сделано

### Core

- [x] `message?: string` в обе ветки union `ErrorDefinition` —
      `packages/core/src/contract/errors-factory.ts`.
- [x] `FrozenErrorDefinitions` нормализует необязательный ключ, иначе
      `definitions[code].message` не компилируется по union-ключу.
- [x] Приоритет в рантайм-фабрике: `options.message ?? definition.message`,
      ниже — сам код (прежнее поведение).
- [x] `validateDefinition` отвергает пустую строку **и нестроковое значение** —
      иначе JS-вызов получал сырой `TypeError: definition.message.trim is not a
      function` вместо stitchkit-ошибки, в отличие от соседних проверок.
- [x] `hint` в объём не вошёл: он склеивается с общим `ErrorHintFn` через пробел
      и дублировал бы подсказку на каждом экземпляре кода.
- [x] Обновлён docstring самого файла — он едет в `.d.ts` к потребителю и
      показывал ровно тот анти-паттерн, который фича убирает.

### Тесты

`packages/core/tests/define-errors.test.ts`:

- [x] `defineErrors — declared message > uses the declared message when the call site gives none`
- [x] `defineErrors — declared message > a per-call message overrides the declared one`
- [x] `defineErrors — declared message > a code without a declared message still falls back to the code`
- [x] `defineErrors — declared message > the declared message is readable by a union key and by a narrowed string`
- [x] `defineErrors — declared message > an explicit message: undefined falls through to the declared text`
- [x] `defineErrors — declared message > a non-string message is rejected with a stitchkit error, not a TypeError`
- [x] `defineErrors — declared message > an empty declared message is rejected when the registry is declared`
- [x] `defineErrors — declared message > the declared message reaches the HTTP envelope`
- [x] `defineErrors — declared message > the model-facing tool projection still carries no message — by design`
- [x] `defineErrors — declared message > a code without a details schema delivers the declared text as details.message`

### Документация

- [x] ADR `docs/decisions/0077-error-definition-carries-its-message.md`; строка
      0058 в `docs/decisions/README.md` помечена как расширенная.
- [x] `docs/guide/auth-and-errors.md` — раздел `defineErrors` переписан, добавлена
      таблица «что видит HTTP / что видит модель».
- [x] `docs/api/reference.md` — `ErrorDefinition` описан как
      `{ status, message?, details? }`.
- [x] `CHANGELOG.md` — `### Added` плюс отдельный breaking-пункт со своим
      before → after.
- [x] `docs/guide/upgrading.md` — секция миграции для этого breaking-пункта.

### Дефекты, найденные валидатором реализации (все исправлены)

- [x] **Ключевое утверждение доков было ложным.** Я написал «объявленный текст
      не пересекает tool-границу». Для кода **без** схемы деталей он её
      пересекает: `tools/execute.ts` заполняет `details` как
      `{ message: appErr.message }`, и там теперь стоит объявленный текст вместо
      кода. Это часть breaking-класса, и она нигде не была названа. Исправлено
      в гайде (таблицей), в ADR 0077, в CHANGELOG и закреплено тестом на
      изменившейся ветке.
- [x] **Тест пинил невыгодную ветку.** Единственный tool-тест использовал код
      **со** схемой деталей, где текст не появился бы в любом случае — то есть
      был зелёным по причине, не связанной с изменением. Добавлен кейс на код
      без деталей (и контрольный — что код без объявленного `message` не
      изменился).
- [x] **Сырой `TypeError` на нестроковом `message`** — см. Core.
- [x] **Ложное обоснование в комментарии** («не даёт литералу течь») — на деле
      `'gone' & string` остаётся `'gone'`. Формулировка исправлена; вторая
      половина обоснования (доступ по union-ключу) валидатором подтверждена.
- [x] **`CHANGELOG`: ```ts-блок был привязан к чужому пункту** — агент апгрейда
      читает снипет каждого пункта и получил бы пример про `scope`. Разнесено.
- [x] **В `upgrading.md` не было секции для второго breaking-пункта** — добавлена.

### Чего не делали

- [x] Модель-фейсинг конверт тулов (`{ error, details?, _hint? }`) не менялся:
      добавление в него `message` — отдельное breaking-решение.
- [x] Пример `packages/create-stitchkit/examples/repository` не мигрирован на
      объявленный `message`: его лейн типизируется против опубликованной версии,
      где поля ещё нет. Вместе с переводом стартера на `bindProcessSignals` —
      отдельным проходом после релиза 0.50.0.
