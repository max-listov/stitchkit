---
title: S2 — убрать привязку к месту из собираемого артефакта шаблона
description: Внешний origin перестаёт вмораживаться в prerender и в серверный чанк; один артефакт обслуживает любой внешний адрес.
type: task
status: done
tags: [template, build, env, boundaries]
pipeline: placement-free-repository
order: 2
depends-on: []
created: 2026-08-24
updated: 2026-08-24
completed: 2026-08-24 22:25 +07:00
---

# S2 — убрать привязку к месту из собираемого артефакта шаблона

## Зачем

Сборка шаблона сегодня вмораживает внешний адрес в артефакт. Это не гипотеза —
проверено сборкой `bun --filter @app/frontend build` на текущем дереве:

1. `.next/server/app/robots.txt.body` и `.next/server/app/sitemap.xml.body`
   **предрендерены статически** (`○ (Static)` в выводе сборки) и содержат
   `http://127.0.0.1:3210` внутри байтов. Эти файлы физически не могут
   обслужить второй внешний адрес.
2. `.next/server/chunks/_0igazzc._.js` содержит литерал
   `NEXT_PUBLIC_API_URL:"http://127.0.0.1:3211"` — Next подставил значение на
   этапе сборки. Для контраста в том же объекте `WEB_PORT:process.env.WEB_PORT`
   осталось чтением рантайма: разница ровно в префиксе `NEXT_PUBLIC_`.

Уточнение к исходной формулировке, важное для плана: **в браузерный бандл
адрес не попадает**. `grep -rl "127.0.0.1" .next/static` не даёт ни одного
совпадения, потому что `packages/frontend/src/env.ts` не импортируется ни одним
клиентским модулем — его читают только `next.config.ts:4`,
`src/app/[locale]/layout.tsx:8` и `src/lib/seo/metadata.ts:2`, все серверные.
Значит чинить надо не «фронт обращается по абсолютному адресу» (сегодня фронт
шаблона к API вообще не обращается), а **серверный prerender и подстановку
`NEXT_PUBLIC_*` на этапе сборки**.

Источник обеих привязок один: `NEXT_PUBLIC_WEB_URL` и `NEXT_PUBLIC_API_URL`
объявлены `z.url()` в `packages/frontend/src/env.ts:9-12` и
`packages/config/src/server.ts:18-20`.

## Результат

- Ни одно имя `NEXT_PUBLIC_*` не остаётся в шаблоне. Что нужно серверу —
  читается в рантайме под именем без этого префикса; что нужно браузеру —
  не нужно браузеру.
- Публичный origin выводится **из входящего запроса** (`host` /
  `x-forwarded-proto`), а не из окружения сборки.
  `PUBLIC_WEB_ORIGIN` остаётся необязательным рантайм-переопределением для
  прокси, не пробрасывающего заголовок.

  **Цена, названная явно.** `robots.ts`, `sitemap.ts` и `metadataBase`
  перестают быть статическими для всех новых проектов: сегодня сборка помечает
  `/robots.txt` и `/sitemap.xml` как `○ (Static)`, после правки они станут
  динамическими. Плата принимается, но **не в форме «рендер на каждое
  обращение»**: результат — чистая функция от origin, поэтому он мемоизируется
  по `Host`. Выходит один рендер на адрес, а не на запрос; число адресов у
  deployment'а конечно и мало, кэш ограничен сверху и вытесняет по LRU, чтобы
  подделанный `Host` не мог его раздуть.
- Обращения браузера к API — относительным путём (`/api`); сопоставление
  делает слой маршрутизации. Абсолютный адрес остаётся возможным и
  необязательным — только для честного кросс-доменного случая.
- Схема адреса API ослабляется до «абсолютный или путь», по умолчанию путь.
- `CORS_ORIGIN` (`packages/config/src/server.ts:22`, обязательный `z.url()`)
  становится необязательным: при относительном пути кросс-доменного запроса
  нет и требовать его — значит требовать знать место.
- Тулинговые переменные (`scripts/tooling-env.ts:9-10`,
  `playwright.config.ts:5`, `scripts/runtime-smoke.ts:9`) переименовываются в
  `SMOKE_API_ORIGIN` / `SMOKE_WEB_ORIGIN`. Они **законно** привязаны к месту —
  это адрес поднятого deployment'а, куда стучится проверка, — но не должны
  называться так, чтобы попасть в подстановку сборки.

## План

- [x] Убрать `NEXT_PUBLIC_API_URL` и `NEXT_PUBLIC_WEB_URL` из
      `packages/frontend/src/env.ts` и `packages/config/src/server.ts`.
- [x] Ввести вывод origin из запроса в `src/lib/seo/metadata.ts`; перевести
      `robots.ts`, `sitemap.ts` и `metadataBase` в `layout.tsx:25` на него.
- [x] Мемоизировать выдачу по `Host` с ограниченным сверху кэшем: один рендер
      на адрес, не на обращение.
- [x] Заменить `allowedDevOrigins` в `next.config.ts:14` на источник, живущий
      только в режиме разработки.
- [x] Ослабить схему публичного адреса API до «абсолютный или путь»,
      относительный по умолчанию; сделать `CORS_ORIGIN` необязательным.
- [x] Переименовать тулинговые переменные и обновить `_env.example`,
      `scripts/dev.ts:95-98`, `e2e/starter.spec.ts:24,46`.
- [x] Отметить как breaking для шаблона: радиус ограничен новыми проектами,
      шаблон копируется в момент генерации.

## Acceptance

- [x] `grep -r "NEXT_PUBLIC_" packages/create-stitchkit/template` не находит
      ничего вне сгенерированных каталогов.
- [x] После `bun run build` ни один файл под `.next/` не содержит значения из
      `.env` — та же проверка, что нашла дефект, на этот раз пустая.
- [x] Один и тот же собранный артефакт отвечает по двум разным `Host` с
      правильным origin в `sitemap.xml`, `robots.txt` и OG-ссылках.
- [x] `bun run runtime:smoke` зелёный: `assertPublicWebSurface`
      (`scripts/web-surface-smoke.ts`) уже проверяет sitemap и OG — он и
      становится доказательством.
- [x] Второе обращение по тому же `Host` не пересобирает выдачу — доказано
      счётчиком в тесте, а не замером времени.
- [x] Ручной путь запуска без внешней платформы продолжает работать.

## Что сделано

### Артефакт

- [x] Ни одного `NEXT_PUBLIC_*` в шаблоне и примерах — только в комментариях,
      объясняющих, почему их там нет.
- [x] Публичный origin выводится из запроса:
      `packages/frontend/src/lib/seo/request-origin.ts` (`x-forwarded-host` →
      `host`, первый хоп из цепочки прокси, `x-forwarded-proto`, необязательный
      `PUBLIC_WEB_ORIGIN`).
- [x] `robots.ts`, `sitemap.ts` и `metadataBase` в `layout.tsx` переведены на
      него; `layout.tsx` сменил статический `export const metadata` на
      `generateMetadata`, `starter-page.tsx` стала асинхронной.
- [x] **Цена уплачена именно так, как оговорено.** `/robots.txt` и
      `/sitemap.xml` в выводе сборки перешли из `○ (Static)` в `ƒ (Dynamic)`.
      Ни одна другая страница маршрутный класс не сменила.
      `packages/frontend/src/lib/seo/cache-by-origin.ts` мемоизирует выдачу по
      origin с ограниченным сверху LRU: один рендер на адрес, не на обращение,
      и подделанный `Host` кэш не раздувает.

### Доказательство переносимости

- [x] Один build, три адреса, без пересборки:
      `Host: alpha.example` → `Sitemap: http://alpha.example/sitemap.xml`;
      `Host: beta.example` + `x-forwarded-proto: https` →
      `<loc>https://beta.example/en</loc>`;
      `Host: gamma.example` → `<link rel="canonical" href="https://gamma.example/en"/>`,
      `og:url` и JSON-LD `url` тем же адресом.
- [x] После сборки под `.next/` **не остаётся ни одного номера порта**:
      `grep -rl ":3210\|:3211" .next` пуст, тогда как до правки тот же поиск
      находил вмороженный origin в `robots.txt.body`, `sitemap.xml.body` и
      литерал `NEXT_PUBLIC_API_URL:"http://127.0.0.1:3211"` в серверном чанке.
      Единственный оставшийся `127.0.0.1` — `allowedDevOrigins` в
      `next.config.ts`, константа кода для dev-браузера, а не значение места.

### Окружение

- [x] `CORS_ORIGIN` необязателен. `createSocketIOServer({ cors })` в ядре тоже
      стал необязательным — требовать чужой origin от сервера, который будет
      отвечать на своём, значит требовать знать место.
- [x] Тулинговые адреса переименованы в `SMOKE_API_ORIGIN` / `SMOKE_WEB_ORIGIN`
      (`scripts/tooling-env.ts`, `playwright.config.ts`, `runtime-smoke.ts`,
      `e2e/starter.spec.ts`, `scripts/starter-lane.ts`, `_env.example`). Они
      законно привязаны к месту, но не должны носить префикс, который сборка
      подставляет.
- [x] `INTERNAL_API_URL` уехал из базовой схемы в необязательные адреса фронта
      рядом с новым `PUBLIC_API_ORIGIN`: в пустом шаблоне их не читает никто.

### Пример repository — где привязка была настоящей

- [x] Здесь браузер действительно дозванивается до API-роли и открывает сокет,
      и до правки делал это по `env.NEXT_PUBLIC_API_URL`, то есть по адресу,
      вкомпилированному в браузерный бандл. Относительный путь тут не подходит:
      Next-middleware не проксирует WebSocket-апгрейд, а rewrite в
      `next.config.ts` попал бы в `routes-manifest.json` на этапе сборки — то
      есть снова вморозил бы адрес.
- [x] Адрес стал рантайм-значением, которое сервер отдаёт браузеру на каждый
      запрос: `providers/index.tsx` — теперь серверный компонент, читает
      `lib/api/place.ts` и передаёт origin в `providers/client-providers.tsx`;
      `lib/api/origin.ts` хранит его, а API-клиент, url-builder, сокет и мост
      строятся лениво при первом использовании.
- [x] `lib/api/server-client.ts` вынесен отдельно, чтобы серверное окружение не
      втягивалось в клиентский граф.

### Регрессия

- [x] `packages/create-stitchkit/template/packages/frontend/src/lib/seo/cache-by-origin.test.ts` —
      `builds once per address, not once per request`,
      `a forged Host cannot grow the cache without limit`,
      `recency is refreshed on a hit, so a hot address is not evicted`.
      Мутации: снятие границы валит второй тест, снятие обновления давности —
      третий.
- [x] `packages/core/tests/socket-io.test.ts` —
      `Socket.IO CORS > omitting cors emits no allow-list at all — same-origin only`
      и `> a supplied origin is still allowed, with credentials defaulted on`.
      Проверяется реальный polling-хендшейк через `createServer`, а не поле
      конфигурации. Мутация (`config.cors ?? { origin: '*' }`) валит первый.

### Гейт

- [x] `bun run verify` — exit 0. Обе packed-полосы шаблона (blank и repository,
      все браузеры) зелёные, 42 e2e-теста, `runtime:smoke` включая
      `assertPublicWebSurface`.
