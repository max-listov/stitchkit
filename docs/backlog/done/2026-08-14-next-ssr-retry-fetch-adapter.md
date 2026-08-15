---
title: Реальные transport retries внутри Next.js SSR
description: Сделать повторные GET/HEAD-попытки Ky независимыми от memoized rejection в Next.js, не ломая дедупликацию первой попытки и публичный API клиента.
type: task
status: done
created: 2026-08-14
updated: 2026-08-14
completed: 2026-08-15 00:44 +00:00
related: docs/backlog/done/2026-08-14-bun-network-retry-classification.md
---

# Реальные transport retries внутри Next.js SSR

## Зачем

`createHttpClient()` корректно классифицирует поддерживаемые сетевые ошибки и
назначает retry через Ky, но внутри Next.js server rendering повторная попытка
может не попасть в сеть. Ky вызывает patched `fetch` с готовым `Request`; его
`AbortSignal` находится внутри объекта. Next.js 16 отключает request
memoization только когда сигнал явно присутствует во втором аргументе
`RequestInit`. Поэтому первый rejected GET остаётся в React request cache, а Ky
получает тот же rejection на последующих попытках даже после восстановления
backend.

Это не дефект принимающего HTTP framework и не новая разновидность Bun network
error. Предыдущая задача решила классификацию ошибки; эта задача должна
гарантировать реальную повторную передачу уже разрешённого retry в SSR runtime.
Stitchkit владеет Ky transport и обязан закрыть интеграционную границу один раз,
а не вынуждать каждое Next.js-приложение копировать fetch wrapper.

## Подтверждённая механика

- [`createDedupeFetch()` в Next.js 16.3.0](https://github.com/vercel/next.js/blob/v16.3.0/packages/next/src/server/lib/dedupe-fetch.ts#L43-L96)
  считает `options.signal` явным opt-out из memoization; сигнал только внутри
  `Request` для этого недостаточен.
- [Ky 2.0.2](https://github.com/sindresorhus/ky/blob/v2.0.2/source/core/Ky.ts#L936-L975)
  передаёт готовый `Request` и отдельный набор non-Request options в выбранную
  fetch implementation.
- До этой задачи [`createHttpClient()`](../../../packages/core/src/browser/http.ts)
  не задавал transport adapter и делегировал вызов fetch Ky по умолчанию.
- Проблема проявляется только внутри patched Next.js fetch и потому не могла
  быть доказана существующим Bun/Node late-server probe.

## Результат

- Разрешённый политикой Ky retry в Next.js SSR выполняет новый сетевой запрос,
  а не получает memoized rejection первой попытки.
- Первая попытка сохраняет штатную Next.js memoization; opt-out включается
  только для фактических повторных попыток конкретного вызова.
- Поведение browser, Bun и Node клиентов остаётся эквивалентным текущему;
  публичная форма `HttpClientConfig` и generated methods не меняется.
- Временная недоступность backend во время SSR завершается успешным ответом в
  пределах retry budget либо одной точной финальной ошибкой после его исчерпания.

## Решение

`createHttpClient()` должен создавать fetch adapter отдельно для каждого
вызова Ky. Adapter считает попытки только внутри этого вызова:

1. первая попытка делегируется runtime fetch без искусственного explicit signal;
2. начиная со второй, URL и все Fetch fields актуального `Request` передаются
   runtime fetch как materialized `RequestInit`, включая `signal` и требуемый
   Node/Undici для streaming body `duplex: 'half'`;
3. Ky остаётся единственным владельцем retry policy, backoff, timeout и
   cancellation; adapter не реализует собственный retry и не распознаёт ошибки;
4. state попыток не хранится на singleton client и не пересекается между
   параллельными запросами.

Точная реализация пользуется штатной Ky `fetch` option на уровне одного request
и не импортирует Next.js в Fetch-clean browser core.

Adapter захватывает и привязывает текущий `globalThis.fetch` при создании
конкретного request, уже после установки runtime patch. Первая попытка вызывает
`runtimeFetch(request, init)` без изменений. Реальный
production probe Next 16.3.0 выявил дополнительный stage в `patch-fetch.ts`:
для `Request + init` Next переносит init внутрь нового Request и очищает второй
аргумент до вызова `createDedupeFetch`, поэтому signal-only init не работает.
Retry обязан вызвать `runtimeFetch(request.url, materializedInit)`, где
materialized init сохраняет исходный Ky init и актуальные method/headers/body/
Fetch fields/signal текущего Request. URL reconstruction относится только к
retry и необходима, чтобы signal пережил Next Request-merge boundary.

Сохранение memoization первой попытки означает, что два одинаковых concurrent
SSR-вызова могут разделить promise и native fetch по правилам Next.js. Поэтому
гарантируется независимость per-call adapter counters и собственный актуальный
signal каждой retry attempt, но не искусственная signal-isolation общей первой
memoized attempt: она потребовала бы opt-out уже с первой попытки и противоречила
бы цели задачи.

## Plan validation 2/2

- [x] Runtime validator подтвердил Ky per-call seam и потребовал сохранять `init`,
      захватывать patched fetch per call и сузить cancellation invariant первой
      memoized attempt; implementation probe уточнил неполную исходную модель
      через полный Next `patch-fetch` pipeline.
- [x] Test/public-surface validator подтвердил private API и потребовал отдельный
      deterministic Next 16.3.0 App Router smoke против локального packed HEAD,
      а также отдельные logical-fetch и origin-network counters.
- [x] Оба замечания встроены в решение и acceptance до начала implementation.

## План

- [x] Добавить отдельный reproducible Next.js 16.3.0 App Router subprocess smoke
      под Node против локального packed Stitchkit HEAD: первый fetch получает
      детерминированный connection refusal, control handshake поднимает origin
      только после rejection, а retry отвечает `200`;
      sleep-only координация, mock fetch и прямой импорт `createDedupeFetch` не
      считаются integration coverage.
- [x] Зафиксировать раздельными счётчиками logical вызовы patched fetch и реальные
      origin/network attempts: до исправления Ky повторно получает cached
      rejection и origin не видит retry, после исправления origin видит один
      post-rejection hit; два одинаковых успешных вызова одного render дают один
      origin hit.
- [x] Вынести маленький private per-call fetch adapter рядом с
      `createHttpClient()`; не добавлять public export или новое поле config.
- [x] Передавать explicit `RequestInit.signal` только после первой transport
      attempt и всегда брать актуальный сигнал из Request, созданного Ky для
      этой попытки; сохранять Ky `init`, а на retry материализовать Request fields
      в init, чтобы Next не поглотил signal до dedupe boundary.
- [x] Покрыть параллельные вызовы: per-call adapter counters не пересекаются, а
      каждая retry attempt использует signal своего текущего Request; не обещать
      isolation общей первой попытки, которую Next законно deduplicate-ит.
- [x] Повторно прогнать negative matrix существующего retry слоя: исчерпанный
      budget, `limit: 0`, POST, HTTP 401, configured 503, already-aborted,
      in-flight abort и timeout.
- [x] Добавить конкретные parity gates: расширить `http-retry.test.ts`/probe
      signal sequence, concurrent counters и opt-in HEAD; расширить Node smoke
      signal assertions; оставить public-surface fixture неизменным и пройти
      browser-clean build и `starter-head-lane`.
- [x] Обновить client guide, API reference и `[Unreleased]` changelog; описать
      Next.js SSR boundary без обещания retry для неразрешённых методов или
      статус-кодов.
- [x] Подключить Next smoke после build к обязательному gate локального packed
      `dist`, перегенерировать agent-facing docs штатным `bun run gen:llms`/build,
      прогнать `bun run verify` и отдельно `bun run starter-head-lane`.
- [x] Сохранить release purity: только `[Unreleased]` `Fixed`; не менять version,
      starter catalog target и lock на опубликованный Stitchkit, не выполнять
      release/deploy/commit. Next 16.3.0 допустим только как exact test fixture
      dependency, не runtime dependency core.

## Acceptance

- [x] Реальный Next.js 16.3.0 SSR test красный на текущей реализации и зелёный с
      adapter: первая attempt получает deterministic connection refusal, origin
      поднимается синхронным control handshake только после rejection, следующая
      реально достигает origin и возвращает `200`; fixture использует local packed HEAD.
- [x] Вторая и последующие попытки приходят в patched fetch с explicit
      `options.signal`; первая попытка не получает искусственный opt-out из
      Next.js memoization.
- [x] Retry count остаётся семантикой Ky: `limit` — число повторов после первой
      попытки; adapter не добавляет собственные вызовы.
- [x] GET/HEAD повторяются только когда это разрешено `retry.methods`; POST и
      HTTP 401 не получают новой попытки от adapter.
- [x] Already-aborted запрос выполняет `0` native fetch, in-flight abort и
      timeout не превращаются в network retry.
- [x] Два параллельных запроса имеют независимые adapter counters; retry signal
      берётся из текущего Request каждого вызова. Первая deduped attempt сохраняет
      штатную Next.js ownership-семантику.
- [x] `HttpClientConfig`, generated client methods и public-surface fixture не
      изменились; новый export отсутствует.
- [x] В browser-safe entrypoint нет импорта или типа Next.js, Bun либо Node.
- [x] Документация прямо различает network-error classification и реальную
      доставку retry через SSR-patched fetch.
- [x] Два одинаковых успешных fetch внутри одного real render сохраняют Next.js
      memoization и дают один origin hit.
- [x] Local packed Next smoke и `bun run starter-head-lane` проходят полностью;
      `bun run verify` честно доходит до target starter lane и там останавливается:
      опубликованный catalog `stitchkit@0.46.0` ещё не содержит согласованный
      breaking managed-server API. Release/catalog mutation запрещены scope этой
      задачи, поэтому source-owned gate — packed HEAD lane — является зелёным.

## Implementation validation 2/2

- [x] Runtime validator — PASS: реальный Next 16.3.0 production render доказал
      recovery retry и сохранённую memoization первой попытки.
- [x] Surface validator — PASS после добавления `duplex: 'half'`: Fetch-clean
      browser core, Bun matrix и реальный Node opt-in PUT retry согласованы.

## Что сделано

- [x] **Transport adapter:** `packages/core/src/browser/http.ts` создаёт private
      per-call adapter, сохраняет первый Request и материализует retry в URL +
      init с актуальным signal и streaming-body duplex.
- [x] **Bun regression:** `packages/core/tests/http-retry.test.ts` — тест
      `Bun HTTP retry preserves method, budget, cancellation and response semantics`
      проверяет independent counters, signals, HEAD/PUT body, budgets и negative cases.
- [x] **Next regression:** `packages/core/scripts/next-ssr-retry-smoke.mjs`
      запускает exact Next 16.3.0 production fixture против packed local HEAD и
      проверяет recovery origin attempts и один memoized origin hit.
- [x] **Node regression:** `packages/core/scripts/node-smoke.mjs` проверяет
      `Node network retry round-trip` и `Node body-method retry round-trip` на
      настоящем Node/Undici.
- [x] **Документация:** client guide, API reference, changelog и обязательный
      smoke gate синхронизированы; version/release/deploy/commit не выполнялись.

## Не входит

- Retry ответов `5xx` по умолчанию, изменение backoff или увеличение budget.
- Rolling/blue-green deployment и application-level SSR error boundaries.
- Consumer-specific session, redirect или authentication policy.
- Публичная возможность подменить fetch: задача закрывает известную
  framework-owned интеграционную границу без расширения API.
