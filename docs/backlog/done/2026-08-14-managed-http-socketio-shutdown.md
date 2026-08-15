---
title: Управляемый shutdown HTTP и Socket.IO для Bun и Node
description: Заменить разрозненные stop/close вызовы единым framework-owned lifecycle с admission gate, drain, deadline и честным clean/forced результатом.
type: task
status: done
created: 2026-08-14
updated: 2026-08-14
completed: 2026-08-15 00:44 +00:00
related: docs/backlog/done/2026-05-20-runtime-agnostic-core.md
---

# Управляемый shutdown HTTP и Socket.IO для Bun и Node

## Зачем

Stitchkit создаёт и связывает Socket.IO с runtime server, но не владеет полным
shutdown lifecycle. На Bun `createSocketIOServer()` самостоятельно создаёт
`@socket.io/bun-engine`, привязывает его к Socket.IO и скрывает engine внутри
handle. Consumer получает разрозненные `io`, `websocket`, `route` и `attach`, а
затем вручную определяет порядок `server.stop()` и `io.close()`.

При активном WebSocket это недостаточно. `io.close()` логически отключает
Socket.IO clients и закрывает adapters, но Bun engine не предоставляет Promise
физического закрытия socket. `Bun.Server.stop(false)` при этом продолжает ждать
активный WebSocket. Процесс способен дойти до supervisor deadline и завершиться
через `SIGKILL`, хотя application shutdown уже счёл Socket.IO закрытым.

Корень находится в ownership: Stitchkit создаёт transport resources, но не
возвращает операцию, которая может доказанно завершить их. Consumer не должен
читать private Bun Engine, угадывать порядок runtime-specific вызовов или
маскировать проблему первым `stop(true)`, обрывающим принятые HTTP-запросы.

## Подтверждённая механика

- [Socket.IO 4.8.3 `Server.close()`](https://github.com/socketio/socket.io/blob/socket.io%404.8.3/packages/socket.io/lib/index.ts#L3642-L3699)
  ждёт adapter close, затем синхронно вызывает `engine.close()`; Promise
  attached HTTP server существует только на Node-пути с `httpServer`.
- [`@socket.io/bun-engine` 0.1.1 `Server.close()`](https://github.com/socketio/bun-engine/blob/0.1.1/lib/server.ts#L1798-L1810)
  вызывает `client.close()` для каждого клиента и не возвращает completion
  Promise.
- [`Bun.Server.stop(false)`](https://bun.sh/reference/bun/Server/stop) перестаёт
  принимать соединения, но не обрывает in-flight HTTP/WebSocket; `stop(true)`
  завершает их принудительно.
- До этой задачи [`createSocketIOServer()`](../../../packages/core/src/server/socket-io.ts)
  создавал Bun Engine без server-owned completion, а официальный
  [starter shutdown](../../../packages/create-stitchkit/template/packages/backend/src/index.ts)
  вручную вызывает `server.stop()` и `socket.io.close()` без общего результата.

## Результат

- Bun и Node servers возвращают единый framework-owned handle с идемпотентным
  `shutdown()` и одинаковой публичной семантикой.
- После начала shutdown новая HTTP-работа получает явный `503` с
  `Retry-After`; запросы, принятые раньше admission boundary, получают время на
  завершение.
- Socket.IO adapters и logical clients закрываются до остановки runtime; затем
  framework доказывает отсутствие pending HTTP/WebSocket либо применяет
  ограниченный deadline-ом forced fallback.
- Результат shutdown различает `clean` и `forced`, содержит фактические
  счётчики/длительность и не выдаёт supervisor kill за штатное завершение.
- Canonical starter больше не собирает порядок из `server.stop()` и
  `socket.io.close()` вручную.

## Архитектурное решение

Это hard cut публичного server lifecycle, а не второй параллельный helper.
Следующий breaking minor должен изменить Bun `createServer()` и Node
`serveNode()` так, чтобы они возвращали runtime-neutral managed handle. На
текущей линии `0.48.x` это означает minor `0.49.0`, а не corrective patch.

Целевая семантика:

```ts
const socket = await createSocketIOServer(config);

const app = createServer({
  services,
  socket,
});

const result = await app.shutdown({
  gracePeriodMs: 30_000,
  retryAfterSeconds: 5,
});
```

Plan validation закрепила конкретные типы и следующие границы:

- managed handle содержит runtime server как явный escape hatch для
  диагностики, а также `url`, `port` и `shutdown()`;
- server принимает полный Stitchkit Socket.IO handle и сам монтирует его route,
  websocket handlers, Node attachment и lifecycle;
- прямой public stop/close путь не сохраняется alias, deprecated wrapper или
  compatibility shim; все repository callsites мигрируют в одном изменении;
- Prisma, MCP, Telegram, outbox и другие application resources не становятся
  собственностью Stitchkit. Consumer закрывает их отдельно вокруг одного
  доказанного server shutdown.

Plan validation зафиксировала concrete hard-cut:

- общий structural contract — `ManagedServerHandle<TRuntime>` с `url`, `port`,
  runtime-specific `runtime`, live `status` и `shutdown()`; Bun/Node экспортируют
  concrete aliases, а `stitchkit/node` не ссылается на Bun declarations;
- Bun native `routes` удаляются из `BunServerConfig`: они исполняются до `fetch`
  и не могут честно пройти единый admission boundary. Миграция — framework
  `rawRoutes`, которые остаются Fetch-clean и полностью управляемыми;
- `socket` автоматически монтирует Socket.IO route и default websocket handler.
  Если передан custom `websocket` (raw lanes), он является effective composed
  handler и обязан включать `socketIoLane(socket.websocket)`; server оборачивает
  его для учёта/закрытия всех raw Bun sockets. Это уточняет ADR 0020, не создавая
  второго WebSocket engine;
- exact `503`/`Retry-After`/`Connection: close` относится к ordinary HTTP lanes.
  Новые Socket.IO handshakes после boundary отвергаются transport-native через
  composed `allowRequest`; уже принятый polling освобождается logical close и
  не блокирует переход к `closing-realtime`;
- на Node `gracefulShutdown: false` отключает скрытые signal handlers srvx.
  Attached Socket.IO `io.close()` — единственный graceful owner listener close;
  без Socket.IO listener закрывает Node adapter. Forced path дополнительно
  уничтожает tracked `net.Socket`, включая upgraded WebSocket;
- `acceptedRequests`/`completedRequests` — admission/application counters.
  Physical transport state публикуется отдельно; forced evidence сохраняется в
  `pendingRequestsAtForce`/`pendingWebSocketsAtForce` и `aborted*`, тогда как
  final pending после доказанного close равен нулю.

## Plan validation 2/2

- [x] Bun/runtime validator нашёл native-routes bypass, raw WebSocket ownership,
      polling phase ordering, physical-response accounting и обязательный
      outermost admission wrapper.
- [x] Node validator нашёл hidden srvx signal lifecycle, Socket.IO double-close,
      upgraded TCP sockets, Engine.IO bypass и Bun-free declaration boundary.
- [x] Все обязательные замечания встроены в архитектуру, plan и acceptance до
      начала implementation.

## Shutdown state machine

```text
running
  -> draining-http
  -> closing-realtime
  -> stopping-runtime
  -> clean | forced
```

1. Первый `shutdown()` атомарно закрывает admission, фиксирует options и создаёт
   единственную shared Promise. Метод не является `async` wrapper: повторный
   вызов возвращает буквально тот же Promise object. Второй OS signal abort-ит
   тот же application controller, не запускает новый resource chain.
2. Пока listener ещё работает, новые запросы не входят в contracts/raw routes и
   получают `503`, `Retry-After` и `Connection: close`.
3. Все application-запросы, принятые до boundary, считаются outermost fetch
   wrapper; на Node physical completion подтверждается `ServerResponse.finish`,
   ранний `close` считается abort. Bun дополнительно использует runtime counters.
4. После application HTTP drain закрываются Socket.IO namespaces/adapters и
   engine clients; активный polling не задерживает эту фазу.
5. Bun ждёт физический `pendingWebSockets === 0`; если runtime не даёт completion
   event, ожидание остаётся bounded общим deadline и использует минимальный
   runtime adapter, а не consumer polling.
6. Один `deadlineAt` вычисляется монотонно из `gracePeriodMs`; optional external
   `AbortSignal` входит в тот же forced transition. Каждый этап получает только
   остаток общего budget; first-call options wins, listeners/timer очищаются.
7. Если всё завершилось, runtime останавливается graceful. После deadline Bun
   использует `stop(true)`, Node — соответствующий active-connection close, а
   результат помечается `forced` с точной причиной и незавершёнными счётчиками.

## План

- [x] Написать ADR о server-owned lifecycle, admission boundary, едином deadline,
      runtime-specific forced fallback и границе application resources; добавить
      ADR в индекс.
- [x] Ввести Zod-first public schemas/types для shutdown options, state/status и
      final result (`clean | forced`) без hand-written duplicate types.
- [x] Определить единый managed handle Bun/Node и выполнить hard cut текущих
      `createServer()`/`serveNode()` return shapes; обновить все внутренние
      callsites без legacy aliases; generic runtime escape hatch не должен
      протекать Bun types в `stitchkit/node`.
- [x] Передавать полный `SocketIOServerHandle` в server config; Bun server сам
      монтирует route/websocket lifecycle, Node — attach к `node:http.Server`.
- [x] Добавить верхний admission/request tracker, который охватывает contracts,
      raw routes и framework error responses и находится снаружи consumer
      `wrapFetch`; удалить bypassing Bun native `routes` в пользу `rawRoutes`.
- [x] Добавить Socket.IO admission bridge через composed `allowRequest`, не
      затирающий consumer policy: post-boundary handshake отвергается, existing
      polling освобождается logical close и учитывается отдельно от application
      HTTP drain.
- [x] Реализовать одну идемпотентную shutdown Promise и state machine с общим
      `AbortSignal`/deadline, а не независимыми таймерами каждого слоя.
- [x] Реализовать Bun closure: graceful HTTP drain, logical Socket.IO close,
      tracking/close composed raw WebSocket lanes, доказательство physical
      WebSocket closure и forced `stop(true)` только после исчерпания deadline.
- [x] Реализовать эквивалентный Node lifecycle с attached `node:http.Server`, не
      вызывая конкурирующие `close()` chains Socket.IO и srvx; отключить srvx
      signal plugin, track TCP sockets и уничтожать upgraded sockets на force.
- [x] Добавить runtime-neutral status/result с фактическими accepted/completed/
      final pending counts, snapshots at force, aborted counts, duration и
      forced reason (`deadline | signal`).
- [x] Перевести CLI/scripts/tests и canonical create-stitchkit template на один
      `shutdown()`; внешние MCP/DB resources закрывать отдельно и явно.
- [x] Добавить subprocess integration fixtures для Bun и Node: process получает
      настоящий `SIGTERM`, выполняет shutdown и выходит сам с code `0` в
      ограниченный срок; readiness синхронизируется stdout/IPC, parent всегда
      имеет bounded deadline/finally kill, а child ловит unhandled failures.
- [x] Обновить server/realtime/deployment guides, API reference, upgrade guide,
      `[Unreleased]` changelog с `### ⚠️ Breaking changes` и before → after
      migration; перегенерировать agent-facing docs.
- [x] Прогнать полный gate: core suite/build, Node smoke, consumer lane и packed
      HEAD starter lane зелёные. Target starter lane ожидаемо несовместим с ещё
      не опубликованным breaking API; release/catalog mutation запрещены scope.

## Acceptance

- [x] Bun integration с открытым невзаимодействующим Socket.IO WebSocket получает
      `SIGTERM`, завершает процесс с code `0` и оставляет
      `pendingRequests === 0`, `pendingWebSockets === 0`.
- [x] Socket.IO polling transport проходит тот же lifecycle без зависшего HTTP
      poll request.
- [x] Bun raw WebSocket clean path вызывает normal `close()` и ждёт server-side
      `close` callback; любой всё ещё tracked к общему deadline сокет попадает в
      forced snapshot и `terminate()`. Runtime-probe Bun 1.3.14 подтвердил, что
      callback приходит даже без чтения/ACK close frame клиентом, поэтому такое
      физически закрытое соединение не маркируется forced искусственно.
- [x] Долгий HTTP-запрос, принятый до admission boundary, завершается штатно в
      пределах grace period.
- [x] Новый запрос после boundary получает ровно `503`, `Retry-After` и
      `Connection: close` и не вызывает auth/lifecycle/application `wrapFetch`;
      новый Socket.IO handshake отвергается transport-native admission policy.
- [x] Если старый HTTP-запрос или WebSocket не завершился до deadline, runtime
      физически закрывает соединение, а result имеет `outcome: 'forced'` и
      ненулевой соответствующий pending/aborted counter.
- [x] Clean path возвращает `outcome: 'clean'`; forced path никогда не
      маскируется под clean; final pending равны нулю, а ненулевые значения до
      force остаются в snapshot/aborted counters.
- [x] Два одновременных `shutdown()` и повторный OS signal используют одну
      Promise identity и одну state transition chain; first-call options wins,
      already-aborted signal forces сразу, медленные фазы не суммируют budget.
- [x] Отдельный Node subprocess с active HTTP и Socket.IO соединением проходит
      тот же public contract и завершается без double-close ошибки.
- [x] Node active streaming response считается завершённым по `finish`, forced
      upgraded WebSocket физически уничтожается, а core не добавляет process
      signal listeners через srvx.
- [x] Test processes имеют собственные bounded deadlines и `finally` cleanup;
      зависший fixture не способен ждать supervisor timeout.
- [x] Bun и Node public handles имеют одну runtime-neutral форму; различия
      находятся только во внутренних adapters.
- [x] Repository и starter не содержат ручной пары `server.stop()` +
      `socket.io.close()` как canonical application shutdown.
- [x] Upgrade guide содержит механическую миграцию всех изменённых server/socket
      callsites; прежний API не остаётся deprecated или re-exported.
- [x] Node consumer fixture и declaration/public-surface guards проходят без
      установленного `@types/bun`; API reference не описывает старый `close/stop`.
- [x] Public docs не обещают управление Prisma, MCP, queues или domain run-state.
- [x] Node smoke, consumer lane и starter HEAD lane проходят полностью;
      `bun run verify` останавливается только на target starter с опубликованным
      `stitchkit@0.46.0`, который по определению не содержит hard-cut API. Без
      разрешённого release target lane не может стать зелёным и не подменяется shim.

## Implementation validation 2/2

- [x] Bun/runtime validator — PASS после отделения Engine.IO transport от
      application admission, композиции policy и physical raw-socket close.
- [x] Node/public validator — PASS после перехода на physical upgraded-socket
      counter/barrier; независимый probe подтвердил `physicalAtResult: 0`.

## Что сделано

- [x] **Lifecycle:** `packages/core/src/server/shutdown.ts` реализует Zod-first
      states/options/status/result, outer admission, одну Promise и один deadline.
- [x] **Bun regression:** `packages/core/tests/server-shutdown.test.ts` — тесты
      `closes admission outside wrapFetch, drains accepted work and reuses one Promise`,
      `cleanly closes an active Socket.IO websocket transport`,
      `cleanly closes an active Socket.IO polling transport` и
      `closes a tracked raw Bun WebSocket before graceful runtime stop`.
- [x] **Forced/deadline regression:** `packages/core/tests/server-shutdown.test.ts`
      — тесты `uses one total deadline and preserves the pending snapshot on force`
      и `an already-aborted external signal forces immediately`.
- [x] **Signal regression:** `packages/core/tests/server-shutdown-signal.test.ts`
      — тест `Bun subprocess handles real SIGTERM and exits naturally after managed shutdown`.
- [x] **Node regression:** `packages/core/scripts/node-smoke.mjs` проверяет
      streaming `finish`, clean/forced physical Socket.IO close, post-boundary
      handshake и one-shot real SIGTERM; physical adapter дополнительно покрыт
      `packages/core/tests/node.test.ts` тестом
      `forces a physically open streaming response and preserves its snapshot`.
- [x] **Public hard cut:** Bun native `routes` удалены, полный socket handle
      server-owned, starter/CLI/tools и public docs мигрированы без compat shim.
- [x] **Не делалось:** version bump, release, deploy, commit, push и staging не
      выполнялись по прямому ограничению владельца.

## Не входит

- Универсальный orchestrator всех ресурсов приложения.
- Регистрация process signals внутри core как скрытая глобальная магия; starter
  показывает явный `SIGTERM`/`SIGINT` wiring к `shutdown()`.
- Rolling/blue-green deployment, supervisor configuration и domain repair.
- Переписывание Socket.IO или Bun Engine: Stitchkit остаётся lifecycle adapter
  над официальными transport implementations.
