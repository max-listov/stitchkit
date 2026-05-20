---
title: Целостность tool-поверхности — устранить тихий drift контракта
description: Дефекты tools-слоя, из-за которых MCP/agent-поверхность молча расходится с HTTP-контрактом — внешнее ревью + аудит кода + 6 саб-агентов (Opus)
type: task
status: done
created: 2026-05-20
updated: 2026-05-20
completed: 2026-05-20
---

# Целостность tool-поверхности

## Зачем

Питч stitchkit — «один контракт, поверхности не могут разойтись» (VISION,
ADR 0007). Аудит tools-слоя нашёл, что обещание **нарушается молча** в десятке
мест: HTTP-эндпоинт есть, а MCP/agent-тул либо пропадает, либо эмитит схему,
отличную от контракта, либо исполняется по другому пути, чем HTTP. Это тот самый
drift, ради устранения которого фреймворк существует, просто скрытый.

## Происхождение

v1 — внешнее ревью + аудит кода. **v2 — после 3 саб-агентов (Opus, read-only):
schema-слой, MCP-lifecycle, cross-cutting parity.** Агенты подтвердили направление,
нашли 8 новых дефектов (в т.ч. security: байпас auth на tool-поверхности),
исправили фактические ошибки v1 и проверили открытые вопросы.

## Карта tools-слоя

`collectTools` (`tools/mount.ts:44`) → `mergeSchemas(params,input)`
(`tools/schema.ts:114`, флэттенит DU + `withJsonCoercion`). MCP (`tools/mcp.ts:39`):
dry-run `z.toJSONSchema` (throw-probe, результат выбрасывается) → регистрация
через `schema.shape` (конвертит SDK). agent (`tools/agent.ts:22`): `zodSchema()`
(конвертит AI-SDK). Исполнение — `executeToolMethod` (`tools/execute.ts:29`).

## Проверенные факты (саб-агенты, против Zod 4.4.3 / MCP SDK 1.29.0)

- `z.toJSONSchema` бросает на: `bigint`, `symbol`, `undefined`, `void`, `date`,
  `nan`, `literal(undefined|bigint)`, `custom` (и `z.instanceof`), `function`,
  голый `ZodTransform`, `map`, `set`, динамический `catch`. **`z.file()` НЕ
  бросает** (ошибка v1 — убрано). `z.discriminatedUnion` НЕ бросает.
- `z.object().refine()` / `.superRefine()` / `.brand()` — **остаются
  `instanceof z.ZodObject`** в Zod 4. `.transform()` / `.pipe()` / `z.preprocess`
  → `ZodPipe`, НЕ `ZodObject`. → объём F4 уже, чем думали.
- **MCP SDK `registerTool` НЕ принимает сырой JSON Schema** — только Zod-схему
  / raw shape. Низкоуровневого пути с JSON Schema нет. Конвертацию SDK делает
  сам, лениво, в обработчике `tools/list` — через `zod/v4-mini` `toJSONSchema`,
  `io` зависит от направления (`input`/`output`). → форма F2 предопределена.
- `registerTool` НЕ бросает при регистрации — throw уходит в `tools/list`.
  Значит «stdio ловит на старте» (v1) — **неверно**: stdio тоже ловит на первом
  `tools/list`. Единственная eager-проверка — собственный probe stitchkit.

---

## Группа A — Тихий дроп с поверхности

### F1 — P0 — MCP-тул молча дропается при несовместимой схеме
`mcp.ts:53-61`: `z.toJSONSchema` бросает → `console.error + continue`, тул
исчезает. `createMcpHandler` (`mcp-handler.ts:96`) не валидирует при сборке —
`buildMcpServer` зовётся лениво на каждую сессию (`:143`). Реальный триггер —
`z.date()` в контракте. **Решение:** политика `onIncompatibleSchema:
'throw'|'skip'|'warn'`, дефолт `throw` (включая dev). Eager-валидация в
**`buildMcpServer`** (общий для HTTP и stdio), агрегировать все провалы и
бросать одним списком. Через `StitchLogger` (F8). Снимается после F2.

### F2 — P1 — Три конвертера Zod→JSON Schema + рассинхрон `io`
Probe — `z.toJSONSchema` (классический Zod, `io:'output'` по умолчанию); эмиссия
MCP — `zod/v4-mini` через SDK (`io:'input'` для input); эмиссия agent —
`zodSchema()` AI-SDK. **Probe валидирует не то, что эмитится** — на `io`-оси даже
прямой false-positive/false-negative (`z.string().transform` бросает при
`output`, проходит при `input`). **Решение:** канонический конвертер =
**конвертер, которым реально эмитит SDK** (вызывать `toJsonSchemaCompat` /
`z4mini.toJSONSchema` с теми же `target`/`io`, что SDK). Свой конвертер писать
НЕ надо — это четвёртый расходящийся путь. Probe с правильным `io` per
direction. agent — кормить `jsonSchema()` тем же результатом. **Блокер F1.**

### F4 — P1 — Не-object / не-DU вход → пустая схема тула
`mergeSchemas` (`schema.ts:120-125`): `inputShape={}` если вход не `ZodObject` и
не `ZodDiscriminatedUnion`; то же для params (`:118`). `z.union`,
`z.intersection`, `.pipe()`/`.transform()`-обёртки, `z.lazy` → тулу пустая
input-схема, args тихо отбрасываются на валидации. **Решение:** разворачивать
`ZodPipe` до внутреннего объекта **для извлечения shape, сохраняя исходную
обёрнутую схему для `.safeParse`** (иначе теряется `.refine`). `z.union`/
`z.intersection` объектов поддержать. Действительно скалярный вход — fail loud
(F1-политика). `.refine()` чинить не надо — он уже `ZodObject`.

### F10 — P2 — Multipart-эндпоинты молча выпадают из tool-поверхностей
`mount.ts:52`: `if (method.multipart) continue` — без warning, без лога. Целая
категория эндпоинтов исчезает с MCP/agent. Для `AGENT` дроп технически не нужен
(AI-SDK-тулы умеют файлы). **Решение:** минимум — задокументировать
«multipart = HTTP-only» + debug-лог; рассмотреть file-аргумент для AGENT.

### F11 — P3 — Cross-service коллизия `toToolName`
`defineContract` ловит коллизии `toolName` **внутри одного контракта**
(`define.ts:70-96`). `mountMcp`/`mountAgent` принимают `ServiceDef[]` — два
сервиса `users` и `user` с методом `get` → `get_user` дважды. `mountAgent`
**молча перезатирает** `tools[name]` (`agent.ts:32`). **Решение:** проверка
коллизий имён в `buildMcpServer` / на мульти-сервис маунте, fail loud.

---

## Группа B — Схема расходится с реальностью (рекламируется ≠ применяется)

### F12 — P1 — `withJsonCoercion` мёртв на пути исполнения
**(Находка саб-агента, v1 пропустил.)** `collectTools` строит схему через
`mergeSchemas` → `withJsonCoercion`, и **эта** схема рекламируется тулу. Но
`executeToolMethod` (`execute.ts:48-69`) валидирует через
`method.paramsSchema`/`method.inputSchema` — **сырые контрактные схемы без
coercion**. Значит coercion не срабатывает никогда: модель шлёт по
рекламированной схеме, валидируется по другой. Весь `withJsonCoercion` —
мёртвый код на исполнении. **Решение:** определить ОДНУ схему — рекламируемую
== исполняемую. Либо `executeToolMethod` валидирует мерженую/скоэрсенную схему,
либо coercion убрать. F6 бессмыслен пока F12 открыт.

### F3 — P1 — Output-схема молча теряется на не-object выходе
`mcp.ts:66-74`: `outputSchema` выживает только если `instanceof z.ZodObject`;
несовместимый object-output дропается **пустым `catch`** (`:71-72`) — хуже
`console.error`. `z.array(...)` (`list` в starter/README) → ни `outputSchema`,
ни `structuredContent`. Спека MCP требует object для `structuredContent`.
Связано с SDK-инвариантом: тул с `outputSchema`, но без `structuredContent` —
SDK **бросает**. **Решение:** оборачивать не-object output в стабильный конверт
`{ result: <value> }` только для MCP structured payload (HTTP не трогать),
генерируя object-`outputSchema`. Ключ `result`, не `items` (коллизия с
`paginatedSchema`). Стир-к-`paginatedSchema` решает самый частый кейс `list`.

### F13 — P1 — `flattenDiscriminatedUnion` — лоссивная и лишняя
**(Находка саб-агента.)** `z.toJSONSchema` нативно эмитит DU как `oneOf`.
stitchkit вместо этого флэттенит DU в один плоский объект, где все non-discr
поля становятся **optional** + prose-хинт в `.describe()` (`schema.ts:62-113`).
Последствия: теряется cross-field requiredness (рекламируемая схема врёт модели
о том, что обязательно); коллизия имён полей между вариантами — **первый
вариант молча побеждает** (`:99`); `.describe(hint)` **перезатирает авторское
описание** поля (`:108`); бросает на легитимных DU (не-строковый дискриминатор).
**Решение:** удалить `flattenDiscriminatedUnion` целиком. `mergeSchemas` для
union-входа возвращать `z.ZodType` (не `ZodObject`), мерж с params — через
`z.intersection` (→ `allOf`). Это сохраняет requiredness end-to-end.

### F14 — P2 — `extend`-merge обходит проверку конфликтов и coercion
`mount.ts:60`: `z.object({ ...extend.schema, ...baseSchema.shape })`. Проверка
конфликтов params/input (`schema.ts:127`) не видит `extend.schema`; поля
`extend` не проходят `withJsonCoercion`. При коллизии имени контрактное поле
перетирается, потом `createToolRunner` стрипает `extendKeys` — значение
контрактного поля теряется. **Решение:** включить `extend.schema` в проверку
конфликтов; fail loud на коллизии.

---

## Группа C — Tool-путь ≠ HTTP-путь (parity)

### F15 — P1 — `executeToolMethod` парсит params И input против одного flat-объекта
**(Находка саб-агента, v1 пропустил.)** HTTP: `paramsSchema` парсит только
path-params, `inputSchema` — только query/body (`server/context.ts:42,50`).
Tool: `execute.ts:50,63` — **оба** `.safeParse(rawArgs)` против всего flat-blob.
Работает только потому, что Zod игнорит лишние ключи. На `.strict()`-схеме
(нормальная поза для write-эндпоинтов) tool-путь бросает `VALIDATION_ERROR` на
**каждый** вызов, при том что HTTP с тем же контрактом работает. **Решение:**
tool-путь должен резать flat-args на params-срез и input-срез по ключам схем,
как HTTP, и парсить каждую схему своим срезом.

### F16 — P1 — Lifecycle-хуки не работают на tool-поверхности (байпас auth)
**(Находка саб-агента, security.)** HTTP: `onRequest`/`beforeHandle`/
`afterHandle`/`onError` + group-хуки (`create.ts:110-176`). Tool: только
`beforeToolCall`/`afterToolCall` (`execute.ts`), причём `afterToolCall`
observe-only (не трансформирует результат), `beforeHandle`-эквивалента нет.
Значит приложение, ставящее scope-/tenant-/auth-гейт в `beforeHandle` (канон по
ADR 0004), имеет этот гейт **полностью обойдённым на MCP/agent-поверхности**.
Реальная authorization-дыра. **Решение:** ввести tool-аналог `beforeHandle`
(может отклонить вызов) и result-трансформ; либо явно прогонять tool-вызовы
через те же lifecycle-хуки. Архитектурно — основной пункт ADR (см. ниже).

### F17 — P2 — Контекст tool-пути беднее и без reserved-key guard
HTTP `buildContext` ставит `params`/`input`/`traceId`/`ipAddress`/`userAgent`/
`file`/`source` и спредит path-params с `RESERVED_KEYS`-guard. Tool
(`execute.ts:75`, `mount.ts:97`): `{ params, input, source, ...context }` — без
guard'а. `ToolExtend.resolve`/static `context` могут перетереть `params`/
`input`/`source`. Хендлер, читающий `ctx.traceId`/`ctx.req`/`ctx.headers`/
`ctx.file`/`ctx.ipAddress`, работает на HTTP и молча получает `undefined` как
тул. **Решение:** reserved-key guard в tool-ctx; договориться, какие поля ctx
гарантированы на всех поверхностях, остальные — задокументировать как
HTTP-only.

### F5 — P1 (было P2) — Tool-путь не валидирует output против `outputSchema`
`executeToolMethod` (`execute.ts:74-78`) возвращает `data` без
`outputSchema.parse`; HTTP парсит (`create.ts:178`). Тул может вернуть данные,
не соответствующие контракту → невалидный `structuredContent` → SDK **бросает**
(инвариант из F3). Это прямое нарушение «one contract» — отсюда P1.
**Решение:** парсить output в tool-пути когда `outputSchema` есть. Нюансы:
(а) провал — **отдельный код** (`INTERNAL_SERVER_ERROR`/`OUTPUT_VALIDATION_ERROR`),
не `VALIDATION_ERROR` (это серверный фолт, не клиентский); (б) синтез
`{status:'ok'}` для `null`/`undefined` (`execute.ts:77`) обходит `outputSchema`
— решить, до или после парса; (в) парсить один раз (SDK сам ещё раз парсит).

### F18 — P3 — `expose`/`toolName` — рассогласование типа и рантайма
`HttpOnlyEndpointDef`/`ToolEndpointDef` различаются только на уровне типов;
`defineContract` в рантайме принимает `Record<string,EndpointDef>` и не
валидирует, что `expose:['HTTP']` не несёт `toolName`. **Решение:** рантайм-
проверка в `defineContract`.

### F19 — P3 — Асимметрия error-envelope HTTP vs tool
HTTP: `{ error: { code, message?, details?, hint? } }` (`errors.ts`). Tool:
`{ error: <code-string>, details?, _hint? }` (`mount.ts:107`), а `agent.ts:40`
на «своём» catch отдаёт **третью** форму. Комментарий у `ErrorEnvelope` («JSON
shape of every error response») — **ложь** для tool-поверхностей.
**Решение:** прогонять все tool-ошибки через один `formatToolError`; либо
признать различие намеренным и зафиксировать в ADR + поправить комментарий.

---

## Группа D — Гигиена

- **F6 — P3** — `withJsonCoercion` только top-level (`schema.ts:32`). Tools-only
  (не HTTP — поправка к внешнему ревью). Бессмыслен пока F12 не закрыт. Решение —
  документировать предел.
- **F7 — P3** — `mountAgent` принимает только `ServiceDef`, `mountMcp` —
  `ServiceDef|ServiceDef[]`. Выровнять.
- **F8 — P3** — `console.error` (`mcp.ts:57`) → `StitchLogger` через
  `McpServerBuildConfig`. Для stdio дефолт-логгер обязан писать в **stderr**
  (`console.log` ломает JSON-RPC).
- **F9 — P3** — гайд: `createImplement<Ctx>()` вынести в getting-started как
  канон. Отдельно: tool-путь **вообще не имеет** типизированного контекста
  (`mountMcp`/`mountAgent` context — `Record<string,unknown>`) — это код-гэп, не
  только док.
- **F20 — P3** — `desc:''` проходит typecheck, даёт неюзабельный тул. Решение —
  guard `desc.trim().length>0` в `defineContract`.
- **Гигиена-мелочи:** `setInterval` в `createMcpHandler` (`mcp-handler.ts:104`)
  без teardown-хендла; `mcp.ts:91` catch теряет `message`/`hint`; ошибка
  params/input-конфликта — bare `Error` на маунте, должна ловиться в
  `defineContract`.

---

## Предлагаемая архитектура решения

1. `tools/json-schema.ts` — тонкая обёртка над **конвертером SDK** (не свой),
   единственная точка валидации = эмиссии (F2 → F1).
2. Удалить `flattenDiscriminatedUnion`; `mergeSchemas` возвращает `z.ZodType`,
   мерж params — `z.intersection` (F13, F4).
3. Одна схема: рекламируемая == исполняемая (F12).
4. Tool-путь приводится к HTTP-пути: срез args (F15), lifecycle-хуки/auth (F16),
   reserved-keys + поля ctx (F17), парс output (F5).
5. Политика `onIncompatibleSchema` + eager-валидация в `buildMcpServer` (F1).
6. MCP-конверт для не-object output (F3); выравнивание API (F7), логгер (F8),
   проверка коллизий имён (F11).
7. Документация: F6, F9, multipart-дроп (F10).

## ADR

Новый ADR **0013** — не «один конвертер», а шире: **«tool-поверхность несёт те
же контрактные гарантии, что HTTP»**. Ни один текущий ADR этого не утверждает
(ADR 0007 говорит лишь о паритете MCP≡agent, не tool≡HTTP) — поэтому F15/F16/
F17/F5 без ADR-дома и снова разъедутся. Один конвертер — один пункт ADR.
ADR 0007 этим уточняется, не отменяется.

## Порядок работ

`F2 → F1 → F15 (срез args) → F4 → F13 → F12 → F16 (хуки/auth) → F3 → F5 →
F17 → F7/F8/F11 → F6/F9/F10/F18/F19/F20`.
Причина: fail-loud (F1) осмыслен после единого конвертера (F2); output-паритет
(F5) бессмыслен пока input-паритет (F15/F4) сломан.

## Открытые вопросы

- F16: вводить полноценный `beforeHandle` для tool-пути, или прогонять
  tool-вызовы через существующие lifecycle-хуки целиком? Второе — честнее для
  «one pipeline», но `RuntimeContext` на tool-пути неполон (F17).
- F12: исполнять по мерженой схеме (тогда coercion живёт) или по сырой (тогда
  убрать `withJsonCoercion`)?
- Конверт не-object output: `{ result }` подтверждён (не `items`).
- `onIncompatibleSchema` дефолт `throw` — подтверждён, включая dev.

## Ссылки

- `tools/mcp.ts` `mcp-handler.ts` `mcp-stdio.ts` — F1,F2,F3,F8,F11.
- `tools/schema.ts` — F2,F4,F6,F12,F13,F14.
- `tools/mount.ts` `tools/execute.ts` — F10,F14,F15,F16,F17.
- `tools/agent.ts` `tools/remote.ts` — F7,F11,F19; `implementRemote` тоже не
  валидирует remote-output против контракта.
- `server/create.ts:178` `server/context.ts` — эталон HTTP-пути для F5,F15,F17.

## Что сделано

Реализовано целиком, все 20 находок. `bun run verify` зелёный: lint (0 warnings),
typecheck, **162 теста** (+19 новых), build (JS + декларации).

### Группа A — тихий дроп с поверхности

- [x] **F1 (P0)** — `mountMcp` больше не глотает несовместимую схему через
  `console.error + continue`. Политика `onIncompatibleSchema:
  'throw'|'skip'|'warn'` (дефолт `throw`), все провалы агрегируются и кидаются
  одним списком. `createMcpHandler` валидирует статичный массив сервисов при
  конструировании (`validateMcpSchemas`) — падение на деплое, не в проде.
- [x] **F2** — новый `tools/json-schema.ts`: единая точка конвертации
  Zod→JSON Schema с правильным `io` (`input`/`output`). Probe теперь проверяет
  то же, что реально эмитится.
- [x] **F3** — не-объектный `output` оборачивается в `{ result: … }` для MCP
  `structuredContent`; `outputSchema` строится для любого эндпоинта.
- [x] **F4** — `mergeSchemas` поддерживает union / discriminated union / refined
  вход (через `z.intersection` с params). Конец «пустой схемы тула».
- [x] **F10** — multipart-эндпоинты остаются HTTP-only; задокументировано
  комментарием в `collectTools` и в гайде.
- [x] **F11** — коллизия имён тулов между сервисами кидает ошибку в
  `mountMcp` / `mountAgent` / `validateMcpSchemas`.

### Группа B — схема расходилась с реальностью

- [x] **F12** — `withJsonCoercion` удалён целиком. Рекламируемая схема ==
  схема, по которой валидируется вызов.
- [x] **F13** — `flattenDiscriminatedUnion` удалён. DU отдаётся нативным
  `oneOf` с сохранением requiredness.
- [x] **F14** — `applyExtend` проверяет конфликт extend-полей с контрактными,
  кидает ошибку.

### Группа C — tool-путь приведён к HTTP-пути

- [x] **F15** — `executeToolMethod` режет плоские args на срез params и срез
  input, парсит каждую схему своим срезом — `.strict()`-схемы работают как тул.
- [x] **F16 (security)** — `ToolLifecycle` (`beforeHandle` / `afterHandle`)
  проброшен через `mountMcp` / `mountAgent` / `buildMcpServer` /
  `createMcpHandler`. Тот же `createAuthHook`, что на HTTP, гейтит тул-вызовы.
- [x] **F17** — фреймворковые поля `params` / `input` / `source` пишутся в
  ctx последними — `context` / `ToolExtend.resolve` их не перетрут.
- [x] **F5 (P1)** — `executeToolMethod` валидирует вывод хендлера против
  `outputSchema`; несоответствие → `INTERNAL_SERVER_ERROR`.

### Группа D — гигиена

- [x] **F6** — снято: `withJsonCoercion` удалён (F12), документировать нечего.
- [x] **F7** — `mountAgent` принимает `ServiceDef | ServiceDef[]`.
- [x] **F8** — `StitchLogger` проброшен в `McpMountConfig` /
  `McpServerBuildConfig`; warn-политика логирует через него.
- [x] **F9** — гайд `mcp-and-agents.md` дополнен (lifecycle / auth,
  `onIncompatibleSchema`); `api/reference.md` — новые экспорты.
- [x] **F18** — `defineContract` кидает на `toolName` у эндпоинта без
  tool-транспорта.
- [x] **F19** — agent / mcp catch-ветки funnel'ятся через `formatToolError`;
  комментарий `ErrorEnvelope` исправлен (HTTP-only).
- [x] **F20** — `defineContract` кидает на пустой `desc`.

### Внешний API

Изменения только аддитивные: `mountAgent` принимает массив; в конфиги добавлены
опциональные `lifecycle` / `onIncompatibleSchema` / `logger`; новые экспорты
`validateMcpSchemas`, `IncompatibleSchemaPolicy`, `ToolLifecycle`,
`ToolCallHooks`, `ToolResult`. Ничего не удалено и не переименовано — старый
TypeScript-код компилируется без правок. Браузерный / клиентский слой не тронут.

### Файлы

- Новый: `tools/json-schema.ts`, `tests/tools.test.ts`.
- Переписаны: `tools/schema.ts`, `tools/execute.ts`, `tools/mount.ts`,
  `tools/mcp.ts`, `tools/agent.ts`.
- Правки: `tools/mcp-handler.ts`, `contract/define.ts`, `contract/errors.ts`,
  `tools.ts` (barrel), `CHANGELOG.md`, `docs/guide/mcp-and-agents.md`,
  `docs/api/reference.md`, `tests/utils.test.ts`, `tests/contract.test.ts`,
  `tests/execute.test.ts`.

### Что НЕ сделано (осознанно вне скоупа)

- Типизированный контекст для tool-пути (`mountMcp`/`mountAgent` context —
  по-прежнему `Record<string,unknown>`) — инвазивная generic-перестройка,
  отложено; F9 закрыт документацией.
- `implementRemote` не валидирует remote-output против контракта — отдельная
  находка, не входила в F1–F20.
- Per-session перестройка `McpServer` в `createMcpHandler` (перф) — не дефект
  целостности, вне скоупа таска.

Все три вынесены в [`inbox/2026-05-20-tools-layer-followups.md`](../inbox/2026-05-20-tools-layer-followups.md).

## Пост-аудит (3 агента, Opus, read-only)

Реализацию проверили три аудит-агента (корректность / качество кода / API-доки-
тесты). Найдено и исправлено в одном проходе:

- **F13 — регресс.** Первая реализация (удаление `flattenDiscriminatedUnion` в
  пользу нативного `oneOf`) опиралась на неверную посылку: MCP SDK не умеет
  интроспектить union — `registerTool` для не-`ZodObject` отдавал **пустую**
  схему. Исправлено: `mountMcp` / `validateMcpSchemas` отвергают не-объектный
  вход через `onIncompatibleSchema` (дефолт `throw`). Agent-поверхность union
  поддерживает по-прежнему (`zodSchema` AI-SDK конвертит корректно). Покрыто
  тестом, в т.ч. реальным in-memory MCP round-trip.
- **F17 — `source` можно было подменить** через статический `context`
  (`createToolRunner` спредил `context` после `source`). Исправлено — `source`
  пишется последним. Покрыто тестом.
- **Дедупликация** (требование senior-review): `toolResultFromError` в
  `execute.ts` (вместо трёх копий построения `ToolResult` из `AppError`);
  `prepareMcpTool` + `throwIfFailures` в `mcp.ts` (вместо дублирования цикла
  между `mountMcp` и `validateMcpSchemas`).
- **Доки:** таблица `AgentMountConfig` дополнена строкой `lifecycle`; CHANGELOG
  уточнён (union на MCP отвергается, не «advertised as oneOf»).
- **Тесты:** добавлены F13, F14 (extend-конфликт), F10 (multipart не тул),
  F16-проводка (`createToolRunner` + in-memory MCP round-trip), F3
  (structuredContent wrapped — round-trip), F17-mount. Итого 172 теста.

`bun run verify` зелёный после правок.
