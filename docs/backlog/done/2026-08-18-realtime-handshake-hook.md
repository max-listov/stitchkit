---
title: "Типизированный handshake-хук для realtime: Zod-валидация и typed socket.data"
description: Zod-first аутентификация Socket.IO-рукопожатия как абстракция уровня фреймворка — идентичность соединения типизирована так же, как события, без разбросанных String(raw.data.x).
type: task
status: done
created: 2026-08-18
updated: 2026-08-18
completed: 2026-08-18 17:10 +07:00
---

# Типизированный handshake-хук для realtime

## Зачем

Гайд честно говорит «the gate is your logic» и показывает голый
`socket.io.use()` с нетипизированным `s.data.user`. Следствие хуже десяти
лишних строк: контракт типизирует события, но **не типизирует того, кто их
шлёт** — по коду consuming project разбросаны `String(raw.data.nodeId)`. Для
фреймворка, чей смысл «типы едут из одного объявления», это шов. Домена здесь
нет: схему identity приносит приложение, как и в HTTP-auth-хуке.

## Результат

- `createSocketIOServer({ handshake })`: приложение даёт Zod-схему handshake
  payload (`auth`/`query`) и `verify(parsed, ctx) => TData` (sync/async;
  throw/`null` → отказ **до** контрактного слоя).
- Результат кладётся в `socket.data`, и тип `TData` протекает в connection
  handlers / `implementRealtime`-слой — identity читается без кастов.
- Отказ рукопожатия отличим на клиенте от транспортной ошибки (детерминированное
  сообщение/код в `connect_error`).
- Гайд заменяет рецепт «пиши io.use сам» на хук; сырой `io` остаётся для
  остального (rooms, middleware) — мы оборачиваем Socket.IO, не конкурируем
  (ADR 0008).

## Уточнения после план-валидации (2 валидатора, пробы на socket.io 4.8.3)

- **Механика подтверждена**: `io.use`-ошибка останавливает всё до `connection`
  (event-хендлеры и наш `onRejected`-слой недостижимы by construction);
  `err.data` доезжает до клиента в `connect_error` — детерминированный код
  кладём туда (`{ code: 'handshake_rejected' }`).
- **Критично (проба)**: после middleware-отказа socket.io-client **не ретраит
  вообще** (`active === false`, клиент мёртв до ручного connect) — в отличие от
  engine-`allowRequest`-отказа, который ретраится бесконечно. Текущий гайд
  (realtime.md:229-231) утверждает обратное — исправить. Наш клиентский враппер
  `connect_error` не слушает и после отказа заблокирован намертво (ранний
  return в `connect()` по `desiredConnected`). Scope расширен: клиент получает
  `onConnectError?: ({ message, data, terminal }) => void`; при терминальном
  отказе (`!socket.active`) `desiredConnected` сбрасывается, чтобы повторный
  `client.connect()` перечитал function-`auth` — путь «отказ → ротация токена →
  connect()» становится рабочим и тестируется.
- **Критично (проба)**: socket.io НЕ ловит rejected promise из async
  middleware (unhandledRejection + зависшее рукопожатие) — `verify` всегда
  оборачивается `Promise.resolve().then(...).then(next-ok, next-err)`, сырой
  async в `io.use` не передаётся.
- **Типовая протяжка** (cast-free, подтверждено): `SocketIOServerConfig<TData>`
  → `createSocketIOServer<TServer, TClient, TData>` → `SocketIOServerHandle.io:
  Server<TClient, TServer, DefaultEventsMap, TData>` → `RealtimeServerHandle<TData>`
  → `RealtimeServerConnection.raw: Socket<..., TData>`; `socket.data = verified`
  присваиванием (не Object.assign). Дефолт `TData = any` — совместимость (без
  breaking); type-test пинит **точный** тип equality-хелпером при заданном
  handshake.
- **Ограничение TS (в ADR)**: partial type-argument inference отсутствует —
  вывод `TData` работает на вызовах без явных event-generics (realtime-лэйн,
  ради которого фича); с явными generics третий параметр передаётся явно.
- Логика уже единая: `socket-io-node.ts` — типовой фасад; middleware вешается
  один раз в `socket-io.ts` сразу после `new Server` (до Bun/Node-ветвления);
  node-фасаду — только протяжка generic'а. Тип конфига — в `socket-io-config.ts`
  (types-only), рантайм-строитель — в `socket-io.ts`.
- Схема матчит `handshake.auth` (структурированный JSON; `query` — строки,
  второстепенный канал с оговоркой). Без `verify` → `TData = z.output<TSchema>`
  через generic-default (не оверлоады). Sync-форма `verify` допускает `null`:
  `TData | null | Promise<TData | null>`.
- Наш wrapper-middleware всегда первый; app-`io.use` после него видят уже
  типизированный `socket.data` — задокументировать.
- Починить и второй абзац гайда (empty-auth fallback: «server gate can reject»
  теперь означает терминальный отказ, не ретрай).
- Процесс: обновить `public-surface.json` (новые экспортируемые типы), строка в
  `docs/decisions/README.md`, формулировка «implementRealtime-слой» в этом доке
  означает `bindRealtimeServer` (другого API нет).

## План

- [x] Спроектировать форму: `handshake: { schema: ZodType<TParsed>, verify?:
      (parsed: TParsed, ctx: { handshake }) => TData | Promise<TData | null> }`;
      без `verify` — `TData = TParsed`. Решить, что именно матчит schema:
      `handshake.auth` (основной кейс) или весь handshake — зафиксировать в ADR.
- [x] Реализация через `io.use()` внутри врапперов (`socket-io.ts` +
      `socket-io-node.ts`) — единая логика, отдельно от engine-level
      `allowRequest` (тот остаётся transport-гейтом, это — identity-гейтом;
      разницу задокументировать).
- [x] Прокинуть generic `TData` в типы lifecycle/сокета так, чтобы
      `socket.data` в обработчиках был типизирован; без `as` — если Socket.IO
      generics позволяют это нативно (`Server<…, SocketData>`), использовать их.
- [x] Ошибки: невалидная схема → отказ с детерминированным кодом
      (`handshake_rejected` / сообщение из verify-throw); документировать
      поведение клиента (`connect_error`, retry-семантика).
- [x] Тесты: пропуск с типизированной identity, отказ по схеме, отказ по
      verify-throw, async verify, реконнект с ротацией токена (function-форма
      `auth` на клиенте), type-test на протекание `TData` **до
      `bindRealtimeServer().onConnection` включительно** — потребителю важно,
      чтобы `socket.data` был типизирован именно там, а не только внутри
      `io.use` (явный запрос живого потребителя).
- [x] Docs: realtime guide (заменить raw-рецепт, оставив его как «низкоуровневый
      путь»), api reference, ADR, CHANGELOG.

## Acceptance

- [x] В тестовом приложении identity соединения читается из `socket.data` без
      единого приведения типов; type-test пинит это.
- [x] Невалидное рукопожатие не доходит до контрактного слоя и не вызывает
      `onRejected` событий (это разные слои).
- [x] `bun run verify` зелёный.

## Что сделано

- Core:
  - [x] `packages/core/src/server/socket-io-config.ts` — `SocketIOHandshakeConfig<TParsed, TData>` (schema по `handshake.auth`, sync/async `verify`, `null`/`undefined`/throw → отказ), `SocketIOServerConfig<TParsed = any, TData = TParsed>`
  - [x] `packages/core/src/server/socket-io.ts` — `handshakeMiddleware` (первый `io.use`, до Bun/Node-ветвления; try/catch вокруг `safeParse`; verify в settled-цепочке — socket.io не ловит rejected promise; сырые сообщения throw НЕ уходят на провод — политика never-leak, лог server-side), `handshakeRejection` с `err.data.code = 'handshake_rejected'`; generics `createSocketIOServer<S, C, TParsed = any, TData>` (дефолт `any` сохраняет `socket.data: any` без гейта — аддитивность)
  - [x] `packages/core/src/server/socket-io-node.ts`, `packages/core/src/server/realtime.ts` — протяжка `TData` до `RealtimeServerConnection.raw.data`; экспорт `SocketIOHandshakeConfig` из `stitchkit/server` и `stitchkit/node`
  - [x] `packages/core/src/browser/socket-io.ts` — `onConnectError({ message, data, terminal })`; при терминальном отказе (`!socket.active`) сброс connection intent → повторный `connect()` перечитывает function-`auth`
- Тесты (`packages/core/tests/socket-io-handshake.test.ts`, 7 кейсов):
  - [x] `a valid handshake delivers the typed identity to onConnection and app middleware` (+ Equal-type pin, не вакуумный — Equal<any, X> = false)
  - [x] `a schema-invalid handshake is rejected terminally with a deterministic code`
  - [x] `a throwing async verify rejects generically — raw error text never reaches the peer`
  - [x] `verify returning null rejects`
  - [x] `recovery: rejected handshake → rotate token → connect() re-reads auth and succeeds` (падает по таймауту без сброса intent — проверено валидатором трассировкой)
  - [x] `handshake rejection never reaches the realtime onRejected hook`
  - [x] `without verify, the schema output itself is the typed identity`
- Docs: `docs/guide/realtime.md` (замена raw-рецепта на гейт; исправлен ложный абзац про «keeps retrying»; политика сообщений; терминальность + recovery), ADR 0079 + строка индекса, reference.md, CHANGELOG `[0.53.0]`, `public-surface.json`
- Отклонения/решения валидации:
  - [x] Дефолт generics `any` (не `unknown`) — иначе тихий breaking на no-handshake lane
  - [x] Сообщения verify-throw нормализованы (изначальный тест пинил проброс — переделан)
  - [x] Node-lane покрыт общей логикой (middleware до ветвления), отдельного node-smoke handshake-кейса нет — зафиксировано осознанно
