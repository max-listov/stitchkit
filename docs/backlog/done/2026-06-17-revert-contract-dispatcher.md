---
title: Откатить createContractDispatcher — запросивший консьюмер его НЕ использует
description: Честный фидбек от консьюмера (заказчик local-WS lane). На внедрении выяснилось, что createContractDispatcher для нашей границы даёт +код, а не −код, и профит уже добран другими кусками 0.9.0. Рекомендуем откатить именно dispatcher (и TransportSource-open-union, если он только под него), оставив остальное.
type: task
status: done
created: 2026-06-05
updated: 2026-06-17
completed: 2026-06-17 21:48 +08:00
related:
  - docs/backlog/done/2026-06-05-local-ws-contract-lane.md
  - docs/backlog/done/2026-06-05-client-multipart-file-descriptor.md
---

# Откатить `createContractDispatcher` (запросивший консьюмер не использует)

> **Фидбек от консьюмера.** Команда **запросившего консьюмера** — мы и заказывали
> [local-WS lane](../done/2026-06-05-local-ws-contract-lane.md). 0.9.0 всё зашипал;
> спасибо. Но при реальном внедрении на нашей границе renderer↔runtime вышло иначе,
> чем ожидалось. Это честный фидбек, решение — за вами.

## Что из 0.9.0 мы РЕАЛЬНО применили (оставить)
- **`MultipartFile` / `FileDescriptor`** (E1) — ✅ в проде: mobile (React Native) грузит файл через
  типизированный клиент с `{uri,name,type}`. Ровно как просили. Оставить.
- **`createRetainedTopics`** — ✅ в проде: sticky-события в renderer-клиенте вместо самописной Map.
  Оставить.
- **`idempotent` (концепт)** — у нас он уже жил как `replay:'safe'|'never'` (та же семантика
  retry-after-reconnect); поле `idempotent` безвредно, можно оставить.

## Что НЕ зашло — `createContractDispatcher`
**Не используем и, похоже, не будем.** На нашей границе:
- Наш `rpc.ts` — это уже ровно тот executor (parse-in → run → parse-out), 39 строк, распределённая
  регистрация (`registerRpcMethod` в 4 файлах).
- Главный профит dispatcher — типизированный `{ok,code,...}` envelope — мы **добрали напрямую**
  (протащили `code` через свой WS-конверт, ~10 строк).
- Замер миграции на dispatcher (честно, по строкам): удаляется только 39-строчный реестр, но
  `runtimeRpcMethodSchemas` (210 строк) надо переписать в `defineContract` (+~120 строк:
  `method`/`path`/`desc` каждому из 41 эндпоинта, т.к. `EndpointDef` их требует), а клиент и
  ws-транспорт остаются. **Итог ≈ +90…+110 строк, не −код.** Профит — только «единая модель», при
  уже добранном envelope.

То есть для **единственного консьюмера, который это заказывал**, dispatcher оказался +код ради
косметики. Наш кейс (raw-WS webview↔sidecar) — ровно тот, под который его и делали, и он не зашёл.

## Рекомендация
- **Откатить `createContractDispatcher`** (и `TransportSource`-open-union, если он добавлялся только
  ради `source:'local-ws'` под dispatcher — мы его не тегаем).
- **Оставить** `MultipartFile`/`FileDescriptor`, `createRetainedTopics`, `idempotent` — они в деле/
  безвредны.
- Если есть **другой** консьюмер, которому dispatcher реально нужен (не webview↔sidecar, а IPC/
  queue-worker) — тогда не откатывать, но пометить, что у requesting-консьюмера он не прижился, и
  закрыть на реальном втором юзере, а не на нашем (отменённом) запросе.

## Почему так вышло (для ретро)
Запрос был «убей дублирование bespoke-реестра» (ГЭП2 у нас). На практике реестр у нас крошечный
(39 строк), а дублировалась не механика, а **схема-мапа**, которая в defineContract-форме только
растёт. Урок: для границы, где у консьюмера уже есть тонкий типизированный executor, dispatcher
выигрывает только типизированным envelope — а его дешевле добрать точечно. Multipart-descriptor и
retained-topics — наоборот, чистые однозначные победы.

---

## Что сделано (релиз 0.10.0)

Откатили **хирургически** — только `createContractDispatcher`; остальное из 0.9.0 оставили.
Решение как архитектора фреймворка: единственный заказчик его не использует, второго консьюмера
нет → public API с нулевой доказательной базой противоречит принципу «evidence not speculation»
(ROADMAP / ADR 0027). Capability жива внутри (`executeToolMethod`) — переэкспонируем на реальном
втором юзкейсе.

**Удалено:**
- [x] `createContractDispatcher` + типы `ContractDispatcher` / `ContractDispatcherConfig` из барреля — `packages/core/src/tools.ts`
- [x] `packages/core/src/tools/dispatch.ts` (весь файл, `git rm`)
- [x] `packages/core/tests/dispatch.test.ts` (весь файл, `git rm`)

**Оставлено (чистые победы 0.9.0, НЕ трогали):**
- [x] `MultipartFile` / `FileDescriptor` (в проде — RN-загрузка)
- [x] `createRetainedTopics` (в проде — sticky-события)
- [x] `idempotent` (безвреден, концепт в деле)
- [x] `TransportSource` open-union (1-строчное расширение типа, ноль рантайма, нужно своему транспорту через `rawRoutes`)

**Доки / решения:**
- [x] Новый ADR `docs/decisions/0028-revert-contract-dispatcher.md` (supersede диспетчер-части 0027)
- [x] `docs/decisions/README.md` — строка 0028 + статус 0027 «dispatcher portion superseded by 0028»
- [x] `docs/api/reference.md` — убраны строки `createContractDispatcher` + типы
- [x] `docs/guide/realtime.md` — секция «Bring-your-own transport» переписана (диспетчер убран, `idempotent` + retained + open `source` оставлены)
- [x] Комменты `retained.ts` / `define.ts` (диспетчер был примером) → «app's own dispatch loop»
- [x] `llms.txt` / `llms-full.txt` — регенерятся `gen:llms` в `build`

**Релиз:**
- [x] `CHANGELOG` `[0.10.0]` → секция `### ⚠️ Breaking changes` (removed + причина + before→after)
- [x] `packages/core/package.json` version → `0.10.0`
- [x] `bun run verify` зелёный

**Не делалось:**
- [x] Откат `TransportSource` open-union — отклонено: harmless/additive, нужно независимо от диспетчера
- [x] `replyToId` (доменное у консьюмера) — вне scope стича, к нам отношения не имеет
