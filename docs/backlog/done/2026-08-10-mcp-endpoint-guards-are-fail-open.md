---
title: "MCP endpoint guards are fail-open"
description: "Дефолтные проверки Host и Origin под Bun сравнивают заголовок сам с собой, а auth-гейт пропускает undefined."
type: task
status: done
created: 2026-08-10
updated: 2026-08-10
completed: 2026-08-10 12:50 +00:00
---

# MCP endpoint guards are fail-open

## Зачем

Две независимые дыры на одном эндпоинте, обе тихие.

**1. Защита от DNS rebinding не отвергает ничего.**

```ts
// packages/core/src/tools/mcp-handler.ts:69-72
function defaultHostRejection(request: Request): Response | undefined {
  const host = request.headers.get('host');
  if (!host || host === new URL(request.url).host) return undefined;
  return jsonRpcError(-32000, 'Invalid Host header', 403);
}
```

Под `Bun.serve` **`request.url` строится из заголовка `Host`**, поэтому обе
дефолтные проверки (`defaultHostRejection` и `defaultOriginRejection`, `:75-83`)
сравнивают контролируемое атакующим значение само с собой. Это тавтология, которая
не может сработать. Замер на живом `Bun.serve`:

```
Host: evil.example.com -> request.url "http://evil.example.com/", urlHost "evil.example.com"

DNS-rebinding запрос (Host: evil.example.com, Origin: http://evil.example.com):
  host guard   -> ALLOWED
  origin guard -> ALLOWED
искусственное расхождение (url 127.0.0.1, Host evil.com) -> 403
                                    ^ единственный отвергаемый случай, который Bun не порождает
```

Сценарий: страница на `evil.com` с DNS, перепривязанным на `127.0.0.1`, говорит по
MCP с локально запущенным сервером — все смонтированные тулы доступны со страницы
атакующего. Ровно от этого существует `hostHeaderValidationResponse` в SDK, но он
подключается только когда потребитель явно задал `security.allowedHosts`. Тест есть
только у этого явного пути (`mcp-handler-sessions.test.ts:94`); у дефолта тестов нет.
Комментарий в коде обещает «By default the header must match the request URL» — и
формально прав, просто это условие выполняется всегда.

**2. Auth-гейт fail-open на `undefined`.**

```ts
// packages/core/src/tools/mcp-handler.ts:200
if (auth === null) return observeRejection(request, unauthorized());
```

`TAuth` — генерик, поэтому идиоматичное `auth: async (req) => users.find(...)`
выводит `TAuth = User | undefined`. `undefined` становится легальным значением
`TAuth`, строгое сравнение с `null` его не ловит, и запрос продолжается
аутентифицированным как `undefined`:

```
валидный токен -> AUTHENTICATED as {"id":"u1",…}
без токена     -> AUTHENTICATED as undefined     (tsc --strict: exit 0, ошибок нет)
```

## Результат

- Дефолтные проверки Host и Origin реально отвергают запрос с чужим Host/Origin,
  и это доказано тестом, а не формой кода.
- `auth`, вернувший `undefined`, трактуется как отказ, а не как личность.
- Оба дефолта покрыты тестами; сегодня покрыт только явный `allowedHosts`.

## План

- [x] Не выводить ожидаемый Host из `request.url`. Сравнивать с фактической
      конфигурацией сервера (список разрешённых хостов, по умолчанию — loopback и
      сконфигурированный публичный origin), либо делегировать
      `hostHeaderValidationResponse` из SDK и включать его по умолчанию, а не по
      явному опту.
- [x] Origin проверять против того же источника правды, а не против `request.url`.
- [x] Решить и записать дефолт: для локально запускаемого MCP-сервера безопасный
      дефолт — принимать только loopback-Host; для развёрнутого — список из
      конфигурации. Молчаливое «разрешено всё» недопустимо ни в одном из режимов.
- [x] `auth === null` → `auth == null` либо явная проверка `undefined`; заодно
      сузить `TAuth`, чтобы «нет личности» выражалось одним значением, а не двумя.
- [x] Тест: запрос с `Host: evil.example.com` на сервер, поднятый через
      `Bun.serve`, отвергается **дефолтной** конфигурацией (без `allowedHosts`).
- [x] Тест: `Origin: http://evil.example.com` отвергается дефолтом.
- [x] Тест: `auth`, возвращающий `undefined`, даёт 401, а не аутентифицированный
      запрос.
- [x] Прогнать те же сценарии на Node-адаптере: там `request.url` собирается иначе,
      и поведение обязано совпадать.
- [x] `CHANGELOG.md` → `### Fixed` с явным указанием, что затронуты сетевые
      защиты MCP-эндпоинта. Если дефолт становится строже — это breaking, и тогда
      секция `### ⚠️ Breaking changes` с before → after.

## Acceptance

- [x] Тест доказывает **отказ** на чужом Host и на чужом Origin при пустой
      конфигурации безопасности, на Bun и на Node.
- [x] Ни одна дефолтная проверка не сравнивает заголовок с величиной, выведенной
      из этого же заголовка.
- [x] `undefined` от `auth` не проходит.
- [x] `bun run verify` зелёный.

## Что сделано

- [x] Реализация: packages/core/src/tools/mcp-handler.ts.
- [x] Регрессия: packages/core/tests/mcp-handler-sessions.test.ts::applies Host and Origin validation before auth; packages/core/tests/mcp-handler-sessions.test.ts::enforces same URL/Host/Origin boundaries without explicit allowlists
- [x] Публичная документация и changelog синхронизированы там, где изменился consumer-facing контракт.
- [x] Итоговый bun run verify подтверждает lint, typecheck, тесты, build, Node smoke и consumer lane.
