---
title: Контекст хендлера по эффективному скоупу эндпоинта
description: createScopedImplement типизирует ctx каждого хендлера по эффективному скоупу его эндпоинта, снимая суперсет-контекст, который обещает поля там, где рантайм их не даёт.
type: task
status: done
created: 2026-08-17
updated: 2026-08-17
completed: 2026-08-17 14:04 +00:00
related: docs/decisions/0024-scope-driven-mounting.md
---

# Контекст хендлера по эффективному скоупу эндпоинта

## Зачем

`createImplement<TCtx>()`
([implement.ts:197](../../../packages/core/src/server/implement.ts)) фиксирует
**один** тип контекста на **все** скоупы приложения. Многоскоупное приложение
вынуждено объявить суперсет-интерфейс, и тогда `public`-хендлер видит
`ctx.userId` типизированным как `string`, хотя рантайм его туда не инжектит.
Тип утверждает конкретное — рантайм отдаёт `undefined`.

ADR 0024 назвал этот разрыв и **отложил** решение, предложив обходной путь:
вызывать `createImplement<Ctx>()` по разу на скоуп. Обходной путь не работает на
реальном коде — у потребителей эффективный скоуп задаётся **поэндпоинтно**, в
одном контракте соседствуют эндпоинты разных скоупов, и «одна фабрика на скоуп»
требует раздробить контракты по скоупам, то есть переписать публичный API
приложения ради типизации. Важно: ADR 0024 откладывал фабрику, привязанную к
`meta.scope` **контракта**; здесь проектируется другая вещь — привязка к
эффективному скоупу эндпоинта. ADR обязан это проговорить, иначе выглядит
разморозкой отложенного, а не новым решением.

Второй, более узкий симптом — поэндпоинтный `scope` не упирается в словарь
приложения. `createContractFactory<Scope>()` делает скоуп **контракта**
обязательным и типизированным, но поэндпоинтное переопределение остаётся
свободной строкой. Опечатка там не «молчит» полностью: `createAuthHook` падает
fail-closed с `[stitchkit] auth: no rule for scope "<typo>"`
([middleware/auth.ts:243](../../../packages/core/src/server/middleware/auth.ts)),
а `scopePrefixes` поэндпоинтный скоуп вообще не читает — он индексируется
скоупом сервиса ([create.ts:580](../../../packages/core/src/server/create.ts)).
Реальный выигрыш здесь скромнее и честнее: **ошибка компиляции вместо падения на
первом запросе**, и полное молчание — только у потребителя со своим
`beforeHandle` вместо `createAuthHook`.

## Подтверждённая механика

Проверено валидаторами по коду:

- **`const`-инференс литерал сохраняет — проверять нечего.** `defineContract`
  ([define.ts:339](../../../packages/core/src/contract/define.ts)) уже доносит
  строковые литералы на произвольной глубине через поля, объявленные как голый
  `string`: `mcp.inputRequired[0].key` объявлен `key: string` (`define.ts:127`),
  а `InferMcpInput` ремапит по литералу, что типизировано в
  `packages/core/tests/mcp-mrtr.test.ts:88-106` под `tsc --noEmit`. Union
  `EndpointDef` и `scope?: string` инференс не ломают.
- **Границы инференса есть:** литерал теряется, если эндпоинт вынесен в
  переменную, собран спредом или помечен `satisfies EndpointDef` — тогда
  `scope: string`, эффективный скоуп схлопывается в `string`.
- `ContractDef<T, TScope>` несёт скоуп контракта литеральным типом
  (`define.ts:325`); контракт без `scope` — `'public'` (`define.ts:342`).
- Поэндпоинтный `scope` объявлен **в двух местах**: `EndpointDefBase.scope`
  (`define.ts:44`) и отдельно `HeadEndpointDef.scope` (`define.ts:278`).
- Эффективный скоуп уже вычисляется в рантайме: `endpoint.scope ?? groupScope`
  (`implement.ts:142`).
- `Handlers<C, TCtx>` живёт в
  [server/types.ts:79-86](../../../packages/core/src/server/types.ts) (не в
  `implement.ts`), дефолт базы — `HandlerContext`, а **streaming-ветка вообще не
  функция**: `StreamingMultipartImplementation`.
- `defineMultipartStream` (`implement.ts:60`) жёстко фиксирует
  `EndpointHandlerContext<E, RuntimeContext>` — streaming-эндпоинт не получает
  полей контекста уже сегодня, даже через `createImplement<Ctx>()`.
- **Index signature решает главное ограничение:** `RuntimeContext`
  (`define.ts:596`) и `HandlerContext` (`define.ts:617`) несут
  `[key: string]: unknown`, `noPropertyAccessFromIndexSignature` выключен.
  Значит поле чужого скоупа читается как `unknown`, а не как ошибка.
  Убрать индексную сигнатуру нельзя — на неё пишут транспорт и `auth.inject`.
- `implement` и `RegistryHandlers` принимают `ContractDef<T, string>`
  (`implement.ts:188`, `:224`) — скоуп контракта стирается; scoped-варианты
  обязаны его инферить.
- Образец хорошей ошибки про недостающий ключ словаря — `ScopeClientConfigs` в
  [browser/client.ts:271-278](../../../packages/core/src/browser/client.ts)
  («Property 'manager' is missing»).
- Образец ужесточения через пересечение на том же `const`-параметре —
  `config.files: R & Record<Exclude<keyof R, …>, never>` (`implement.ts:58`).

## Результат

- `createScopedImplement<TScopes>()` — **type-only** дженерик без рантайм-аргумента,
  зеркально `createImplement<TCtx>()`. Карта `scope → поля контекста` — типы, не
  значения: рантайм-карта заставила бы потребителя писать `{} as ManagerCtx`.
- Хендлер каждого нестримингового эндпоинта типизирован по **эффективному**
  скоупу этого эндпоинта. Один контракт со смешанными скоупами получает разные
  типы `ctx` на разных эндпоинтах.
- Поля объявленного скоупа типизированы точно. Поле **чужого** скоупа
  вырождается в `unknown` — не ошибка на чтении (индексная сигнатура), но
  использовать его в типизированной позиции нельзя. Ложное обещание `string`
  там, где рантайм даёт `undefined`, исчезает — это и есть цель.
- Эффективный скоуп вне карты — ошибка компиляции **на конкретном эндпоинте**, с
  читаемым текстом, а не `not assignable to never`.
- Карта скоупов покрывает все три формы, которыми пользуется приложение:
  одиночный контракт, реестр (`createScopedImplementRegistry`) и streaming
  multipart (`createScopedImplement(...).stream`). Переход на один примитив не
  стоит типизации другого.
- Рантайм `bindContract` не меняется; возвращается тот же `ServiceDef`.
- Карта `TScopes` — **утверждение приложения, а не инвариант фреймворка**:
  инжектит поля `beforeHandle` / `createAuthHook.inject` потребителя, один на все
  скоупы (`auth.ts:198`). ADR обязан зафиксировать это как принятое следствие.

## План

- [x] `EffectiveScope<TEndpoint, TContractScope>` в `server/types.ts`:
      `TEndpoint extends { scope: infer S extends string } ? S : TContractScope`.
- [x] `ScopedHandlers<C, TContractScope, TScopes>` рядом с `Handlers`
      (`types.ts:79-86`): streaming-ветка — как сегодня; иначе
      `EffectiveScope<…> extends keyof TScopes ? (ctx: EndpointHandlerContext<C[K],
      HandlerContext & TScopes[EffectiveScope<…>]>) => HandlerReturn<C[K]> :
      'stitchkit: scope "…" is not declared in createScopedImplement'`.
      Форма-страж обязательна: `TScopes[EffectiveScope<…>]` без неё не
      компилируется **внутри библиотеки**. Ошибка стоит в значении мапы
      хендлеров, чтобы TS сообщил `Types of property 'X' are incompatible`.
- [x] `createScopedImplement<TScopes extends Record<string, object>>()` в
      `implement.ts`. Констрейнт значений — `object`, **не**
      `Record<string, unknown>`: интерфейс без индексной сигнатуры был бы
      отвергнут (ловушка задокументирована в `define.ts:83-87`).
- [x] Возвращаемая фабрика инферит скоуп контракта:
      `ContractDef<T, infer TContractScope extends string>`; внутри вызывает
      существующий `implement` — рантайм не дублируется.
- [x] Скоуп самого контракта ловится констрейнтом
      `TContractScope extends keyof TScopes & string` (образец —
      `browser/client.ts:271-278`).
- [x] Ужесточить поэндпоинтный `scope` в `createContractFactory`.
      **Отклонение от плана:** пересечение-валидатор на аргументе применить не
      удалось — `T & FactoryScopedEndpoints<T, TScope>` протекает в реализацию и
      ломает `ExplicitToolExposureEndpoints<T>` вместе с boundary-мэппингом
      (`factory.ts:130`). Взят констрейнт типа-параметра
      `Record<string, FactoryScopedEndpoint<TScope>>`, которого валидатор
      опасался из-за мусорных excess-property ошибок. Опасение не подтвердилось:
      компилятор даёт `Type '"admn"' is not assignable to type '"admin" |
      "public" | "user"'. Did you mean '"admin"'?` — лучше ожидаемого.
      Проверка структурная, поэтому `HeadEndpointDef` покрыт без отдельной правки.
- [x] Проверить, что `ExplicitToolExposureEndpoints<T>` и boundary-каст
      `mapObjectTypeBoundary` (`factory.ts:35-39`, `:102-107`) переживают смену
      констрейнта; если типовые аргументы каста меняются — обновить комментарий,
      обосновывающий boundary-site.
- [x] Экспорт из `packages/core/src/server/index.ts` **и** из
      `packages/core/src/node.ts`: Node-потребитель не может импортировать
      `stitchkit/server` (там `Bun.serve`), а `node.ts` — ручной ре-экспортный
      список. В `stitchkit/cli` не нужен — он экспортирует только `createCli`.
- [x] `packages/core/tests/fixtures/public-surface.json` — снапшот точного
      набора экспортов, роняет `reference-coverage.test.ts:73-78` без правки.
- [x] `packages/core/scripts/check-public-types.mjs` — каждый тип из публичной
      сигнатуры либо экспортирован, либо внесён в `ACCEPTED` с причиной.
- [x] Рантайм-тест `packages/core/tests/scoped-implement.test.ts`: контракт со
      смешанными скоупами монтируется, `endpoint.scope` совпадает с эффективным,
      контракт без `scope` даёт `'public'`.
- [x] Type-test `packages/core/tests/scoped-implement.type-test.ts`
      (`bun test` его **не** подхватывает — гейт только `bun run check`, поэтому
      никаких `expect()` внутри): поле своего скоупа типизировано точно; поле
      чужого — `unknown` (проверяется присваиванием в `string` под
      `@ts-expect-error`); скоуп вне карты — ошибка на эндпоинте; эндпоинт,
      вынесенный в переменную, схлопывается в `string` и даёт ту же ошибку
      (зафиксировать границу инференса, а не притворяться, что её нет).
- [x] ADR `docs/decisions/0075-per-scope-handler-context.md` (номер 0075
      закреплён за этой задачей; задача про сигналы берёт 0076). Формат — как у
      0024: frontmatter + шапка `- **Status:** … - **Date:**`. Содержание
      обязано сказать: (а) это привязка к эффективному скоупу эндпоинта, а не к
      `meta.scope`, который откладывал 0024; (б) карта скоупов не проверяется
      рантаймом.
- [x] `docs/decisions/README.md`: строку 0024 — `Accepted — the deferred
      scope→context clause superseded by 0075`; новую строку — `Accepted —
      supersedes the deferred scope→context clause of 0024` (прецеденты:
      строки 83/87 и 44-45).
- [x] Гайды: `docs/guide/server.md` **и** `docs/guide/multi-tenant.md:55-58` —
      оба документируют обходной путь «по одному `createImplement` на скоуп».
      Плюс `skills/stitchkit/SKILL.md:34`.
- [x] `docs/api/reference.md` — таблицы `stitchkit/server` и `stitchkit/node`
      (не cli: он не экспортирует `implement`).
- [x] `CHANGELOG.md` → `[Unreleased]`: `### Added` для `createScopedImplement` и
      `### ⚠️ Breaking changes` для ужесточения поэндпоинтного `scope` в
      `createContractFactory` (по `AGENTS.md` stricter validation — breaking
      **по определению**, решать «по факту» нельзя). Минорный бамп → `0.50.0`.
- [x] `docs/guide/upgrading.md` — секция `## Released migration: 0.50.0`.
- [x] Реестровая форма и streaming multipart сделаны **в этом же проходе** (а
      не вынесены в inbox, как планировалось изначально):
      `createScopedImplementRegistry` + `ScopedRegistryHandlers` /
      `ExactScopedRegistryHandlers`, `createMultipartStream<Ctx>()` и
      `createScopedImplement(...).stream(scope, …)`.

## Acceptance

- [x] Поле объявленного скоупа типизировано точно, поле чужого скоупа — `unknown`
      и не присваивается в `string`; скоуп вне карты — ошибка компиляции на
      конкретном эндпоинте. Всё три — кейсы в
      `packages/core/tests/scoped-implement.type-test.ts`.
- [x] Контракт со смешанными скоупами даёт разные типы `ctx` внутри одного
      вызова — кейс там же.
- [x] Поэндпоинтный `scope` вне словаря фабрики — ошибка компиляции; контракты
      без поэндпоинтного скоупа компилируются без правок
      (`contract-factory.test.ts`, `scoped-url-builder-registry.test.ts`,
      `contract-meta-cascade.test.ts` зелёные без изменений).
- [x] Рантайм не изменился: `implement-runtime.test.ts` и
      `implementation-registry.test.ts` зелёные без правок.
- [x] `reference-coverage.test.ts` (снапшот публичной поверхности + строки
      reference) и `check-public-types.mjs` в `bun run build` зелёные.
- [x] ADR 0075 существует; строки 0024 и 0075 в `docs/decisions/README.md`
      оформлены как supersession части решения.
- [x] `CHANGELOG.md` содержит `### ⚠️ Breaking changes` с before → after;
      `packages/core/package.json` — `0.50.0`; `upgrading.md` содержит секцию
      `## Released migration: 0.50.0`.
- [x] `bun run verify` зелёный.

## Что сделано

### Core

- [x] `EffectiveScope`, `ScopeContexts`, `ScopedHandlers` —
      `packages/core/src/server/types.ts:88-137`. Страж
      `EffectiveScope<…> extends keyof TScopes ? … : "<сообщение>"` стоит в
      значении мапы хендлеров.
- [x] `createScopedImplement` — `packages/core/src/server/implement.ts`
      (`export function createScopedImplement`). Type-only дженерик.
      **Отклонение от плана:** внутри зовёт `bindContract`, а не публичный
      `implement`, как было написано в плане: `implement` сузил бы хендлеры до
      одного `Handlers<T, TCtx>`, что и есть суперсет, который задача убирает.
      Рантайм не продублирован, ни одного `as` не добавлено.
- [x] Поэндпоинтный `scope` фабрики ужесточён — `FactoryScopedEndpoint<TScope>`
      в `packages/core/src/contract/factory.ts:49-60`, применён в
      `ScopedDefineContract` и `ExplicitScopedDefineContract`.
- [x] Экспорты: `packages/core/src/server/index.ts`,
      `packages/core/src/contract/index.ts` (`FactoryScopedEndpoint`),
      `packages/core/src/node.ts`.

### Тесты

- [x] Рантайм: `packages/core/tests/scoped-implement.test.ts::createScopedImplement > mounts a contract whose endpoints declare different scopes`
- [x] Рантайм: `packages/core/tests/scoped-implement.test.ts::createScopedImplement > a contract without a scope resolves to public on every endpoint`
- [x] Рантайм: `packages/core/tests/scoped-implement.test.ts::createScopedImplement > runs the handler with the mounted context, unchanged by scoped typing`
- [x] Рантайм: `packages/core/tests/scoped-implement.test.ts::createScopedImplement > keeps the same construction-time completeness check as implement`
- [x] Компиляция: `packages/core/tests/scoped-implement.type-test.ts` — поле
      своего скоупа типизировано точно; чужое поле `unknown` (два кейса под
      `@ts-expect-error`); скоуп вне карты; скоуп контракта вне карты; эндпоинт,
      вынесенный в переменную; опечатка скоупа в обеих формах фабрики.
      Файл проверяется `bun run check`, не `bun test`.

### Документация

- [x] ADR `docs/decisions/0075-per-scope-handler-context.md`; строки 0024 и 0075
      в `docs/decisions/README.md` оформлены как частичная supersession.
- [x] `docs/guide/server.md` — новый раздел «Per-scope handler context»; ссылка
      из раздела `scopePrefixes` вместо старого обходного пути.
- [x] `docs/guide/multi-tenant.md` — обходной путь заменён на карту скоупов.
- [x] `docs/api/reference.md` — строки `createScopedImplement`, `ScopedHandlers`,
      `ScopeContexts`, `EffectiveScope`, `FactoryScopedEndpoint`; таблица
      `stitchkit/node` обновлена.
- [x] `skills/stitchkit/SKILL.md` — шаг 2.
- [x] `CHANGELOG.md` `[Unreleased]` — `### ⚠️ Breaking changes` (ужесточение
      фабрики, before → after) и `### Added` (`createScopedImplement`).
- [x] `docs/guide/upgrading.md` — секция `## Released migration: 0.50.0`.
- [x] `packages/core/package.json` → `0.50.0`.
- [x] `packages/core/tests/fixtures/public-surface.json` — +10 имён.

### Доковый дрифт, найденный валидаторами реализации

- [x] `docs/guide/contracts.md` «## Scope» — добавлено, что union фабрики
      покрывает и поэндпоинтные override, с before → after.
- [x] `docs/api/reference.md` — описания `createContractFactory` и
      `ScopedDefineContract` отражают новое ограничение.
- [x] `docs/guide/auth-and-errors.md`, `skills/stitchkit/SKILL.md` (шаг 1),
      `docs/guide/server.md` — оговорка к «scope — свободная строка».
- [x] `docs/guide/server.md` — «Two boundaries» при трёх пунктах.
- [x] ADR 0075 — добавлен `description:` во frontmatter (конвенция ADR 0060+).
- [x] `CHANGELOG.md` — текст ошибки компилятора приведён дословно (в нём есть
      `| undefined`, которого в первой редакции не было).
- [x] Type-кейс на `HeadEndpointDef` — `scoped-implement.type-test.ts`.

### Дефекты, найденные валидатором типов (все исправлены)

- [x] **Блокирующий:** база контекста была `HandlerContext`, у которого
      `params`/`input` — `undefined`. Пересечение с выведенными схемами
      эндпоинта редуцировало **весь** контекст в `never`, и это проходило гейты,
      потому что `never` присваивается куда угодно, а ни один эндпоинт в тестах
      не объявлял `params`/`input`. База заменена на `RuntimeContext`
      (`types.ts`), добавлен регресс-кейс с `params` и `input`.
- [x] `EffectiveScope` проверял обязательность свойства, а не наличие ключа:
      эндпоинт с условным спредом (`scope?: 'public'`) молча получал скоуп
      контракта. Теперь опциональный скоуп даёт **оба** скоупа, и хендлер
      типизируется по их общей части.
- [x] `.stream` принимал любой ключ карты для эндпоинта **без** собственного
      `scope` — фреймворк сам писал тот суперсет-обман, который задача убирает.
      Теперь эндпоинт обязан объявить свой `scope`, принимается только он;
      скоуп вне карты даёт именованное сообщение вместо тихого вырождения.
- [x] Реестровая форма не проверяла скоуп контракта — один контракт проходил
      через реестр и падал через `createScopedImplement`. Проверка перенесена на
      параметр контрактов (`ScopedImplementationRegistry`): условный тип внутри
      мапы хендлеров ломал контекстную типизацию неаннотированного `ctx` —
      ровно то, о чём предупреждал валидатор плана.
- [x] Ключи карты скоупов должны быть строковыми литералами: index-signature
      делает страж бесполезным, числовой ключ недостижим. Задокументировано в
      гайде и в ADR 0075.
- [x] Слепые зоны тестов закрыты: `params`/`input`, условный спред, `.stream`
      без скоупа эндпоинта, `.stream` со скоупом вне карты, реестр со скоупом
      контракта вне карты.

### Гейты (прогон после всех правок)

- [x] `bun run lint` — зелёный.
- [x] `bun run check` — зелёный (включая оба type-теста).
- [x] `bun run test` — 1169 + 24 + 25 тестов, 0 падений.
- [x] `bun run build` — зелёный, включая `check-public-types` и `gen:llms`.
- [x] `bun run verify` целиком (со starter-lane, consumer-lane и Node smoke) —
      зелёный, прогнан один раз после всех трёх задач батча.

### Реестровая форма и streaming multipart (добавлено в этот же проход)

- [x] `ScopedRegistryHandlers` / `ExactScopedRegistryHandlers` и
      `createScopedImplementRegistry` — `packages/core/src/server/implement.ts`.
      Скоуп контракта инферится из реестра
      (`ContractDef<infer TEndpoints, infer TContractScope extends string>`).
- [x] `MultipartStreamConfig<E, R, TCtx>` + внутренний `buildMultipartStream` —
      рантайм вынесен из `defineMultipartStream`, потому что контексты
      контравариантны и одна типизированная обёртка не может делегировать другой.
      Хендлер приходит в builder как `unknown`; каждая обёртка уже проверила его
      против своего контекста, а рантайм отдаёт туда только объект контекста —
      каст не понадобился.
- [x] `createMultipartStream<TCtx>()` — фиксирует контекст для streaming, как
      `createImplement` для обычных хендлеров.
- [x] `createScopedImplement(...).stream(scope, endpoint, config)` — скоуп
      передаётся значением: эндпоинт без своего `scope` наследует контрактный, а
      он в этой точке не виден. Если эндпоинт свой `scope` объявил, принимается
      только этот литерал (тип параметра — условный от `E`).
- [x] Рантайм: `packages/core/tests/scoped-implement-registry.test.ts::createScopedImplementRegistry > binds every contract and keeps each endpoint effective scope`
- [x] Рантайм: `packages/core/tests/scoped-implement-registry.test.ts::createScopedImplementRegistry > keeps the registry mismatch checks of implementRegistry`
- [x] Рантайм: `packages/core/tests/scoped-implement-registry.test.ts::createScopedImplementRegistry > keeps the per-contract endpoint mismatch check`
- [x] Рантайм: `packages/core/tests/scoped-implement-registry.test.ts::createScopedImplement().stream > builds a streaming implementation whose handler reads the scope context`
- [x] Рантайм: `packages/core/tests/scoped-implement-registry.test.ts::createScopedImplement().stream > still rejects receivers that do not match the declared file fields`
- [x] Компиляция: `packages/core/tests/scoped-implement.type-test.ts` — реестр
      типизирован поэндпоинтно, чужое поле `unknown`, пустой реестр отвергнут;
      streaming-хендлер видит поля скоупа, чужой скоуп для эндпоинта со своим
      `scope` отвергнут.

### Чего не делали

- [x] `RuntimeContext` не расщеплялся — цена больше выигрыша, обоснование в
      ADR 0075.
