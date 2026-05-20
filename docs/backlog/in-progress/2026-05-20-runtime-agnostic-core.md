---
title: Runtime-agnostic ядро — Bun первоклассно, Node поддерживается
description: Сделать stitchkit пригодным для Node без потери Bun-first — ядро Fetch-чистое, но завязок больше, чем казалось, и пол по Node = 22
type: task
status: inbox
created: 2026-05-20
updated: 2026-05-20
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
  (C8 и пр.) и открывает Deno/workerd. Финальное решение — за Max, оформить в
  ADR 0013.

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

- **`serveNode`: hand-roll vs wrap `srvx`** — главный спор агентов, решение Max.
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
