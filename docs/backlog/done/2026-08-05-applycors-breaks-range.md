---
title: "applyCors ломает HTTP Range: ответ 206 отдаёт весь файл"
description: create.ts пересобирает Response ради CORS-заголовков, и на Bun body от Bun.file().slice() перечитывается целиком — статус и Content-Range обещают диапазон, а в теле весь файл.
type: task
status: done
created: 2026-08-05
updated: 2026-08-05
completed: 2026-08-05 17:20 +07:00
---

# `applyCors` ломает Range — живой баг, найден при проработке binary-endpoints

Найден валидатором плана `2026-08-05-binary-endpoints.md`, но **к binary
отношения не имеет** — воспроизводится сегодня, на обычном raw-роуте с
`serveFile` и включённым CORS.

## Факт (замерено, не вычитано)

`server/create.ts` в `applyCors` делает `new Response(res.body, …)`, чтобы
дописать CORS-заголовки. На Bun `res.body` у ответа, построенного из
`Bun.file().slice()`, перечитывает **весь файл**:

```
serveFile напрямую:            206, content-length 5,  тело "HELLO"
через applyCors, по проводу:
  Range: bytes=0-4   → 206, content-length 26, тело "HELLO-PDF-BYTES-0123456789"
  Range: bytes=10-14 → 206, Content-Range "bytes 10-14/26", тело "BYTES-0123456789"
```

Статус и `Content-Range` продолжают обещать диапазон, а payload — файл целиком.
Клиент, который склеивает части (видеоплеер, download-менеджер, `curl -C -`),
получит мусор.

## Лечение (проверено тем же замером)

Мутировать заголовки **на месте**, пересобирать только если объект неизменяем:

```
mutate-in-place: 206 · content-range bytes 10-14/26 · content-length 5 · тело "BYTES"
```

Обоснование безусловной пересборки («заголовки редиректа неизменяемы») на Bun не
подтвердилось — `Response.redirect(...).headers.set()` в пробнике отработал. То
есть `try/catch` оставить, безусловную пересборку убрать.

**Уточнено при реализации:** на **Node** тот же `set` бросает
`TypeError: immutable` (проверено, v24.18). Значит комментарий был верен — но для
Node, а не как общее правило; ветка `catch` остаётся обязательной, потому что
stitchkit поддерживает оба рантайма.

## Смежное, в тот же заход

- **`Vary` затирается, а не дописывается** (`middleware/cors.ts:76-78` через
  `headers.set` в `applyCors`) — хендлер, поставивший `Vary: Accept-Encoding`,
  теряет его. Файловые ответы как раз те, что несут `Vary`.
- **Нет `Access-Control-Expose-Headers` нигде в кодовой базе.** Cross-origin
  `fetch` не может прочитать `Content-Disposition` / `ETag` / `Content-Range` /
  `Content-Length` — браузер не восстановит имя файла при скачивании. Нужен
  `CorsConfig.exposeHeaders` (и разумный дефолт для файловых ответов).

## Почему это блокер для binary-endpoints

Acceptance той таски содержит «`serveFile` внутри binary-хендлера работает без
обёрток (Range/ETag/304)». Пока `applyCors` перестраивает ответ, Range там
сломан — то есть критерий был бы принят на сломанном поведении.

## План

- [x] Мутация заголовков на месте в `applyCors`, пересборка только по факту
      неудачи; тест на Range через полный HTTP-путь (не на голом `serveFile`)
- [x] `Vary` дописывать
- [x] `CorsConfig.exposeHeaders` + дефолт для файловых ответов
- [x] CHANGELOG — `### Fixed`, это исправление тихой порчи данных

## Что сделано

### Замеры (перед кодом)

- Баг воспроизведён: `Range: bytes=10-14` на 26-байтовом файле → через
  пересборку тело `"BYTES-0123456789"` при `Content-Length: 5`; мутация на
  месте → `"BYTES"`.
- Посылка старого комментария проверена на обоих рантаймах:
  `Response.redirect().headers.set()` — **Bun разрешает, Node бросает
  `TypeError: immutable`**. Значит комментарий верен для Node, и `try/catch`
  остаётся; безусловной пересборки быть не должно.

### Код

- [x] `server/create.ts` — `applyCors` мутирует заголовки на месте, пересборка
      ушла в `catch` (единственный реальный случай — редирект, у которого нет
      тела). Комментарий переписан: сказано, ЧТО именно портила пересборка.
- [x] `server/create.ts` — новый `setCorsHeader`: `Vary` дописывается через
      запятую с дедупом `Origin`, остальные CORS-заголовки как были (`set`).
- [x] `server/middleware/cors.ts` — `CorsConfig.exposeHeaders?: string | string[]`
      + `DEFAULT_CORS_EXPOSE_HEADERS` (явный список, не `*` — wildcard
      игнорируется на credentialed-запросах, т.е. ровно на авторизованной
      выгрузке). `[]` → заголовок не эмитится.
- [x] `server/index.ts` + `docs/api/reference.md` — экспорт константы
      (reference уезжает в `llms.txt`, поэтому правится вместе с экспортом).
- [x] `docs/guide/server.md` — строка `ServerConfig.cors` расширена; абзац про
      чтение заголовков выгрузки cross-origin рядом с `serveFile`.

### Тесты

- [x] `tests/cors-response-integrity.test.ts` (9) — всё **по проводу**, потому
      что на прямом вызове `serveFile` баг невидим (этим он и прошёл мимо
      существующего сьюта): диапазон отдаёт ровно запрошенные байты; средний
      диапазон не растягивается до EOF; CORS-заголовки доезжают до 206; полный
      GET и HEAD не изменились; `Vary` хендлера выживает и не дублируется;
      expose-заголовки читаемы; редирект (ветка `catch`) всё ещё декорируется.
- [x] Проверено, что тест — **настоящая регрессия**: со временно возвращённой
      пересборкой 2 из 9 падают (`Content-Length` 16 вместо 5, тело до конца
      файла).
- [x] Полный сьют: 668 pass / 0 fail (было 659).

### Ссылки на код

- `packages/core/src/server/create.ts` → `applyCors`, `setCorsHeader`
- `packages/core/src/server/middleware/cors.ts` → `DEFAULT_CORS_EXPOSE_HEADERS`
- `packages/core/tests/cors-response-integrity.test.ts`
