---
title: Raw binary WebSocket lane рядом с Socket.IO (Bun)
description: Хелпер для второго, truly-raw бинарного WS-канала на том же Bun.serve, что и Socket.IO — типизированная композиция единственного websocket-хендлера по дискриминатору, без хрупкого ручного ws.data-роутинга.
type: task
status: done
created: 2026-06-05
updated: 2026-06-05
completed: 2026-06-05 20:52
---

# Raw binary WS lane рядом с Socket.IO

## Проблема

На Bun у `Bun.serve` **один** `websocket`-хендлер. Его забирает
`@socket.io/bun-engine` (через `createSocketIOServer().websocket`). Если проекту
нужен **ещё и truly-raw бинарный WS-канал** (высокочастотный поток — PCM, видео,
большие передачи — без socket.io-фрейминга/паркинга), приходится **вручную
композировать** единственный `websocket`-хендлер: дискриминировать сокеты по
`ws.data` и роутить либо в engine, либо в свой raw-handler.

Беда в типизации: тип `ws.data` у bun-engine **непрозрачный**, поэтому
композиция выходит хрупкой и её трудно сделать **cast-free** (нужен либо `as`,
либо неустойчивый type-guard на форму engine-data).

## Мотивирующий кейс

Приложение стримит live-PCM (~50 кадров/с) в STT-сервис. В итоге выбрали отправку
PCM **бинарным socket.io-событием** `pcm(roomId, frame)` — на объёмах PCM
socket.io тянет с запасом, и это избегает ручной композиции. Но для
**по-настоящему высокочастотного бинаря** (видео-стрим, большие передачи) raw-канал
рядом с socket.io, без socket.io-фрейминга и на том же порту/сервере, был бы
правильнее — и тогда задокументированное «raw PCM» решение стало бы чистым.

## Предложение

Маленький хелпер-композитор единственного Bun websocket-хендлера:

```ts
// stitchkit/server
export function composeWebSocketHandlers(
  lanes: Array<{ match: (ws: ServerWebSocket<unknown>) => boolean; handlers: BunWebSocketHandler }>,
): BunWebSocketHandler
```

Он строит один `websocket`-объект (`open/message/close/drain/...`), который на
каждом колбэке выбирает lane по `match(ws)` (дискриминатор обычно в `ws.data`).
Первый lane — `createSocketIOServer().websocket`, второй — raw-PCM handlers.

Альтернатива — `rawWebSocket`-lane прямо в `createServer({ rawWebSocket })`,
который регистрирует upgrade-route + handlers и сам композирует их с
socket.io-хендлером.

Так композиция socket.io + raw живёт **внутри** stitchkit (типизированно,
cast-free, Bun-only), а не копируется хрупко в каждом проекте.

## Заметки

- Bun-only (на Node транспорт socket.io идёт через `http.Server` upgrade-event —
  там расклад другой).
- НЕ срочно: для текущих кейсов socket.io-бинаря достаточно. Это на будущее, когда
  появится реальный high-throughput-binary кейс.
- Идея пришла из миграции реального приложения на stitchkit Socket.IO.

---

## План реализации (проработан 2026-06-05)

### Ключевое открытие — cast-free достижим, прототип прошёл `tsc --noEmit`

Источник хрупкости в ручной композиции — попытка определить «это engine-сокет?»
по непрозрачному `ws.data` bun-engine (`WebSocketData = { transport }`).
**Инверсия:** raw-lane ставит СВОЙ маркер в `ws.data` при upgrade, а socket.io —
**fallback** (`() => true`, последняя lane). Тогда движковую data НИКОГДА не
инспектируем → ноль `as`, ноль хрупких guard'ов на форму engine-data.

Проверено в исходниках:
- Bun `WebSocketHandler<T>` (bun-types `serve.d.ts`): `message` required, остальные
  (`open/close/drain/ping/pong`) optional + конфиг `maxPayloadLength`,
  `idleTimeout`, `backpressureLimit`, `closeOnBackpressureLimit`, `sendPings`,
  `publishToSelf`, `perMessageDeflate`. Конфиг — **глобальный** на сервер.
- bun-engine `handler().websocket` = `{ open, message, close, maxPayloadLength }`,
  `maxPayloadLength = opts.maxHttpBufferSize` (дефолт 1 МБ). → присваиваемо к
  `WebSocketHandler<WebSocketData>`.
- bun-engine upgrade-паттерн (`server.js`): `server.upgrade(req,{data})` →
  `return new Response(null)` на успех, `new Response(null,{status:500})` на
  отказ. Подходит под наш `RawRoute` (возвращает `Response`).
- **Прототип композитора (см. ниже) собран реально:** временный файл в
  `packages/core/src`, `bun x tsc --noEmit` → exit 0, ноль ошибок, ноль `as`.

### Новый файл `packages/core/src/server/websocket.ts` (Bun-only, чистый)

Только type-only импорт `import type { ServerWebSocket, WebSocketHandler } from 'bun'`
— тот же seam, что уже есть у `BunServerConfig`/`BunServer` в `types.ts`. В рантайме
функции чистые (никаких `Bun.*`), поэтому barrel `stitchkit/server` остаётся
импортируемым на Node (ADR 0013).

```ts
export interface ComposedLane {
  match: (ws: ServerWebSocket<unknown>) => boolean
  handlers: WebSocketHandler<unknown>
}
export interface ComposeConfig {
  maxPayloadLength?: number; idleTimeout?: number; backpressureLimit?: number
}

/** Типизированный билдер lane — мост WebSocketHandler<T> → <unknown> через
 *  type-predicate match. Внутри ws сужается guard'ом → cast-free вызов. */
export function webSocketLane<T>(lane: {
  match: (ws: ServerWebSocket<unknown>) => ws is ServerWebSocket<T>
  handlers: WebSocketHandler<T>
}): ComposedLane

/** Один Bun websocket-объект; на каждом колбэке — первый lane по match. */
export function composeWebSocketHandlers(
  lanes: ComposedLane[], config?: ComposeConfig,
): WebSocketHandler<unknown>
```

`composeWebSocketHandlers` прокидывает все колбэки (`open/message/close/drain/
ping/pong`) в первый совпавший lane + кладёт глобальный `config`.

### socket.io-glue — в `packages/core/src/server/socket-io.ts`

```ts
/** Fallback-lane для socket.io — забирает всё, что не забрал raw-lane.
 *  Никогда не инспектирует engine-data (match = () => true). */
export function socketIoLane(websocket: SocketIOServerHandle<…>['websocket']): ComposedLane
```

(внутри `webSocketLane({ match: (_ws): _ws is … => true, handlers: websocket })`).
Нужен helper, т.к. голый `() => true` — не type-predicate и не скомпилируется;
helper инкапсулирует тривиально-истинный predicate. Это НЕ «хрупкий guard на
engine-data» — это честное «fallback обрабатывает то, что осталось».

### Upgrade — обычный `RawRoute` (helper НЕ шипим)

Документируем паттерн (как `socket.route` уже устроен):

```ts
const pcmRoute: RawRoute = {
  method: 'GET', path: '/ws/pcm',
  handler: (req, ctx) => {
    if (!ctx.server) throw new Error('[stitchkit] needs a running Bun server')
    // здесь проектная auth + сборка data
    const ok = ctx.server.upgrade(req, { data: { lane: 'pcm', roomId } })
    return ok ? new Response(null) : new Response(null, { status: 400 })
  },
}
```

Helper для upgrade НЕ добавляем: логика проектная (auth, форма data) и короткая —
шипить обёртку = over-engineering. Примитив композиции — вот ценность.

### Сборка у пользователя

```ts
const ws = composeWebSocketHandlers(
  [
    webSocketLane({ match: isPcmSocket, handlers: pcmHandlers }), // raw — первым
    socketIoLane(socket.websocket),                              // socket.io — fallback
  ],
  { maxPayloadLength: 16 * 1024 * 1024 }, // raw-лейну нужен лимит > 1 МБ socket.io
)
createServer({ services, websocket: ws, rawRoutes: [socket.route, pcmRoute] })
```

### Экспорты `packages/core/src/server/index.ts`

`composeWebSocketHandlers`, `webSocketLane`, `socketIoLane`, типы `ComposedLane`,
`ComposeConfig`.

### Тесты (`packages/core/tests/socket-io.test.ts` или новый `websocket.test.ts`)

- socket.io round-trip продолжает работать через composed-handler (ре-юз
  существующего паттерна).
- raw WS-клиент (нативный `new WebSocket('ws://…/ws/pcm')`) коннектится, шлёт
  бинарь — получает echo; роутинг в raw-handler, НЕ в socket.io.
- raw + socket.io сосуществуют на одном порту/сервере.
- cast-free гарантируется гейтом `bun run verify` (tsc).

### ADR `docs/decisions/0020-raw-websocket-lane.md`

- **Решение:** примитив композиции (`composeWebSocketHandlers` + `webSocketLane`)
  + glue `socketIoLane`; роутинг по позитивному raw-маркеру → socket.io-fallback
  не трогает движковую data (cast-free выигрыш).
- **Отклонено (option B):** `rawWebSocket` прямо в `createServer({ rawWebSocket })`
  — держим `createServer` тонким (он уже тонкая обёртка над `Bun.serve`); upgrade
  — обычный `rawRoute`, симметрично `socket.route`. Примитивов достаточно.
- **Не нарушает ADR 0008** («не шипим конкурирующий WS-engine»): raw-канал — это
  СОБСТВЕННЫЙ Bun-WS приложения; мы лишь типобезопасно КОМПОНУЕМ единственный
  `Bun.serve.websocket`-хендлер, движок не пишем.
- **Bun-only:** на Node socket.io идёт через `http.Server` `upgrade`-event —
  другой расклад; raw-lane там = отдельный upgrade-handler (вне scope, отметить).

### Документация

- `docs/guide/realtime.md` — секция «Raw binary lane (Bun)» с полным wiring.
- `docs/api/reference.md` — новые экспорты.
- `CHANGELOG.md` — Unreleased.

### Edge cases

- **Глобальный конфиг Bun** (maxPayloadLength/idleTimeout) — не per-lane; берём из
  явного `config`. Raw-лейну обычно нужен `maxPayloadLength` > 1 МБ дефолта
  socket.io (= `maxHttpBufferSize`). Документируем.
- **Дискриминатор — позитивный raw-маркер** в `ws.data` (ставим при upgrade),
  socket.io = fallback. Движковую data не читаем.
- **Путь upgrade ≠ `/socket.io/*`** (rawRoutes матчатся раньше контрактов; с
  socket.io не пересекается при ином пути).
- **`return new Response(null)` после успешного upgrade** (паттерн bun-engine) +
  guard `ctx.server` (как в `socket.route`).
- **Backpressure:** `ws.send()` → -1; raw-handler использует `drain` (прокинут
  по lane). Документируем для high-throughput.
- **Порядок lanes:** raw — раньше fallback (first-match-wins).
- **`idleTimeout`:** не задавать меньше, чем нужно socket.io (>2·pingInterval).
- **Node:** не поддержано (другой upgrade-механизм) — отметить в доке/ADR.

---

## Что сделано (2026-06-05)

### Server (`stitchkit/server`, Bun-only)
- [x] `packages/core/src/server/websocket.ts` — `webSocketLane<T>()` (типизированный
  cast-free мост через type-predicate), `composeWebSocketHandlers()`
  (first-match-wins по всем колбэкам + глобальный `config`), типы `ComposedLane`,
  `WebSocketLane`, `WebSocketComposeConfig`.
- [x] `socketIoLane()` — catch-all fallback для socket.io
  (`packages/core/src/server/socket-io.ts`), не инспектирует engine-data.
- [x] Экспорты в `packages/core/src/server/index.ts`.

### Tests (`packages/core/tests/socket-io.test.ts`)
- [x] describe «composed WebSocket lanes (Socket.IO + raw)» (3 теста): raw lane
  обрабатывает свои сокеты (native `WebSocket` → echo, `ws.data` типизирован),
  socket.io round-trip через composed-handler, оба канала конкурентно на одном
  порту. Отдельный `Bun.serve` + raw upgrade-route.

### Docs
- [x] ADR `docs/decisions/0020-raw-websocket-lane.md` + индекс в
  `docs/decisions/README.md` (заодно бэкфилл пропущенных 0015–0019).
- [x] `docs/guide/realtime.md` — секция «Raw binary lane (Bun)» с полным wiring
  (guard, upgrade-route, compose, notes по backpressure/idleTimeout/Node).
- [x] `docs/api/reference.md` — новые экспорты в Realtime (server).
- [x] `CHANGELOG.md` — Unreleased.

### Что НЕ делалось
- `rawWebSocket` в `createServer` — отклонено в ADR 0020 (держим createServer
  тонким; upgrade — обычный `rawRoute`).
- Upgrade-helper не шипим — паттерн в доке (логика проектная: auth + форма data).
- Node-вариант — вне scope (другой upgrade-механизм; отмечено в доке/ADR).

### Verify
- [x] `bun run verify` — зелёный (lint + tsc + 350 tests + build). Cast-free
  подтверждён typecheck-ом (ноль новых `as`).
