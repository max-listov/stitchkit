---
title: Local-WS contract lane + per-method replay + sticky-events (renderer↔sidecar граница)
description: Запрос на first-class поддержку локальной RPC-границы (webview/renderer ↔ свой Bun-sidecar) как обычного defineContract. Нужны три вещи, которых сейчас нет — per-method replay-policy (durability через респавн процесса), sticky-replay последнего события поздним подписчикам, и raw-WS + secret-handshake транспорт (вместо socket.io/JWT). Сейчас мы катаем это ~1000 строк руками параллельно StitchKit.
type: task
status: done
created: 2026-06-05
updated: 2026-06-05
completed: 2026-06-05 10:47
related: docs/backlog/done/2026-06-05-client-multipart-file-descriptor.md
---

> **Решение (2026-06-05):** путь **(ii)** — НЕ строим полноценный reliable-RPC
> движок (это competing engine, против ADR 0008). Вместо этого даём примитивы для
> bring-your-own-transport: консьюмер гоняет свою raw-WS трубу через `defineContract`.
> Закрывает ~80% боли (реестр на 510 строк → контракт, типизированные ошибки даром),
> стич остаётся тонким. Полный `localWsLane`-движок — будущий ADR, если несколько
> desktop-консьюмеров упрутся в сам wire. ADR 0027. Сделано ниже.

# Local-WS contract lane + replay + sticky-events

> **Заявка от консьюмера.** a consuming project (Tauri desktop + Bun local-runtime
> sidecar + React renderer + Hono cloud — cloud-поверхность уже целиком на StitchKit 0.8.1:
> `createServer`/`createSocketIOServer`/`createImplement`/`createClients`/`createHttpClient`/
> `createSocketIOClient`/`createRateLimiter`/error-registry/serveFile — образцово). Это большой
> запрос на новую возможность; мы готовы участвовать в дизайне (ADR) и PR. Решайте сами.

## Кто мы и архитектура
Десктоп — три процесса: **React renderer** (webview, UI-only) ↔ **Bun local-runtime** (sidecar:
SQLite, jobs, sync, auth, backend-WS — владелец durable-состояния) ↔ **Rust native-core**.
Renderer общается с runtime по локальной RPC-границе. Cloud (Hono) — отдельно, и там StitchKit
уже идеален. **Боль — именно локальная граница renderer↔runtime.**

## Что у нас сейчас (самописное, ~1000 строк, параллельно StitchKit)
Мы фактически написали второй транспорт рядом со StitchKit, потому что три нужные вещи он не
покрывает:
- **Реестр методов** — свой map `{ [method]: { input, output, replay } }` (~41 метод, ~510 строк),
  переиспользует наши Zod-схемы, но это «`defineContract` руками + поле `replay`».
- **Клиент** (~260 строк) — сырой `WebSocket`, своё framing (`{kind:'req',id,method,params}` /
  `{kind:'res',id,ok,result|error}`), auth-handshake, `Map` pending по id, reconnect.
- **Сервер** (~240 строк) — приём кадров, валидация по схеме метода, диспатч, ответ.

Налог: **3 ручных касания на метод** (реестр + регистрация на сервере + обёртка в клиенте). Это
ровно то, что `defineContract` + генеренный клиент/сервер устраняют на cloud-стороне — но мы не
можем переехать, т.к. не хватает трёх возможностей ниже.

## Три недостающие возможности

### (1) Per-method `replay: 'safe' | 'never'`
Sidecar может рестартовать (краш / авто-апдейт) посреди RPC. Что делать с запросами «в полёте» на
reconnect — зависит от метода:
- **`safe`** — идемпотентные desired-state мутации (`tasks.setDone {id,done:true}`,
  `transcriptions.setPinned`). Переотправляем после reconnect — повтор даёт тот же результат.
  Это и есть durability: юзер нажал, sidecar умер до ack → клиент дослал, мутация не потеряна.
- **`never`** — one-shot side-effects (`capture.start` — начать запись с микрофона). Переотправлять
  нельзя (дубль = вторая запись). После потери транспорта такой запрос реджектится, не повторяется.

Сейчас клиент на reconnect перебирает pending и решает по `replay`. **Просьба:** опциональное поле
`replay` в `MethodDef` (`packages/core/src/contract/define.ts`) + применение этой политики в
lane-клиенте на reconnect. Это главное концептуальное расширение — у StitchKit-контрактов сегодня
stateless «запрос-ответ», а тут нужна durability-семантика поверх ненадёжного транспорта.

### (2) Sticky-event replay
Runtime пушит события (`transcriptions.changed`, `auth.changed`, `capture.stateChanged`,
`backend.connectionChanged`). Подписчик, подключившийся/перерисованный ПОЗЖЕ события, его пропустит
→ UI залипает на устаревшем состоянии до следующего события. Мы держим
`lastEventByType: Map<event,payload>` и при `subscribe()` сразу реплеим последнее значение каждого
типа — поздний подписчик мгновенно догоняет актуальное. **Просьба:** «retained last value per topic»
в pub/sub lane (как MQTT retained / BehaviorSubject). Сейчас `createSocketIOClient`
(`packages/core/src/browser/socket-io.ts`) — обычный pub/sub без памяти последнего значения.

### (3) Транспорт raw-WS + secret-handshake (вместо socket.io / JWT)
Это локальная граница внутри одного приложения (webview ↔ свой sidecar на localhost):
- **Raw WebSocket, не socket.io** — не тащить socket.io-клиент в бандл рендерера; сырой WS легче и
  достаточно.
- **Secret-handshake, не JWT** — аутентификация тут «ты тот же процесс?», секрет shell передаёт
  обоим при спавне (`{kind:'auth', secret}`), без bearer/TTL/refresh.

StitchKit уже имеет понятие lane (`socketIoLane`, `webSocketLane`, `composeWebSocketHandlers` —
`packages/core/src/server/websocket.ts`). **Просьба:** новый `localWsLane` — транспорт-адаптер
(raw-WS framing + secret-handshake) c интеграцией (1) replay и (2) sticky. Контракт остаётся
транспортно-нейтральным; lane решает «как по проводу».

## Как это выглядело бы (эскиз, концептуально)
```ts
// shared — обычный контракт + replay в метаданных
export const runtimeContract = defineContract({ prefix: 'runtime', transport: 'local-ws' }, {
  'transcriptions.list': { input: listQuery, output: page },                 // replay по умолч. safe
  'capture.start':       { input: none, output: snapshot, replay: 'never' }, // one-shot
  'tasks.setDone':       { input: taskDone, output: ok, replay: 'safe' },
});

// runtime (как cloud: implement + lane, вместо ws.ts + rpc.ts + 41× регистраций)
const handler = implement(runtimeContract, { 'transcriptions.list': (ctx,p)=>…, … });
serveLocalWs({ handler, secret, stickyEvents: ['transcriptions.changed','auth.changed', …] });

// renderer (генеренный клиент вместо ручного runtimeClient.ts)
const rt = createLocalWsClient(runtimeContract, { url, secret });
await rt.transcriptions.list({ limit: 200 });   // типизировано, replay 'safe' встроен
rt.on('transcriptions.changed', reload);          // sticky-реплей при подписке
```

## Что это разблокирует у консьюмера
- **−~1000 строк** bespoke-транспорта → контракт + генеренные клиент/сервер; 3 касания на метод → 1.
- **Типизированные ошибки бесплатно:** сейчас клиент реджектит `new Error(message.error)` — голая
  строка, рендерер не локализует. Lane понесёт error-envelope с `code` (как `ApiError` на cloud) →
  рендерер получает `ErrorCode` и локализует через i18n.
- **Одна ментальная модель:** локальная граница и cloud — обе `defineContract`.

## Почему это общее, а не частный кейс
Любой Tauri/Electron/desktop-проект с архитектурой «тонкий UI-webview ↔ свой durable sidecar»
получит ту же границу. local-WS lane + replay + sticky — переиспользуемая возможность для целого
класса desktop-консьюмеров StitchKit, не разовый костыль под один консьюмер.

## Трейд-оффы / риски / объём
- **Большое:** фича в ядре (новый lane + `replay` в `MethodDef` + retained-value в pub/sub) → нужен
  ADR + минор-релиз. Потом миграция консьюмера.
- **Durability-чувствительно:** replay-семантику нельзя сломать (safe → переотправка, never → reject)
  — обязательно под тестами в ядре.
- Можно поэтапно: сперва (1) `replay` в `MethodDef` + (3) `localWsLane` (закрывает 80% боли), потом
  (2) sticky-events.

## Ссылки
- Lane-механика: `packages/core/src/server/websocket.ts` (`webSocketLane`/`composeWebSocketHandlers`),
  `packages/core/src/server/socket-io.ts`, клиент `packages/core/src/browser/socket-io.ts`.
- `MethodDef` (куда добавить `replay`): `packages/core/src/contract/define.ts`.
- Связанная заявка: [`client-multipart-file-descriptor`](./2026-06-05-client-multipart-file-descriptor.md).
- Консьюмер-кейс (для контекста, отдельный репо консьюмера): bespoke-реестр (~41 метод),
  ручной клиент и ручной сервер (raw-WS framing + handshake) в их пакетах.

## Что сделано (2026-06-05)

Путь **(ii)** — примитивы для bring-your-own-transport, без нового движка. ADR 0027.

### (1) Per-method durability → `idempotent` (переформулировано из `replay`)
- [x] `idempotent?: boolean` на `EndpointDefBase` (`contract/define.ts`) — генеричное
  транспортно-нейтральное свойство операции (а не десктоп-специфичный `replay:'safe'|'never'`:
  именуем свойство, не политику; политику reconnect-replay транспорт выводит сам).
- [x] Проброс `endpoint.idempotent → MethodDef.idempotent` в `implement.ts` и `tools/remote.ts`;
  поле добавлено в `MethodDef` (`server/types.ts`). Ядро поведения не навешивает (ADR 0002).
- [x] Тест: `tests/dispatch.test.ts` — idempotent течёт контракт→MethodDef, unset = undefined.

### (2) Sticky-event replay → `createRetainedTopics` + `retain`
- [x] `createRetainedTopics<Events>()` (`src/retained.ts`, browser-safe, cast-free через
  `Partial<Events>`) — retained-last-value store: `record`/`replay`/`get`/`clear`. Экспорт из root `stitchkit`.
- [x] Опция `retain?: Array<keyof TServerEvents & string>` в `createSocketIOClient`
  (`browser/socket-io.ts`) — внутренний recorder + replay поздним подписчикам, переживает
  disconnect/connect. `SocketIOClientConfig` стал дженериком с дефолтом (не ломает).
- [x] Тесты: unit на `createRetainedTopics` + e2e sticky на socket.io (поздний подписчик
  получает значение синхронно; переживает reconnect; не-retained не реплеится).

### (3) BYO-транспорт → `createContractDispatcher` (вместо нового движка)
- [x] `createContractDispatcher(services, { source, hooks, lifecycle, … })` (`tools/dispatch.ts`,
  экспорт из `/tools`) — `dispatch(method, args, ctx?)` гоняет метод контракта по ключу через
  **тот же** `executeToolMethod`, что MCP/agent: Zod-валидация, типизированный envelope
  `{ ok, data } | { ok:false, code, details, hint }`, hooks, `beforeHandle`-gate. Unknown → `NOT_FOUND`.
- [x] `TransportSource` открыт (`… | (string & {})`) — BYO-транспорт тегает свои вызовы
  (`source:'local-ws'`), 4 встроенных сохраняют автокомплит. Additive.
- [x] Тесты: `tests/dispatch.test.ts` — валидация, NOT_FOUND, проброс AppError-кода, source-тег,
  beforeHandle-gate, afterToolCall-identity, дубль-метод throw, список methods.

### Docs / ADR / CHANGELOG
- [x] **ADR 0027** «Transport-neutral contract execution (BYO transport)» + строка в индексе.
- [x] `guide/realtime.md` — секции «Sticky events» и «Bring-your-own transport» (+ durability/idempotent).
- [x] `guide/contracts.md` — строка `idempotent` в таблице полей. `api/reference.md` — строки
  `createContractDispatcher`/`ContractDispatcher`/`ContractDispatcherConfig`/`createRetainedTopics`/`RetainedTopics`.
- [x] `CHANGELOG.md` `[Unreleased] → ### Added` (4 пункта).

### Что НЕ делалось (осознанно)
- [x] Полноценный `localWsLane`-движок (raw-WS framing + secret-handshake + reconnect +
  pending-map + генеренный клиент/сервер) — **отклонено**: competing engine против ADR 0008,
  большая durability-чувствительная поверхность на pre-1.0. Консьюмер оставляет свой ~200-строчный
  wire, схлопывает только реестр+типизацию. → будущий ADR, если несколько desktop-консьюмеров
  упрутся в сам wire (решение на основе данных, не одного кейса). Зафиксировано в ADR 0027 (Alternatives).
- [x] `replay: 'safe'|'never'` как поле контракта — **отклонено** в пользу `idempotent: boolean`
  (свойство, не политика). Пометка в ADR 0027.

### Валидация (3 субагента, 2026-06-05)
- [x] **Корректность — PASS** (блокеров нет): диспетчер, idempotent-проброс, sticky/retain,
  открытый union — всё работает; double-guard на `source`; нет leak-листенеров. Nits:
  multi-arg sticky хранит только 1-й arg (задокументировано), `record(undefined)` не реплеится
  (корректный trade-off).
- [x] **Конвенции — PASS**: no `as`, browser-safe (`retained.ts` node-free, диспетчер не достижим
  из root), ADR 0008/0002 соблюдены, нет утечек имён, доки/индекс/CHANGELOG синхронны, чекбоксы закрыты.
- [x] **API-дизайн — SHIP-WITH-NOTES**. Исправлено по замечаниям:
  - [x] **doc-баг** `guide/realtime.md` — хендлер был `(ctx, p) =>` (не компилится) → `(ctx) =>`.
  - [x] **запёрт тестами** security-guard: per-call ctx переопределяет static, но `source` не
    затирается ни static, ни per-call (hostile `source:'evil'` проигрывает); + void-output → `{status:'ok'}`,
    declared `z.null()` output сохраняется.
  - [x] error-envelope диспетчера плоский (`{ok:false,code,details,hint}`, без top-level `message`) и
    не совпадает с вложенным `ApiError`-shape HTTP → **осознанно оставлено**: буквальная потребность
    консьюмера (`code` доезжает до рендерера для i18n) закрыта; `ToolResult` — общий envelope с MCP/agent,
    менять его нельзя. Клиентский reconstructor в `ApiError` — опциональный follow-up, не делаем без запроса.
  - [x] idempotent unset = non-idempotent — инверсия дефолта vs их `replay:'safe'`-по-умолчанию;
    fail-safe, задокументировано в `realtime.md` (миграция: бывшие defaulted-safe методы помечать `idempotent:true`).

### Релиз
- [x] **Минор 0.9.0** (additive целиком: новые экспорты + открытый union + опц. поля, ничего не
  ломает) — батчем с multipart-таском, по команде мейнтейнера.
