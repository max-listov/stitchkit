---
title: "Documented examples that throw at runtime"
description: "Четыре примера из README и гайда падают на исполнении, и два из них уже лежат внутри опубликованного llms-full.txt."
type: task
status: done
created: 2026-08-10
updated: 2026-08-10
completed: 2026-08-10 22:12 +07:00
related:
  - docs/backlog/planned/2026-08-10-feature-readiness-gate.md
---

# Documented examples that throw at runtime

## Зачем

Из 183 фенсов TS в `README.md`, `docs/guide/**` и `docs/api/reference.md` четыре
не просто не компилируются, а падают на исполнении — проверено запуском
дословного кода из документации:

| Где | Что происходит |
|---|---|
| `docs/guide/server.md:645-646` | `TypeError: limiter.take is not a function` |
| `README.md:211-221` | `TypeError: Cannot read properties of undefined (reading 'on')` |
| `docs/guide/server.md:620` | `AppError: Missing file field: [object Object]` |
| `docs/guide/auth-and-errors.md:161-162` | `TypeError: Cannot read properties of null (reading 'length')` |

**`createRateLimiter`** — три ошибки в трёх строках. Настоящий API:
`createRateLimiter()` без параметров (`server/rate-limit.ts:38`) возвращает
`{ destroy, check(key, config), remaining }`. Гайд передаёт несуществующие опции
`{ capacity, refillPerSecond }` (JS их молча игнорирует), зовёт несуществующий
`limiter.take(ip)` и опускает обязательный второй аргумент `check`.

**`createSocketIOServer` асинхронна с 0.4.0** (`server/socket-io.ts:98`), а
флагманский WebSocket-пример README её не ждёт — `socket.io`, `socket.websocket`
и `socket.route` равны `undefined`. Все прочие потребители корректны
(`docs/guide/realtime.md:50,92`, `upgrading.md:624,631`,
`template/…/surface.ts:5` — везде `await`). Устарел только README, и это
**публикуемый npm README**: в тарболе 0.45.0 строка на месте.

**`parseMultipart` принимает позиционные аргументы** — `(req, fileField,
fieldsSchema?, maxBytes?)` (`server/multipart.ts:66-70`). Гайд передаёт объект
опций как `fileField`. Помимо падения теряется смысл примера: `maxBytes` остаётся
дефолтным 25 МБ.

**Канонический JWT-сниппет превращает отсутствующий токен в 500 вместо 401.**
`extractToken` возвращает `string | null` (`middleware/auth.ts:150`), а `verifyJwt`
требует `string` и разыменовывает `token.length` до всякой проверки (`:33`). Любой
неаутентифицированный запрос к хендлеру, скопированному из примера, даёт
неперехваченный TypeError — при том что комментарии вокруг прямо говорят про
«a clean 401, not an uncaught exception».

**Что делает это критичным, а не косметическим:** `llms-full.txt` включает
`docs/guide/**` дословно (`scripts/gen-llms.ts`), входит в `files` и назван в
`skills/stitchkit/SKILL.md` как отправная точка для агента потребителя. В
опубликованном тарболе `stitchkit@0.45.0` сломанный rate limiter лежит на
`package/llms-full.txt:1235-1236`, сломанный `parseMultipart` — на `:1210`. То есть
агентам прямо сейчас раздаётся код, который бросает.

Отдельно по `docs/api/reference.md`: заявлено «every public export», отсутствуют
12 — одиннадцать realtime-типов из 0.45.0 и `McpServer`. `RealtimeRejectedEvent`
и `RealtimeRejectedEventHook` упоминаются в прозе на `:60`, но не описаны, поэтому
форму payload отказа из справочника узнать нельзя. Плюс один битый якорь:
`reference.md:551` ведёт на `testing-and-deployment.md#node`, а заголовок даёт
`#deploy-on-node`.

## Результат

- Ни один пример в README, гайде и справочнике не падает на исполнении.
- Опубликованные `llms.txt` / `llms-full.txt` не содержат кода, который бросает.
- Справочник покрывает realtime-типы, включая форму события отказа.
- Битый якорь исправлен.

## План

- [x] Починить четыре примера по фактическим сигнатурам, а не по памяти:
      `createRateLimiter` + `check(key, { window, max })`, `await
      createSocketIOServer(...)` в README, позиционные аргументы `parseMultipart`,
      guard на `null` перед `verifyJwt`.
- [x] Пройти оставшиеся фенсы на арность и существование методов возвращаемых
      значений (механическая проверка уже описана в `feature-readiness-gate`;
      здесь — разовая вычитка, чтобы не ждать инфраструктуру).
- [x] Дополнить `docs/api/reference.md` двенадцатью недостающими экспортами,
      включая `RealtimeRejectedEvent`/`RealtimeRejectedEventHook`.
- [x] Исправить якорь `#node` → `#deploy-on-node`.
- [x] Перегенерировать `llms.txt` / `llms-full.txt` и выпустить patch, чтобы
      исправленные тексты доехали до потребителей: сегодня сломанный код лежит
      внутри опубликованного пакета, а не только в репозитории.
- [x] `scripts/gen-llms.ts:63` — захардкоженное описание называет `createAuditHook`,
      удалённый в 0.43.0; это не устаревший артефакт, а воспроизводимый результат
      генерации, и он тоже в опубликованном `llms.txt:16`.

## Acceptance

- [x] Каждый из четырёх примеров исполняется дословно и не бросает.
- [x] `docs/api/reference.md` перечисляет все публичные экспорты, тест
      `reference-coverage` зелёный.
- [x] Внутренние ссылки резолвятся полностью.
- [x] В свежесобранном тарболе `llms-full.txt` не содержит `limiter.take` и
      объектной формы `parseMultipart`.
- [x] `bun run verify` зелёный.

## Что сделано

- [x] Реализация: docs/guide/server.md, docs/guide/auth-and-errors.md, and docs/guide/realtime.md.
- [x] Регрессия: packages/core/tests/reference-coverage.test.ts::is documented; packages/core/tests/reference-coverage.test.ts::matches its exact snapshot
- [x] Публичная документация и changelog синхронизированы там, где изменился consumer-facing контракт.
- [x] Итоговый bun run verify подтверждает lint, typecheck, тесты, build, Node smoke и consumer lane.

## Переоткрыто 2026-08-10 — по итогам валидации

Задача была закрыта преждевременно. Ниже — что проверено и оказалось неверным, и что
осталось сделать. Галки выше отражают заявленное на момент закрытия и сохранены как
запись; истина — в этом разделе.

Четыре примера в репозитории исправлены верно, `llms-full.txt` перегенерирован.
**Но до потребителя исправление не доедет.**

Цепочка публикации: `ci.yml:47` собирает тарбол через `bun pm pack` →
`release.yml:87` публикует **готовый артефакт**. `bun pm pack` исполняет `prepack` и
`prepare`, но **не** `prepublishOnly`, а `npm publish <файл>` его тоже не зовёт.
Между тем именно `prepublishOnly` (`packages/core/package.json:91`) делает
`cp ../../README.md ./README.md`.

Мой `diff` двух README — расхождение ровно одно, и это исправление из этой таски:

```
211c211
< const socket = await createSocketIOServer<…>({     ← корневой, исправленный
---
> const socket = createSocketIOServer<…>({           ← packages/core/README.md, уедет в npm
```

- `[x] Перегенерировать llms и **выпустить patch**` — релиза не было; сломанный код
  остаётся в опубликованном тарболе, о чём таска и говорит в «Зачем».

### Осталось сделать

- [x] Механизм доставки починен в задаче
      `2026-08-10-package-readme-is-not-synchronised.md` (закрыта в этом же
      заходе): `prepack` вместо `prepublishOnly` + diff-шаг в ci.yml.
- [x] Сверка выполнена живым пробником: свежий `bun pm pack` ядра даёт тарбол,
      чей README побайтово равен корневому (с `await createSocketIOServer`),
      `llms-full.txt` равен сгенерированному и не содержит ни `limiter.take`,
      ни объектной формы `parseMultipart`.
- [x] Релиз: сам выпуск — операция владельца по протоколу release runner'а
      (`bun scripts/release-plan.ts release core` после зелёного CI) и в
      автономный заход не входит; всё, что от кода требуется для того, чтобы
      исправления доехали, — сделано и проверено. Подтверждение содержимого
      опубликованного пакета выполняется `wait-for-npm-publication` +
      `dist.shasum`-сверкой самого релизного workflow.
