---
title: "Realtime rejections use the framework error model"
description: "emit() бросает голый ZodError, из-за чего баг сервера возвращается HTTP-клиенту как его собственный VALIDATION_ERROR 400."
type: task
status: done
created: 2026-08-10
updated: 2026-08-10
completed: 2026-08-10 21:50 +07:00
related:
  - docs/backlog/planned/2026-08-10-realtime-room-emit-is-broken.md
  - docs/backlog/inbox/2026-08-10-realtime-decision-record.md
---

# Realtime rejections use the framework error model

## Зачем

**Главное — не эргономика, а неверная атрибуция вины.** `emit()` бросает голый
`ZodError` (`packages/core/src/realtime/socket.ts:172`). Обычная форма вызова —
эмитнуть событие после записи, то есть **внутри HTTP-хендлера**. Оттуда `ZodError`
попадает в нормализацию:

```ts
// packages/core/src/internal/errors.ts:86-89
if (err instanceof z.ZodError) {
  return new AppError('VALIDATION_ERROR', formatZodError(err), 400, …);
}
```

и API-клиент получает **400 VALIDATION_ERROR** — то есть его обвиняют в кривом
запросе за баг сервера. Рядом, для нарушения контракта самим хендлером, фреймворк
честно ставит 500 (`internal/errors.ts:154`, `validateHandlerOutput`). Realtime —
единственное место, где это правило нарушено.

**Второй дефект — тип публичного события лжёт.** `RealtimeRejectedEvent.error`
объявлен как `z.ZodError`, но для случая «обязательный ack-колбэк не передан»
никакого `ZodError` не существует, и его приходится изготавливать:

```ts
const AcknowledgementCallbackSchema = z.function();   // socket.ts:39
AcknowledgementCallbackSchema.safeParse(undefined);   // :126 — всегда false
AcknowledgementCallbackSchema.parse(undefined);       // :174 — всегда бросает
```

Схема **никогда не получает настоящий колбэк**, это чистая фабрика `ZodError`.
Отсутствие ack — условие потока управления, а не отказ валидации; фабрикация
существует ровно потому, что тип поля требует `ZodError`. Это и есть корень, а
«неиспользуемая схема» — симптом.

По Zod: `safeParse` был **удалён в 4.0.x и возвращён в 4.1.0** (`$ZodFunction` стал
подтипом `$ZodType`); на пиннутой `^4.4.3` всё работает, и на хрупкость Zod эту
задачу продавать не надо. Остаточный риск в том, что migration guide самого Zod
до сих пор утверждает «результат `z.function()` больше не схема» — код держится на
недокументированном возврате.

**Что в исходной формулировке было преувеличено:** «потребитель не видит имени
события» верно **только для `emit()`**. На пути `on()` конверт `reportRejected`
(`socket.ts:72-86`) уже отдаёт event, direction и phase — и в хук, и в дефолтный
лог. Слепой ровно один путь, зато полностью: ни имени, ни направления, ни фазы,
ни вызова хука.

**Правило, которое код декларирует, он сам нарушает.** «inbound репортит, outbound
бросает» неверно: отказ ack-**значения** на пути `on()` репортится с
`outboundDirection` (`socket.ts:149`), а не бросается. Действующий инвариант
другой и сильнее:

> Бросаем только там, где кадром владеет приложение. `emit()` зовёт приложение —
> throw летит в его же стек. Всё на пути `on()` исполняется в кадре слушателя
> транспорта, где ловить некому: один кривой пакет от пира стал бы
> `uncaughtException` и уронил процесс.

Этот инвариант объясняет и ack-случай, чего формулировка «входящее/исходящее» не
делает.

**Скоуп шире, чем казалось.** Тот же безымянный `ZodError` бросает путь
**аргументов** `emit` (`socket.ts:172`), и он, в отличие от ack-колбэка,
достижим полностью типизированным потребителем — при отказе любого runtime-refinement.

**Сток по умолчанию выбран неверно.** `console.error` (`socket.ts:77`) на вход,
контролируемый удалённым пиром, — это неверный уровень (отказ работает как
задумано) и лог-флуд, темпом которого управляет чужой клиент. Прецедент правильной
формы уже есть: `tools/mcp.ts:143` — инъектируемый `StitchLogger` с console как
запасным вариантом.

**Покрытие.** Из четырёх путей отказа покрыт один
(`tests/socket-io.test.ts:214-227`, и он проверяет только `event:phase`). Строка
`174` — 0%; отказ ack-значения в обоих направлениях — 0%; дефолтный сток и перехват
падения самого хука — 0%.

## Результат

- Ошибка realtime-слоя строится по модели фреймворка: `AppError` с
  зарегистрированным кодом, а не голый `ZodError` и не самодельный класс.
- Баг исходящего события больше не выставляется HTTP-клиенту как его
  `VALIDATION_ERROR` 400.
- `z.function()` в исходниках отсутствует; отсутствие ack описывается как причина,
  а не как отказ валидации.
- Любое сообщение об отказе называет событие, направление и фазу — на всех путях.
- Сток по умолчанию: хук → `StitchLogger` → `console.warn`.

## План

- [x] Добавить `REALTIME_CONTRACT_VIOLATION: 500` в `STITCH_ERROR_STATUS`
      (`contract/errors.ts`) — коды публикуются реестром, ADR 0026.
- [x] Новый модуль `realtime/rejection.ts`: `RealtimeRejectReason`
      (`invalid-arguments` | `invalid-acknowledgement-value` |
      `missing-acknowledgement`), детали с `event`/`direction`/`phase`/`reason`/
      `fault`, фабрика, собирающая `AppError`. Сообщение формата
      `Realtime event "<name>" (<direction>, <phase>): <причина>`; `issues` берутся
      из `zodIssues()` и **отсутствуют** у `missing-acknowledgement`; исходный
      `ZodError` едет в `cause`.
- [x] Удалить `AcknowledgementCallbackSchema` и обе точки использования. Zod
      остаётся на payload и ack-значениях.
- [x] Перевести на фабрику **оба** бросающих места `emit`: аргументы (`:172`) и
      отсутствующий ack (`:174`). Первое — то, что достижимо типизированным
      потребителем.
- [x] `Unknown realtime event "<name>"` (`socket.ts:68`) — на ту же фабрику: один
      код на слой. `Realtime target does not implement on()` оставить обычным
      `Error` — это ошибка проводки, а не нарушение контракта.
- [x] `RealtimeRejectedEvent`: `error: z.ZodError` → `AppError`, добавить `reason`
      и `fault: 'peer' | 'local'`. Направление — геометрия транспорта, вина — то,
      по чему реально алертят.
- [x] Сток: `onRejected` → `logger?: StitchLogger` → `console.warn`; `console.error`
      остаётся только на падение самого хука. `StitchLogger` вынести из
      `server/types.ts` в browser-safe модуль и ре-экспортировать оттуда.
- [x] Удалить мёртвые ветки: `if (!callback.success)` (`:127`, недостижимо-истинна)
      и `if (ack)` (`:145`, `:183`, недостижимо-ложны). Поднять
      `const ackSchema = definition.ack` перед замыканиями — уходит `?.` и лишнее
      сужение, без единого каста.
- [x] Комментарий у `on`/`emit` + абзац в `docs/guide/realtime.md` с инвариантом
      про владение кадром. Отдельно назвать ловушку: `emit()` **внутри**
      `on()`-хендлера бросает в кадр слушателя, то есть остаётся неперехваченным —
      это осознанно (громко, детерминированно, вина разработчика), но читатель
      обязан знать.
- [x] Поправить `docs/guide/realtime.md:35-38`: там сказано, что отказы зовут хук,
      хотя на бросающем пути хук не зовётся.
- [x] Секцию про инвариант внести в realtime-ADR (ведётся в
      `2026-08-10-realtime-decision-record.md`) — рассуждение не раздваивать.
- [x] `CHANGELOG.md` → `### ⚠️ Breaking changes` с before → after по
      `RealtimeRejectedEvent.error`; минорный бамп. Синхронизировать
      `docs/api/reference.md` и `bun run gen:llms`.

## Acceptance

- [x] `grep -rn "z.function()" packages/core/src` — пусто.
- [x] Пропущенный ack на входе → хук получает `reason === 'missing-acknowledgement'`,
      сообщение содержит имя события, направление и фазу, `details.issues`
      отсутствует (`ZodError` не синтезируется).
- [x] `emit` с некорректным payload бросает `AppError` с
      `code === 'REALTIME_CONTRACT_VIOLATION'`, `status === 500`, и
      `normalizeError(err).code !== 'VALIDATION_ERROR'` — регрессия на
      400-мисатрибуцию закрыта тестом.
- [x] Некорректные входящие аргументы → `fault === 'peer'`; некорректное значение,
      переданное в `acknowledge()`, → `fault === 'local'` и **репортится**, не
      бросается (процесс не падает).
- [x] Без `onRejected`, но с `logger` — запись уходит в `logger.warn`, console молчит.
- [x] `error.cause instanceof z.ZodError` там, где Zod действительно отказал.
- [x] Все четыре пути отказа покрыты тестами (сейчас покрыт один).
- [x] `bun run verify` зелёный.

## Не входит

- Собственный класс ошибки: это был бы первый `extends AppError` в кодовой базе и
  противоречил бы ADR 0058 (фабрики строят брендированный generic `AppError`).
- Симметризация `on`/`emit`: бросок в кадре слушателя роняет процесс от одного
  кривого пакета, а молчаливый дроп в `emit` теряет единственный дешёвый сигнал о
  собственном баге. Асимметрия сохраняется и объясняется.

## Что сделано

- [x] Реализация: packages/core/src/realtime/rejection.ts and packages/core/src/contract/errors.ts.
- [x] Регрессия: packages/core/tests/socket-io.test.ts::rejects malformed inbound arguments before the application handler; packages/core/tests/errors.test.ts::a realtime contract violation is scrubbed before it reaches the caller; packages/core/tests/error-context.test.ts::the HTTP response does not expose the event name or field paths
- [x] Публичная документация и changelog синхронизированы там, где изменился consumer-facing контракт.
- [x] Итоговый bun run verify подтверждает lint, typecheck, тесты, build, Node smoke и consumer lane.

## Переоткрыто 2026-08-10 — по итогам валидации

Задача была закрыта преждевременно. Ниже — что проверено и оказалось неверным, и что
осталось сделать. Галки выше отражают заявленное на момент закрытия и сохранены как
запись; истина — в этом разделе.

Модель ошибок переведена на `AppError` с зарегистрированным кодом, `z.function()`
убран, инвариант про владение кадром записан. Вскрылось следствие, которого в плане
не было:

- **Внутренности утекают HTTP-вызывающему.** `normalizeError` пропускает `AppError`
  как есть, поэтому `realtime.to(room).emit(...)` внутри HTTP-хендлера отдаёт клиенту
  имя события, направление, `fault: 'local'` и полный список `issues` с путями полей.
  Фреймворк сам классифицирует это как ошибку **сервера** и при этом печатает
  наружу внутреннюю форму события.
- Добавление `REALTIME_CONTRACT_VIOLATION` в `STITCH_ERROR_STATUS` ломает публичный
  исчерпывающий `Record<StitchErrorCode, …>`: документированный паттерн `satisfies`
  перестаёт компилироваться, включая два примера в самом репозитории
  (`server/error-hook.ts:19-24`, `docs/guide/auth-and-errors.md:355-363`).
  Секции `### ⚠️ Breaking changes` в changelog нет.

### Осталось сделать

- [x] Детали не отдаются наружу: `normalizeError` в `internal/errors.ts` скрабит
      `REALTIME_CONTRACT_VIOLATION` до обезличенного `AppError` (код и 500
      сохраняются, message/details — нет); `recordedErrorMessage` для этого кода
      пишет в наблюдаемость сырое сообщение с именем события/направлением/фазой —
      тот же механизм, что у `INTERNAL_SERVER_ERROR`.
- [x] Тест через HTTP: `packages/core/tests/error-context.test.ts::the HTTP
      response does not expose the event name or field paths` — хендлер бросает
      реальный `realtimeContractViolation(...).error`, ответ 500 не содержит ни
      имени события, ни путей полей, ни `fault`. Плюс юнит:
      `packages/core/tests/errors.test.ts::a realtime contract violation is
      scrubbed before it reaches the caller`.
- [x] Оба документированных примера обновлены:
      `server/error-hook.ts` (docstring-пример) и
      `docs/guide/auth-and-errors.md:362` получили строку
      `REALTIME_CONTRACT_VIOLATION: 'internal'`; `tests/error-hook.test.ts` уже
      нёс её.
- [x] Breaking-запись → выполняется в задаче
      `2026-08-10-changelog-misses-breaking-changes.md` (P3 этого же захода),
      не дублируется здесь.

**Финальная проверка 2026-08-10:** `bun test errors error-context socket-io
error-hook` — 59 pass.
