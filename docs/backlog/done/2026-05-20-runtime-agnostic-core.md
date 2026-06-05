---
title: Runtime-agnostic ядро — Bun первоклассно, Node поддерживается
description: Сделать stitchkit пригодным для Node без потери Bun-first — ядро Fetch-чистое, но завязок больше, чем казалось, и пол по Node = 22
type: task
status: done
created: 2026-05-20
updated: 2026-06-05
completed: 2026-06-05 20:52
related: docs/backlog/inbox/2026-06-05-node-support-polish.md
---

# Runtime-agnostic ядро

## Зачем

stitchkit перестаёт быть Bun-only и становится универсальным. Bun остаётся
first-class, Node — поддерживаемый рантайм. Причина рыночная: wedge stitchkit —
**MCP/agent-тулы из одного контракта**, и аудитория этого в массе на Node.
Закрывать ей дверь на уровне архитектуры (ADR 0011 Bun-only) — дорого и
необратимо, при почти нулевой цене открытия. **Пересматривает Bun-only пункт
ADR 0011** (пункты «один пакет» и «quality gate» остаются).

## Происхождение

v1 — аудит кода. **v2 — после 3 саб-агентов (Opus, read-only): инвентарь
завязки, адаптерная архитектура, упаковка/типы/CI.** Главные правки v2: «ровно 4
точки» оказалось неверным (реально ~8-10); пол по Node не 18, а **22**; утечка
Bun-типов — баг **уже сегодня**; один открытый спор между агентами (см. ниже).

## Инвентарь рантайм-завязки (исправлен после аудита)

| # | Где | Что | Класс |
|---|-----|-----|-------|
| C1 | `server/create.ts:212,221` | `Bun.serve()` | hard |
| C2 | `server/router.ts:223-227` | `Bun.file()` + `.exists()` + `new Response(BunFile)` — **3 вызова**, плюс бесплатный content-type/Range от `Bun.file` | hard |
| C3 | `server/socket-io.ts` | `@socket.io/bun-engine` | hard |
| C4 | `server/types.ts:79,104-107` + `tsconfig.json` | `BunServer` + ещё 4 type-алиаса + поля `ServerConfig` (`routes`/`websocket`/`development`/`bun`); `BunServer` **ре-экспортнут** = public API | config |
| C5 | `server/swept-map.ts:34` | `setInterval(...).unref()` | diverge |
| C6 | `tools/mcp-handler.ts:113` | `setInterval(...).unref()` | diverge |
| C7 | `package.json` → `ky@^2.0.2` | `ky` декларирует `engines.node:">=22"` | **node-gate** |
| C8 | `server/create.ts:195` | `new URL(req.url)` — Node даёт **путь**, не абсолютный URL → `new URL` **бросает** | hard (в адаптере) |
| C9/C10 | `observability/sanitize.ts:120`, `tools/view-file.ts` | `Buffer.*` — не Web-стандарт (есть в Bun+Node) | diverge-minor |
| C11 | `server/multipart.ts:31` | `req.formData()` — поведенческий риск | diverge-minor |

«Ровно 4 точки» (v1) — **неверно**: реально ~8-10. C5/C6 (`.unref()`) греп по
`Bun.` структурно не видел. `Buffer` вообще не был в алфавите грепа.

**Уже cross-runtime, не трогаем:** весь contract/client/tools/observability/
react-слой; `node:*` билтины; `process.hrtime`/`process.env` (оба рантайма;
ломаются только на Deno/workerd); Web Crypto. `/tools` подтверждённо
runtime-agnostic — `mcp-handler.ts` использует `WebStandardStreamableHTTP
ServerTransport` (SDK ship'ит её именно под Bun/Deno/Workers) → **по `/tools`
работы ноль**.

## Пол по Node — 22, не 18

Связывающее ограничение — **`ky@2` с `engines.node:">=22"`** (`ky` импортится в
`browser/http.ts`, ре-экспортнут из корневого `index.ts`). Сам исходник
stitchkit пошёл бы и на Node 20 (global `File` с 20, Web Crypto с 19), но `ky`
поднимает пол. Текст v1 «Node 18+ имеет `Request`/`Response`» — вводит в
заблуждение, убрано. `engines.node` → **`>=22`**.

## `createHandler` — портируемый, с двумя оговорками

`createHandler` (`create.ts:29`) возвращает чистый `(req)=>Promise<Response>`;
трассировка хелперов — только Web-стандарт. Оговорки:
1. **`new URL(req.url)` (C8)** бросает на Node — Node-адаптер ОБЯЗАН синтезировать
   абсолютный URL из `Host`-хедера. Самый вероятный «работает на Bun, падает на
   Node» баг.
2. Возвращаемая функция — `(req, server?: BunServer)`; 2-й параметр светит
   Bun-тип в сам шов (C4).
3. `staticRoute` (C2) достижим из хендлера, если приложение зарегистрит его в
   `rawRoutes` — тогда `Bun.file` исполнится на Node.

## Предлагаемая архитектура

### 1. Ядро — Web-Fetch-чистое, с CI-guard
Entrypoints `stitchkit`/`/contract`/`/tools`/`/react`/`/observability` +
`createHandler` — ноль Bun-глобалов. Закрепить **Biome-правилом** (path-scoped
override, бан глобала `Bun` в этих директориях) — надёжнее грепа, в существующем
quality-gate.

### 2. Split `ServerConfig`
`ServerConfig` тащит `routes`/`websocket`/`development`/`bun` (все —
`Parameters<typeof Bun.serve>`-производные) и его потребляет `createHandler`,
который их игнорит. Разнести: рантайм-нейтральный **`HandlerConfig`** (services,
groups, rawRoutes, cors, hooks, logging, traceId) для `createHandler`, и
**`BunServerConfig extends HandlerConfig`** для `createServer`. `RawRouteContext`
→ generic `RawRouteContext<TServer=unknown>`. Без этого «нейтральный» шов всё
равно транзитивно именует `Bun`.

### 3. Node-адаптер `serveNode` — ⚠ открытый спор
Тонкий subpath `stitchkit/node` с `serveNode(handler, opts)`. **Агенты
разошлись:**
- *Hand-roll* (`node:http`-мост, ~80 строк): по ADR 0001 «тонкий срез, без
  фреймворк-зависимости». Минус — мост фидлистый: стриминг тел, backpressure,
  multi-value хедеры (`set-cookie`), ранний flush для SSE, `AbortSignal` на
  abort, и обязательный синтез абсолютного URL (C8).
- *Wrap `srvx`* (опциональный peer, команда unjs/h3): по ADR 0008 «обёртка над
  тем, что экосистема уже решила, не свой транспорт» — и ADR 0009 как
  предостережение (свой транспорт = 700 строк мёртвого кода). Бонус — `srvx`
  закрывает Deno/workerd бесплатно. Минус — зависимость и её каденс.
- **Рекомендация:** склоняюсь к `srvx` — это микро-адаптер, не фреймворк
  (ADR 0001 был против Hono/Elysia, не против такого), снимает класс багов
  (C8 и пр.) и открывает Deno/workerd. Финальное решение — за мейнтейнером,
  оформить в ADR 0013.

### 4. `staticRoute` (C2)
`Bun.file` даёт бесплатно: content-type из расширения, `Content-Length`,
**Range-запросы** (видео/аудио seek), conditional (`ETag`/`If-None-Match` →304).
Наивный `node:fs` + `createReadStream` всё это **молча теряет**. Решение:
либо явно задокументировать `staticRoute` как «basic, без Range — за ним CDN»
(стартер уже говорит «бэкенд не отдаёт статику в проде»), либо переиспользовать
готовый хелпер. `node:fs`-переписку «работает в обоих» без Range — **не
делать**.

### 5. Socket.IO (C3) — engine-адаптер, не «два пути»
Node-путь **проще** Bun-пути: `socket.io` нативно цепляется к
`node:http.Server` (`io.attach`), сам ведёт `upgrade`. `@socket.io/bun-engine` —
экзотика (Bun.serve — не http.Server). Не «два пути», а **2-методный
engine-адаптер**: `bind(io)`, `httpRoute()`, `bunWebSocket()`. `createSocketIO
Server` остаётся одной функцией, берёт адаптер; `stitchkit/node` ship'ит
Node-адаптер. **Реальная трудность:** Node socket.io владеет `upgrade`-событием
того же `http.Server`, что и `serveNode` — Node-адаптер socket.io ОБЯЗАН
цепляться к серверу, который создал `serveNode`. То есть `serveNode` ↔
socket.io-Node **связаны**, делать их в одной фазе.

### 6. Типы — утечка это баг уже сегодня
Эмитируемые `.d.ts` 5 cross-runtime entrypoints — **уже Bun-type-чистые**
(проверено по `dist/`). Утечка в `stitchkit/server` (`dist/server/types.d.ts`,
`create.d.ts`) — и это **баг сейчас**: `@types/bun` только в `devDependencies`,
Node- (и даже Bun-) потребитель `stitchkit/server` ловит `TS2503: Cannot find
namespace 'Bun'`. `bun build --target node` Bun-глобалы **не переписывает** —
в `dist/server/index.js` остаются `Bun.file`/`Bun.serve` → `ReferenceError` на
Node. Решение: split (п.2) + `@types/bun` опциональным peer'ом.

### 7. Упаковка — subpath, не отдельный пакет
**`stitchkit/node` как subpath, один пакет.** Отдельный `@stitchkit/node`
противоречит «один пакет» ADR 0011 (остаётся в силе), даёт version-skew и
install-friction ради ~80 строк без своих зависимостей. Tree-shaking решается
`exports`-картой, не границей пакета. Прецедент — Hono (явные runtime-subpath'ы
`hono/bun` и т.д.). Рассмотреть симметрию: вынести Bun-бутстрап в `stitchkit/bun`,
`/server` оставить чисто нейтральным (`createHandler` + роутер + middleware) —
тогда `stitchkit/bun` + `stitchkit/node` симметричны и `stitchkit/deno` позже
встаёт ровно. Минорный rename — за тем же ADR.

### 8. peer-deps и `engines`
`engines` → `{ node: ">=22", bun: ">=1.2.0" }` (каждый рантайм читает свой
ключ). `peerDependenciesMeta` **не умеет** «optional только для Bun» — закрыть
ленивым `import('@socket.io/bun-engine')` / `import('socket.io')` с внятной
ошибкой («ставь X, либо используй другой рантайм»). `@types/bun` → опциональный
peer.

### 9. Ребрендинг
`package.json` `description` = «Contract-first backend framework **for Bun**»,
`keywords` ведут с `"bun"`, README говорит «for Bun». Для Node-аудитории, ради
которой задача и затевается, — обновить `description`/`keywords`/`homepage`/
README. ESM-only (нет CJS-выхода) — оставить сознательно, зафиксировать строкой
в ADR.

### 10. CI / тесты
`bun test` исполняется **на Bun** — Node-адаптер им не проверить. Нужны:
(а) Node-job с `node --test` на `tests/node/*`; (б) smoke на **собранном
`dist/`** через `node -e "import('stitchkit/node')..."` (импорт через
`exports`-карту, не `src`); (в) CI-guard Fetch-чистоты (Biome-override);
(г) typecheck потребительского фикстура **без** `@types/bun` — единственная
проверка, воспроизводящая опыт Node-юзера (`bun run check` с `types:["bun"]`
утечку маскирует). Node-job добавить и в `release.yml` перед `npm publish`.
Существующий тест-сьют использует `bun:test` + местами `Bun.serve`/`Bun.sleep` —
на Node-ноге целиком не пойдёт, нужен отдельный Node-набор.

## ADR (черновик ядра, по саб-агенту)

> **ADR 0013 — Runtime-agnostic ядро, Bun как first-class адаптер.** Ядро
> (`/contract`, `/tools`, `/react`, `/observability`, `createHandler` из
> `/server`) — чистый Web Fetch, ноль Bun-глобалов, только cross-runtime
> `node:*`, закреплено CI-guard'ом. `createHandler` — официальный
> portability-шов. `Bun.serve` — не «сервер», а один адаптер: `createServer`
> остаётся Bun-first; `stitchkit/node` добавляет `serveNode`. Socket.IO —
> один `createSocketIOServer` с 2-методным engine-адаптером, не два пути.
> Супонит только Bun-only пункт ADR 0011; «один пакет» и «quality gate»
> остаются Accepted. Уточняет ADR 0001: «без HTTP-фреймворка» в силе,
> «на `Bun.serve`» → «`Bun.serve` — дефолтный адаптер». Не конфликтует с
> ADR 0008 (обёртки) и ADR 0010 (это transport-портируемость, не fullstack).

## Фазы (переупорядочены)

1. **P1** — ядро Fetch-чистое + CI-guard + **Node-нога CI с самого начала** +
   ADR + `staticRoute` (независимый leaf). CI на Node сразу ловит регрессии
   чистоты и баг C8.
2. **P2** — split типов/конфига (п.2) **вместе** с `serveNode` (адаптер нельзя
   писать против Bun-форменных типов — split это prerequisite, не отдельная
   ранняя фаза).
3. **P3** — engine-адаптер Socket.IO + Node-движок (hard-зависит от того, что
   P2 выставит `http.Server` из `serveNode`).
4. **P4** — доки (getting-started, deployment, realtime) + ребрендинг.

## Открытые вопросы

- **`serveNode`: hand-roll vs wrap `srvx`** — главный спор агентов, решение за мейнтейнером.
- `createServer` оставить Bun-именем (рекомендация — да, + `serveNode` отдельным
  subpath; runtime-детект отклонить — сюрприз + ломает tree-shaking).
- Симметричный `stitchkit/bun` subpath — делать или нет.
- Deno/workerd в скоуп сейчас — с `srvx` открывается бесплатно, без — отложить.
- Graceful shutdown: `serveNode` должен вернуть `stop()`/`close()` с паритетом к
  `Bun.serve().stop()`; объект `server` в `RawRouteContext` на Node — другой
  формы.
- `config.routes` (нативный Zig-роутер Bun) — Node-эквивалента нет; задокумент.
  как Bun-only оптимизацию, `serveNode` его игнорит (молча ронять — баг).

## Ссылки

- `server/create.ts:29` (шов), `:195` (C8), `:206-228` (C1).
- `server/router.ts:207-228` (C2), `server/socket-io.ts:74-79` (C3).
- `server/types.ts:79,89,104-107,121-142` (C4), `server/swept-map.ts:34` (C5),
  `tools/mcp-handler.ts:113` (C6).
- `package.json` (`engines`, peer-deps, `description`, `keywords`),
  `tsconfig.json`/`tsconfig.build.json` (`types:["bun"]`), `.github/workflows/`.
- `docs/decisions/` — ADR 0001 (уточняется), 0008/0009 (прецедент для спора по
  `serveNode`), 0011 (Bun-only пункт замещается 0013).

---

## ⟢ Обновление 2026-05-29 — статус + остаток «от и до»

Триггер: `stitch-demo` (RR7 + stitchkit) под Node-dev упал —
`stitchkit/server` тянет Bun-движок сокетов на загрузке. Сверка плана выше с
**текущим кодом** (часть зашипалась в 0.2.0, доку не обновляли).

### Что реально СДЕЛАНО (0.2.0) — P1/P2

- [x] `createHandler` Node-чистый — `src/server/create.ts` не импортит socket-io
  (только `./request`); `Bun.serve`/`Bun.file` — внутри тел функций, не eval.
- [x] Split `HandlerConfig` (нейтральный) / `BunServerConfig` (Bun) — `server/types.ts`.
- [x] `serveNode` на **`srvx`** — `src/server/node.ts` (`serve({ port, fetch })`).
  Спор «hand-roll vs srvx» решён → **srvx** (ADR 0013).
- [x] Entry `stitchkit/node` — `src/node.ts` (`createHandler` + `serveNode` + `HandlerConfig`).
- [x] `engines: { node: ">=22", bun: ">=1.2.0" }`, `srvx` optional-peer.
- [x] `/tools` (MCP) — WebStandard transport, Node-safe (работы ноль, как и ожидалось).

### Что НЕ сделано — подтверждённые дыры (по коду)

- `src/server/socket-io.ts:14-15` — **статический** top-level `import @socket.io/bun-engine` + `socket.io`.
- `src/server/index.ts:61` — баррель статически реэкспортит `createSocketIOServer`
  → импорт `createHandler`/`implement`/`notFound` из `stitchkit/server` **eval-ит**
  socket-io → Bun-движок → **краш под Node на загрузке** (даже без сокетов).
- `implement`/`notFound` — только в `/server` барреле (`server/index.ts:7,14`), нет в `/node`.
- Socket.IO **Node-пути нет** (только Bun-движок). serveNode не отдаёт http.Server.
- `staticRoute` — `Bun.file` (Bun-only), падает на Node если зарегистрить в `rawRoutes`.
- type-leak `Bun` namespace в `/server` `.d.ts` — под вопросом, проверить.
- Node CI / dist-import-smoke / Fetch-purity guard — нет (потому баг и проскочил).

### Крукс РЕШЁН: srvx отдаёт node-сервер

`srvx` экспозит **`server.node.server`** = подлежащий `node:http.Server`
(подтверждено: srvx.h3.dev/guide/server). Значит socket.io `io.attach(server.node.server)`
на Node **реален** → realtime-on-Node возможен. Оговорка: проверить что srvx сам не
перехватывает `upgrade` когда WS не сконфижен (createHandler — чистый fetch без WS →
socket.io владеет `upgrade`); закрыть тестом.

### Остаток «от и до» — фазы (переупорядочены под факт)

- **Ф0 — Node-safety барреля (S, 1 файл, РАЗБЛОКИРУЕТ всё).** `socket-io.ts`:
  top-level импорт движков → `await import(...)` **внутрь** `createSocketIOServer`
  (внятная ошибка). Итог: `stitchkit/server` грузится под Node → **non-socket Node-апп
  (= demo) работает.** Это «минимум, чтобы импортилось и бежало».
- **Ф1 — эргономика + C8 + static (S–M).** Реэкспорт `implement`/`notFound`/`createImplement`
  из `stitchkit/node`. Закрепить C8 (srvx даёт абсолютный url) Node-smoke-тестом.
  `staticRoute` → задокументировать **Bun-only** (Node: статика через фронт/CDN); Node-static с Range — отдельный follow-up.
- **Ф2 — Socket.IO на Node (M–L, главная работа).** Engine-адаптер: `createSocketIOServer`
  берёт адаптер (Bun = `@socket.io/bun-engine`; Node = `io.attach(handle.node.server)`).
  `serveNode({ socket })` симметрично `createServer`, отдаёт srvx-handle; socket.io цепляется
  в той же фазе (владеет `upgrade`). = «полноценно вкл. realtime».
- **Ф3 — типы/упаковка (S–M).** Убрать утечку `Bun` namespace в `/server`+`/node` `.d.ts`;
  `@types/bun` → optional peer; подтвердить `exports ./node` с types.
- **Ф4 — CI/доказательство (M).** Node test-job (`node --test`, отдельный набор);
  **dist-import smoke** `node -e "import('stitchkit/node')"` + `import('stitchkit/server')`
  (поймал бы этот баг); Fetch-purity Biome-guard; Node-job в `release.yml`.
- **Ф5 — доки/ребренд (S).** README/description/keywords «for Bun **and Node**»;
  getting-started + deployment на `serveNode`; staticRoute Bun-only.

### Критический путь
- min (импортится + бежит non-socket Node-апп) = **Ф0**.
- полноценно вкл. realtime = **+ Ф2**.
- прод-уверенно = **+ Ф3–Ф4 + Ф5**.

### Демо тем временем
`stitch-demo` на **Bun уже работает** (`/api/notes` отдаёт сид). Для Node-dev ждёт **Ф0**.

---

## ✅ Сделано 2026-05-29 — Node-готовность (Ф0–Ф4)

Реализовано «от и до» + полный чек. **stitchkit полноценно работает на Node** (verified).

### Ф0 — баррель Node-safe
- [x] `server/socket-io.ts` — сокет-пакеты грузятся **лениво** (dynamic `import` внутри
  `createSocketIOServer`; top-level value-импорты убраны, остались только `type`).
  Баррель `stitchkit/server` больше eager-не-тянет Bun-движок → грузится под Node.

### Ф1 — эргономика
- [x] `stitchkit/node` (`src/node.ts`) реэкспортит `implement`/`createImplement`/error-helpers/
  `createSocketIOServer` — Node-апп не касается Bun-именованного `createServer`.
- [x] C8 (`new URL(req.url)`) — srvx даёт абсолютный url; подтверждено serveNode-смоуком.
- [x] C2 staticRoute — оказалось УЖЕ Node-safe (`node:fs`, не `Bun.file`); таска была стале.

### Ф2 — Socket.IO на Node
- [x] `createSocketIOServer` async, runtime-ветвь: **Bun** = bun-engine + websocket + route;
  **Node** = `io.attach(server.node.server)` (srvx `node:http.Server`). Единый handle:
  `websocket`/`route` обязательны (на Node — inert-заглушки, без гардов у Bun-консьюмера),
  `attach` обязателен (на Bun — noop). `serveNode({ socket })` делает attach.
- [x] **Node = websocket-only** (polling столкнулся бы со srvx-request-handler; ws идёт через
  `upgrade`). Задокументировано в `SocketIOServerConfig`; клиент ставит `transports:['websocket']`.
- [x] Callsites обновлены (`await createSocketIOServer`): starter, consumer/backend, core test.

### Ф3 — типы/упаковка (частично)
- [x] `@types/bun` → optional **peer** (был только devDep).
- [x] Глубокая утечка `Bun`/bun-engine типов в `/server`+`/node` `.d.ts` (через
  `RawRouteContext.server: BunServer` и websocket-тип) — generic `RawRouteContext<TServer>`
  рефактор. Не блокер рантайма; Node-консьюмер ставит `@types/bun`.
  **→ вынесено в `inbox/2026-06-05-node-support-polish.md`.**

### Ф4 — CI/доказательство
- [x] `scripts/node-smoke.mjs` + `bun run smoke:node` — под **node** против dist: импорт ВСЕХ
  server-side entrypoints (вкл. `stitchkit/server`!) + serveNode HTTP round-trip + Socket.IO
  round-trip. Ровно класс бага, который `bun test` не видит.
- [x] `.github/workflows/ci.yml` — `node-smoke` job переключён на `bun run smoke:node`
  (был слабый inline, не импортил `/server`). release зависит от node-smoke.
- [x] Biome Fetch-purity guard (бан `Bun`-глобала в core-дир) — формат
  `noRestrictedGlobals` под вопросом, риск сломать lint-гейт; dist-smoke даёт рантайм-гарантию.
  **→ вынесено в `inbox/2026-06-05-node-support-polish.md`.**

### Ф5 — ребренд (уже было сделано)
- [x] description/keywords/README/VISION — уже «for Bun **and Node**».
- [x] getting-started/deployment doc на `serveNode` — мелочь.
  **→ вынесено в `inbox/2026-06-05-node-support-polish.md`.**

### Верификация
- stitchkit: `bun run verify` — lint чист · tsc 0 · **339 pass/0 fail** · build ok.
- `bun run smoke:node` под Node — все entrypoints + serveNode HTTP + Socket.IO ✅.
- потребитель: **8/8** typecheck (websocket non-optional → без гардов).
- demo `stitch-demo` под **Node** (`react-router dev`) — SSR + `/api` + typed-client ✅.

### Остаток (некритично, не блокирует Node)
- Ф3: generic `RawRouteContext<TServer>` (убрать Bun-type-leak из `.d.ts`).
- Ф4: Biome Bun-global guard.
- Ф5: getting-started/deployment doc для Node.

---

## Итог (закрыто 2026-06-05)

Сверено с текущим кодом, глубоко:

- **Ядро runtime-agnostic — СДЕЛАНО и verified.** Node полноценно работает
  (зашипано в 0.3.0): lazy socket-io в барреле (`server/socket-io.ts`),
  `serveNode` на srvx (`server/node.ts` + `stitchkit/node`), split
  `HandlerConfig`/`BunServerConfig` (`server/types.ts`), Socket.IO Node-attach
  (`io.attach(server.node.server)`), `node-smoke.mjs` + `node-smoke` job в CI,
  `engines {node>=22, bun>=1.2}`, `@types/bun`/`srvx` optional-peers, ADR 0013.
- **3 остатка подтверждены ОТКРЫТЫМИ** (некритичны, Node не блокируют) →
  вынесены отдельной задачей на потом:
  [`docs/backlog/inbox/2026-06-05-node-support-polish.md`](../inbox/2026-06-05-node-support-polish.md):
  - **Ф3** — `RawRouteContext.server: BunServer` (не generic), `BunServer`
    светит в `/server` `.d.ts`. Смягчено `@types/bun` optional-peer.
  - **Ф4** — нет Biome Fetch-purity guard (только `globals:["Bun"]`); рантайм
    прикрыт dist-smoke в CI.
  - **Ф5** — Node-доки тонкие (в getting-started лишь строка prereq, нет
    `serveNode`-примера и секции деплоя на Node).

Файл закрыт: ядро done & verified, polish-остатки живут отдельной inbox-заметкой.
