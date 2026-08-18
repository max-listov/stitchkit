---
title: "Unix-сокет как первоклассный транспорт: createServer({unix}) и клиент"
description: Локальный демон с дверью через unix domain socket без спуска на createHandler и голый fetch — сервер, типизированный клиент и CLI работают через сокет-файл из коробки.
type: task
status: done
created: 2026-08-18
updated: 2026-08-18
completed: 2026-08-18 17:05 +07:00
---

# Unix-сокет как первоклассный транспорт

## Зачем

Consuming project, строящий локальный демон, упёрся: `createServer` умеет
только `port`/`hostname`, а `unix` **явно вычеркнут** из passthrough
(`server/bun.ts:31`) — пришлось спуститься на `createHandler` + собственный
`Bun.serve({ unix })`, вручную решая удаление подвисшего сокет-файла и права.
Симметрично на клиенте: `createHttpClient` принимает только `baseUrl`, к
локальной двери ходят голым `fetch` с `unix` — ровно там, где контракт мог бы
дать типы, их нет. Транспорт — заявленная территория stitchkit; паттерн
«локальный демон с unix-дверью» должен быть нативным.

## Результат

- `createServer({ unix: '/path/app.sock' })` поднимает Bun-сервер на
  unix-сокете; `port`/`hostname` и `unix` взаимоисключающи (внятная ошибка).
- Гигиена сокет-файла: подвисший файл от мёртвого процесса убирается перед
  bind (безопасно: только если по нему никто не отвечает), опция режима
  доступа (по умолчанию — как создаёт Bun; opt-in ужесточение до 0600).
- `ManagedServerHandle` честен для unix-режима (`url`/`port` не врут).
- `createHttpClient({ unix })` — тот же типизированный клиент/CLI через
  сокет-файл; `baseUrl` остаётся источником path-префикса.
- Гайд: раздел «Local daemon over a unix socket» с сервером и клиентом.

## Уточнения после план-валидации (2 валидатора, пробы на Bun 1.3.14)

- Форма опции: `unix?: string | { path: string; mode?: number }` (nested-mode по
  прецеденту `retry`; `unixMode` отвергнут). Клиент — только `unix?: string`.
- Эксклюзивность `unix` vs `port`/`hostname` — **runtime**-ошибкой на сыром
  конфиге до применения дефолта `port = 3000`; `BunServerConfig` остаётся
  interface (XOR-union — breaking для `extends`, не делаем). Unix-ветка
  `Bun.serve` строится вообще без ключей `port`/`hostname` (Bun молча
  игнорирует `port` при `unix` — проверено пробой).
- Стейл-проба: `Bun.connect({unix})`; **любой** reject, кроме EACCES → stale
  (коды врут: стейл даёт ENOENT); EACCES → «занято» (живой 0600-сокет чужого
  пользователя); перед unlink обязателен `stat().isSocket()` — обычный файл по
  пути даёт тот же EADDRINUSE и удалён быть не должен. TOCTOU — best-effort,
  одна строка в доке.
- Bun сам удаляет сокет-файл на `stop()` (проба) — пинится тестом в обоих
  путях (idle `stop(true)` и in-flight `stop(false)`); после SIGKILL файл
  остаётся и повторный bind даёт EADDRINUSE — гигиена реально нужна.
- Handle: `port: 0` + `url: 'unix://<path>'` (аддитивно; `number | undefined`
  было бы breaking для общего `ManagedServerHandle`). `handle.url` в unix-режиме
  — идентификатор, не fetchable-адрес (в доку).
- `unix` + `socket` (Socket.IO lifecycle) — ошибка: socket.io-client не умеет
  unix, дверь была бы недостижима. Сырой `websocket` разрешён, с оговоркой в
  доке (Bun-клиент WS по unix не ходит).
- Клиентский seam: параметризовать `createRetryAwareFetch(unix?)`; при заданном
  `unix` **все** attempt'ы идут материализующей веткой `fetch(input.url,
  {...init, unix})` — форма `fetch(Request, {unix})` у Bun не документирована, а
  attempt-1 passthrough (Next.js memoization) для unix-кейса нерелевантен; без
  `unix` поведение бит-в-бит прежнее. Без `as`-кастов (config-строка через
  параметр, не через kyOptions).
- Ошибка «нет сокет-файла» не ретраится (`shouldRetryBunNetworkError` ловит
  только ConnectionRefused) — пинится тестом как внятный `ApiError`, семантика
  осознанно не расширяется.
- `ServerPassthrough` Omit **не трогать**: `unix` остаётся вычеркнут из
  passthrough, чтобы не появился второй путь мимо гигиены и проверок.
- Новых экспортов нет → `public-surface.json` не меняется (проверить);
  reference.md — дополнить описания `HttpClientConfig`/`BunServerConfig`.
- srvx node-адаптер unix не умеет (port всегда резолвится числом) — честный
  Bun-only, `NodeServerConfig` не трогаем.
- Сокет-пути в тестах — короткие уникальные temp-пути (лимит sun_path ~108
  байт; культура no-fixed-ports).
- Дефолтный mode сокета у Bun — 0755 при обычном umask, но connect(2) требует
  write → практически owner-only; в гайде указать измеренный факт и всё равно
  рекомендовать `mode: 0o600` для паттерна «доступ к сокету = credential».

## План

- [x] Сервер: добавить `unix?: string` в `BunServerConfig`; ветка
      `Bun.serve({ unix, fetch, websocket })`; ошибка при одновременном
      `unix` + `port`/`hostname`; вернуть `unix` в passthrough-Omit не нужно —
      он становится first-class полем.
- [x] Стейл-файл: перед bind, если файл существует — пробный connect; нет
      ответа → unlink; отвечает → ошибка «address in use». Опция
      `unixMode?: number` (chmod после listen); дефолт — как создаёт Bun, но в
      гайде явно: для паттерна «доступ к сокету = credential» нужен `0o600`
      (запрос живого потребителя).
- [x] Handle: для unix-режима `url` = `unix://<path>`, `port` = 0 или
      отсутствие — выбрать и зафиксировать в типах/доке.
- [x] Node-адаптер: проверить поддержку unix в srvx; если её нет — явно
      задокументировать «Bun-only пока», без полу-поддержки.
- [x] Клиент: `unix?: string` в `HttpClientConfig` как **плоская строка** (без
      Bun-типов — вход `stitchkit` browser-safe); прокинуть в init внутри
      обёртки fetch (`{ ...init, unix }` — лишний ключ игнорируется другими
      рантаймами); задокументировать, что работает в Bun (Node/undici требует
      dispatcher — вне scope, отметить).
- [x] Shutdown-путь: убедиться, что graceful/force shutdown убирает
      сокет-файл (Bun сам? проверить и запинить тестом).
- [x] Тесты: e2e сервер+типизированный клиент через unix-сокет (roundtrip,
      ошибка-конверт, shutdown удаляет файл, стейл-файл перезахватывается);
      type-test взаимоисключения `unix`/`port`.
- [x] Docs: guide (server + clients), api reference, CHANGELOG `[Unreleased]`,
      llms regen через build.

## Acceptance

- [x] Полный путь «defineContract → createServer({unix}) →
      createClient(createHttpClient({unix}))» проходит в тесте без единого
      голого fetch.
- [x] Повторный старт после SIGKILL предыдущего процесса поднимается без
      ручного удаления сокет-файла.
- [x] `bun run verify` зелёный; никакие Bun-типы не утекли в browser-safe вход
      (consumer-lane это ловит).

## Что сделано

- Core (сервер):
  - [x] `packages/core/src/server/bun.ts` — `unix?: UnixListenConfig` (`string | { path, mode }`), unix-ветка `Bun.serve` без ключей `port`/`hostname`, `chmodSync` после listen, `reclaimStaleUnixSocket` (isSocket + uid-guard + probe-сабпроцесс с EACCES-кодом 2 и `exitedDueToTimeout` → отказ; для compiled-бинаря интерпретатор резолвится `Bun.which('bun')`, иначе громкий отказ), запрет пустого пути, запрет `unix`+Socket.IO; handle `port: 0`, `url: unix://<path>`
- Core (клиент):
  - [x] `packages/core/src/browser/http.ts` — `unix?: string` в `HttpClientConfig`, `createRetryAwareFetch(unix)` материализует все attempt'ы; без Bun-типов в browser-safe входе
- Тесты (`packages/core/tests/unix-transport.test.ts`, 11 кейсов):
  - [x] `serves the typed client end-to-end over a unix socket, POST body included`
  - [x] `delivers the stitchkit error envelope over the socket`
  - [x] `a missing socket file yields an ApiError, not a hang` + `transport retry through the unix seam stays materialized and still fails cleanly`
  - [x] `rejects unix combined with port or hostname, and with the Socket.IO lifecycle` · `rejects an empty socket path instead of silently starting TCP`
  - [x] `applies the requested socket file mode`
  - [x] `a clean shutdown removes the socket file — idle and with in-flight work`
  - [x] `reclaims a stale socket left by a SIGKILLed process` (фикстура `fixtures/unix-socket-holder.ts`) · `refuses a path answered by a live listener and does not unlink it` · `refuses a regular file at the socket path and does not unlink it`
- Docs:
  - [x] `docs/guide/server.md` (Local daemon over a unix socket), `docs/guide/client.md` (Unix domain sockets), `docs/api/reference.md`, CHANGELOG `[0.53.0]`, `public-surface.json` (+`UnixListenConfig`)
- Отклонения от плана (осознанные, по конвейерной валидации):
  - [x] Type-test взаимоисключения заменён runtime-тестом — XOR-union ломал бы `interface X extends BunServerConfig`
  - [x] «Новых экспортов нет» из плана не сбылось: `UnixListenConfig` экспортирован и отражён в surface/reference
  - [x] TOCTOU-гарантия «через EADDRINUSE» из раннего комментария снята — probe-then-unlink задокументирован как best-effort
