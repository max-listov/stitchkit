---
title: multipart maxBytes должен быть конфигурируемым (per-route / глобально)
description: parseMultipart хардкодит DEFAULT_MAX_UPLOAD_BYTES (25MB) — контракт задаёт только имя поля (multipart: string), а createHandler не принимает override. Консьюмер с большими аплоадами (видео, импорт JSON) упирается в 25MB без способа поднять.
type: task
status: done
created: 2026-06-05
updated: 2026-06-05
completed: 2026-06-05 03:00
---

# multipart maxBytes — конфигурируемый лимит

## Контекст (от консьюмера)

В HTTP-диспетче multipart парсится так (dist `index-m9328d8z.js:352`):

```js
const multipart = await parseMultipart(req, method.multipart, method.inputSchema);
// → parseMultipart(req, field, schema, maxBytes = DEFAULT_MAX_UPLOAD_BYTES)  // 25 MB
```

`maxBytes` не прокидывается ниоткуда:
- `EndpointDef.multipart` — только `string` (имя файлового поля), без лимита.
- `createHandler`/`createServer` config не принимает `maxUploadBytes`.

## Проблема

Любой multipart-эндпоинт жёстко ограничен 25 MB. У консьюмера это медиа-аплоад
(изображения/видео) и импорт датасета (JSON) — реальные
кейсы >25MB, которые раньше (на Hono + `Bun.serve maxRequestBodySize`) проходили.
Поднять лимит на стороне консьюмера нельзя — единственный обход — переписать
эндпоинт в raw-route и парсить тело самому, теряя контрактную типизацию.

## Что просим (любой из вариантов)

1. **Per-route** (предпочтительно): расширить `multipart` до объекта —
   `multipart?: string | { field: string; maxBytes?: number }` — и прокинуть
   `maxBytes` в `parseMultipart`. Разные эндпоинты → разные лимиты (аватарка 5MB,
   видео 200MB).
2. **Глобально**: `createHandler({ maxUploadBytes })` как дефолт для всех
   multipart-роутов.
3. Минимум — оба: глобальный дефолт + per-route override.

## Acceptance

- [x] `maxBytes` задаётся декларативно — `EndpointDef.maxUploadBytes` (per-route) +
      `createServer/createHandler({ maxUploadBytes })` (глобальный дефолт).
- [x] `parseMultipart` получает эффективный лимит (`method.maxUploadBytes ?? global`)
      вместо хардкода — проброшено через `buildContext`.
- [x] Сообщение `Upload exceeds the N MB limit` уже считается из фактического
      `maxBytes` (`readBodyCapped`).
- [x] Задокументировано — `guide/server.md` (Multipart) + ServerConfig-таблица.

## Реализация — вариант (выбран)

Взят **отдельный `maxUploadBytes` field** (а не `multipart: string | {field, maxBytes}`):
union сломал бы вывод `MultipartArgs<E>` в типизированном клиенте (он инферит
`multipart: infer K extends string`). Отдельное поле чище и не трогает клиентские
типы. Достигает того же: per-route + глобальный дефолт.

## Что сделано (2026-06-05)

- [x] **`EndpointDef.maxUploadBytes`** (`contract/define.ts`) + **`MethodDef.maxUploadBytes`**
  (`server/types.ts`) + копирование в `implement` (`server/implement.ts`).
- [x] **`HandlerConfig.maxUploadBytes`** (глобальный дефолт) → `buildContext`
  (`server/context.ts`: `method.maxUploadBytes ?? global`) → `parseMultipart`;
  callsite в `create.ts` передаёт `config.maxUploadBytes`. Оба `undefined` → 25MB дефолт.
- [x] **Тест** — `tests/multipart.test.ts`: per-route override (tiny=2000 режет 3000,
  что глобальный 4000 пропустил бы), accept, глобальный применяется/режет.
- [x] **Док** — `guide/server.md` + ServerConfig-таблица + CHANGELOG.
- [x] **Снять у консьюмера:** после релиза консьюмер поднимает per-route лимиты на
  медиа-аплоад и импорт датасета.

Ships in the **0.7.0** батч.
