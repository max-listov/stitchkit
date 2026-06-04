---
title: createSocketIOClient — token handshake auth (не только cookie)
description: Добавить auth/query в SocketIOClientConfig, чтобы клиент мог авторизовать handshake JWT-токеном, а не только cookie (withCredentials). Поддержать ротацию токена.
type: task
status: done
created: 2026-06-05
updated: 2026-06-05
completed: 2026-06-05 20:52
---

# createSocketIOClient — token-based handshake auth

## Проблема

`createSocketIOClient` сейчас умеет авторизовать соединение только **cookie** —
через `withCredentials: true`. Поля для **token-based handshake auth** (JWT в
`handshake.auth.token` — мейнстримный паттерн socket.io) нет.

Браузерное приложение с сессионной cookie это устраивает. Но приложения,
которые держат токен явно (desktop, mobile, CLI, server-to-server),
**не могут передать токен чисто** — у них нет cookie-контекста.

## Мотивирующий кейс

Приложение, держащее токен явно (desktop / mobile / CLI), авторизует
сокет **access-JWT**, а не cookie. Сейчас при миграции на `createSocketIOClient` пришлось зашивать
токен в **query-string URL** (`wss://host/socket.io/?token=...`), а на сервере
читать `socket.handshake.query.token`. Это работает, но:

- токен светится в URL → access-логи прокси, потенциально referrer;
- при ротации токена нужно пересоздавать клиента с новым URL (терять
  durable-подписки), т.к. `config.url` фиксирован на момент создания.

`auth` решил бы оба пункта.

## Предложение

Добавить в `SocketIOClientConfig`:

```ts
/** Handshake auth payload — passed to io(url, { auth }). Token-based auth,
 *  the alternative to cookie auth (withCredentials). A function form is
 *  re-read on every (re)connect, so a rotated token is picked up without
 *  recreating the client. */
auth?: Record<string, unknown> | (() => Record<string, unknown> | Promise<Record<string, unknown>>)
```

И прокинуть в `io(config.url, { auth: config.auth, ... })`. socket.io-client
уже поддерживает `auth` как объект или функцию `(cb) => cb({ token })` —
функциональная форма закрывает ротацию (на reconnect токен перечитывается).

Опционально (если дёшево): `query?` и `extraHeaders?` тем же прокидыванием.

## Серверная сторона

Изменений не требует — handshake-auth это уже project-логика
(`io.use(...)` / connection-handler читает `socket.handshake.auth`).
Стоит только в `docs/guide/realtime.md` показать токен-вариант рядом с
cookie-вариантом (сейчас гайд показывает только cookie).

## Заметки

- Объём — ~3 строки + поле типа + строчка в доке. Низкий риск.
- Ценность общая: token-auth для сокета встречается не реже cookie-auth
  (мобайл, десктоп, межсервисное). Сейчас либа покрывает только половину.
- Идея пришла из миграции реального приложения на stitchkit Socket.IO.

---

## План реализации (проработан 2026-06-05)

### Проверено в исходниках (не на словах)

- `socket.io-client@4.8.3` `SocketOptions.auth` — тип
  `{ [key:string]: any } | ((cb: (data: object) => void) => void)`
  (`build/esm/socket.d.ts:36`). Объектная и колбэк-форма.
- **Re-read на reconnect подтверждён:** `socket.js` `onopen()` (строка ~406):
  `if (typeof this.auth == "function") this.auth((data) => this._sendConnectPacket(data))`.
  Функция вызывается на КАЖДЫЙ open (вкл. reconnect) → ротация токена работает
  без пересоздания клиента.
- `query` / `extraHeaders` — это `EngineOptions` (engine.io-client
  `socket.d.ts`): `query?: { [k]:any }`, `extraHeaders?: { [h]: string }`.
  `ManagerOptions extends EngineOptions`, `io(url, opts)` принимает оба на
  верхнем уровне. Cast-free.

### Изменения

**1. `packages/core/src/browser/socket-io.ts` — расширить `SocketIOClientConfig`:**

```ts
/** Handshake auth payload — token-based auth, the alternative to cookie auth
 *  (withCredentials). A function is re-read on every (re)connect, so a rotated
 *  token is picked up without recreating the client. */
auth?: Record<string, unknown>
  | (() => Record<string, unknown> | Promise<Record<string, unknown>>)
/** Extra query params on the handshake URL. */
query?: Record<string, string | number | boolean>
/** Extra handshake headers. Browsers apply these to the polling transport only
 *  (a WebSocket upgrade cannot set headers) — for a browser WS use `auth`. */
extraHeaders?: Record<string, string>
```

Внутренний адаптер (наша friendly-форма → колбэк-форма socket.io), cast-free:

```ts
function toIoAuth(
  auth: SocketIOClientConfig['auth'],
): Record<string, unknown> | ((cb: (data: object) => void) => void) | undefined {
  if (typeof auth !== 'function') return auth
  return (cb) => { void Promise.resolve(auth()).then(cb) }
}
```

Прокинуть в `io(config.url, { ... })`: `auth: toIoAuth(config.auth)` всегда;
`query` / `extraHeaders` — спредом только если заданы.

**Cast-free доказано:** `Record<string,unknown>` → `{[k]:any}` (unknown→any),
адаптер возвращает ровно `(cb:(d:object)=>void)=>void`, наш payload (object)
подходит под `cb`. Ноль новых `as`.

### Серверная сторона — без изменений

`socket.handshake.auth` наполняется из CONNECT-пакета на уровне протокола
socket.io (engine-agnostic — одинаково Bun/Node). Меняем только доку.

### Тесты (`packages/core/tests/socket-io.test.ts`)

Сервер с `io.use((s, next) => ...)`, читающим `s.handshake.auth.token`:

1. **object-auth, валидный токен** → `connect`.
2. **невалидный/отсутствующий токен** → `connect_error`, соединения нет.
3. **function-auth + ротация:** функция отдаёт меняющийся токен; форсим
   reconnect (`io.disconnectSockets()` на сервере) → сервер видит НОВЫЙ токен.
4. **query passthrough** → `s.handshake.query.token` доходит.

### Документация

- `docs/guide/realtime.md` — token-вариант рядом с cookie: клиент
  `auth: () => ({ token })` + сервер `io.use` с `verifyJwt` (`stitchkit/server`).
  Обновить список полей `SocketIOClientConfig` (`auth`/`query`/`extraHeaders`) +
  gotcha про `extraHeaders` (polling-only в браузере).
- `docs/api/reference.md` — новые поля конфига.
- `CHANGELOG.md` — Unreleased.

### Edge cases

- **Ротация** — функция re-read на reconnect (подтверждено в src).
- **Async токен** (`await getToken()`) — Promise-адаптер.
- **`auth` не задан** — passthrough; cookie-auth (`withCredentials`) остаётся
  дефолтом. Можно слать оба (cookie + token).
- **Hard auth-fail** → `connect_error` + бесконечный reconnect (дефолт
  `reconnectionAttempts: Infinity`) долбит сервер. Отметка в доке: для
  token-auth задавать конечный `reconnectionAttempts`. *(Опционально — surfacing
  `connect_error` через новый колбэк; в core НЕ тащим, отдельная задача.)*

### НЕ делаем

- ADR не нужен (добавление полей конфига, не архитектурное решение).
- Backward-compat не нужен — поля новые, опциональные.
- Объём: ~10 строк кода + поля типа + тесты + дока. Низкий риск.

---

## Что сделано (2026-06-05)

### Client (`stitchkit`)
- [x] `SocketIOClientConfig` — поля `auth` / `query` / `extraHeaders`
  (`packages/core/src/browser/socket-io.ts`).
- [x] `toIoAuth()` — адаптер friendly-формы (`() => token | Promise<token>`) в
  колбэк-форму socket.io; объект/undefined passthrough. Cast-free.
- [x] Проброс в `io(config.url, { auth, query?, extraHeaders?, … })`.

### Tests (`packages/core/tests/socket-io.test.ts`)
- [x] describe «Socket.IO handshake auth» (6 тестов): object valid, reject,
  function rotation (re-read на reconnect, durable-подписка выжила), async
  function, query+extraHeaders. Отдельный auth-сервер с `io.use`.

### Docs
- [x] `docs/guide/realtime.md` — секция «Handshake auth — cookie or token»
  (клиент `auth` + сервер `io.use` + `verifyJwt`) + обновлён список полей конфига
  + gotcha про `extraHeaders` (polling-only) и connect_error.
- [x] `docs/api/reference.md` — тип в таблице, поля раскрыты в гайде.
- [x] `CHANGELOG.md` — Unreleased.

### Что НЕ делалось
- Серверная сторона — без изменений (`handshake.auth` — protocol-level).
- Surfacing `connect_error` — отдельная задача (отмечено в доке).
- ADR — не нужен.

### Verify
- [x] `bun run verify` — зелёный (lint + tsc + 350 tests + build).
