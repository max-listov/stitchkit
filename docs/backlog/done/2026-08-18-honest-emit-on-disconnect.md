---
title: "Честный emit при обрыве: наблюдаемый drop вместо молчаливого no-op"
description: Клиентский emit при disconnected сегодня — документированный silent no-op; вызывающий ждёт полный дедлайн ответа на сообщение, которое не уходило. Сделать потерю наблюдаемой.
type: task
status: done
created: 2026-08-18
updated: 2026-08-18
completed: 2026-08-18 17:10 +07:00
---

# Честный emit при обрыве

## Зачем

`createSocketIOClient().emit` — «No-op while disconnected» прямо в типах
(`browser/socket-io.ts:179`, реализация `:410`). Сам no-op осознан (мы
отказались от Socket.IO-буферизации, чтобы reconnect-переподписка была
детерминированной), но потеря **ненаблюдаема**: consuming project ловил бы
вызовы «вникуда», если бы не проверял `connected` руками перед каждым emit.
Дефолт можно не менять — но потерю обязан видеть код, а не только автор,
прочитавший doc-комментарий.

## Результат

- `emit(...)` возвращает `boolean` — ушло в сокет или отброшено (для текущих
  вызывающих изменение невидимо: `void`-контекст).
- Опциональный хук клиента `onDroppedEmit?: (event, args) => void` — одна
  центральная точка для телеметрии/ассерта вместо `if (connected)` у каждого
  вызова.
- Док-комментарий и realtime guide описывают семантику и рецепт «жёсткого»
  варианта (`if (!client.emit(...)) throw`).

## Уточнения после план-валидации (2 валидатора, tsc-пробы)

- **Классификация — breaking.** `void → boolean` совместим для всех
  call sites (проверено: в репо и потребителях ни один emit не в
  expression-позиции), но НЕ совместим для имплементеров интерфейсов
  (void-функция не присваивается boolean-сигнатуре — tsc-проба). По AGENTS.md
  («changed signature or return shape») — `### ⚠️ Breaking changes` в
  CHANGELOG + minor 0.53.0, сниппет для моков «верни boolean».
- **Единый контракт возврата**: `ValidatedRealtimeSocket.emit` возвращает
  boolean со значением «принято транспортом» (не «доставлено»); реализация
  validated-обёртки возвращает `emitTarget(...) !== false`; серверные цели
  (Server/Socket/BroadcastOperator — socket.io возвращает true; duck-typed
  фейки → true) всегда true, пустая комната — не drop (документируется);
  только браузерный транспорт сообщает false. Транспортный emit сам вычисляет
  true/false (socket.io-client возвращает this, не boolean — не форвардить).
- **Три исхода, по порядку** (в док-комментарий и гайд): (1) нарушение
  контракта → **throw** синхронно (валидация идёт до guard'а — так и сегодня,
  onRejected на outbound НЕ вызывается, это подтверждено кодом); (2)
  disconnected → `false` + `onDroppedEmit`; (3) иначе → `true`.
- **Четыре окна дропа**, все покрыть тестами: socket === null (никогда не
  коннектились / после disconnect()); reconnect-окно; `reconnect_failed`;
  **lazy-load окно** — `connect()` вызван, peer ещё грузится, socket null —
  синхронный `connect(); emit()` даёт false.
- `onDroppedEmit` — на `SocketIOClientConfig` со структурным payload
  `(dropped: { event: string; args: unknown[] })`, инлайн-тип (без нового
  экспорта → public-surface.json не меняется); в `RealtimeClientOptions`
  приезжает наследованием — НЕ дедеструктурировать в `createRealtimeClient`.
  Хук видит wire-аргументы (после Zod-parse, с обёрнутым ack в хвосте) —
  оговорить в доке.
- Обновить оба doc-комментария («No-op while disconnected» и комментарий в
  `connect()`), существующий тест «silent no-op» переписать на `false` + хук;
  type-test — inline `@ts-expect-error` (void-мок больше не присваивается).
- В гайде секции про drop сегодня нет вообще — добавить (не править),
  плюс рецепт `if (!client.emit(...)) throw` и кросс-ссылка из durability.

## План

- [x] `ValidatedRealtimeSocket.emit` / клиентский `emit`: возврат `boolean`
      (true = передан в socket.io, что не гарантирует доставку — так и
      написать; false = отброшен из-за disconnected). Проверить, что смена
      `void → boolean` не ломает ни одного существующего вызова (совместимо для
      всех caller'ов; type-test).
- [x] `onDroppedEmit` в конфиге `createSocketIOClient`; вызывается синхронно на
      каждый отброшенный emit с именем события и аргументами.
- [x] Симметрия сервера: серверный validated emit не имеет состояния
      «disconnected» того же рода (broadcast в пустую комнату — не потеря);
      явно зафиксировать в доке, что хук — клиентская история, и почему.
- [x] Тесты: возврат false + вызов хука при disconnected, true при connected,
      отсутствие хука ничего не ломает; реконнект-окно (emit между disconnect
      и reconnect) отброшен и виден.
- [x] Docs: realtime guide (раздел про потери и паттерн retain для state),
      api reference, CHANGELOG.

## Acceptance

- [x] Тест: emit при обрыве возвращает false и дёргает `onDroppedEmit`; тот же
      вызов после reconnect возвращает true.
- [x] Ни одного изменения в существующих потребительских вызовах не требуется.
- [x] `bun run verify` зелёный.

## Что сделано

- Core:
  - [x] `packages/core/src/realtime/socket.ts` — `ValidatedRealtimeSocket.emit: boolean` («принято транспортом»); реализация `emitTarget(...) !== false` (socket.io server-цели всегда true — проверено по исходникам 4.8.3; duck-typed фейки → true)
  - [x] `packages/core/src/browser/socket-io.ts` — транспортный `emit` возвращает true/false, `onDroppedEmit({ event, args })` на `SocketIOClientConfig` (инлайн-тип, без нового экспорта; наследуется в `RealtimeClientOptions`); оба doc-комментария переписаны
- Тесты (`packages/core/tests/socket-io.test.ts`):
  - [x] `emit while disconnected drops observably — false plus the onDroppedEmit hook`
  - [x] `emit in the lazy-load window right after connect() drops observably`
  - [x] `the validated realtime client reports drops and acceptance the same way`
  - [x] `the reconnect window after a server kick drops observably until the recycle lands` (non-null-но-disconnected половина guard'а)
  - [x] `emits validated events through server and connection room targets` — ассерты `toBe(true)` включая пустую комнату
  - [x] `a void-returning mock no longer satisfies the client emit signature` (@ts-expect-error, проверен tsc)
- Docs: `docs/guide/realtime.md` «Honest emit» (три исхода по порядку), `docs/guide/upgrading.md` 0.53.0, CHANGELOG `### ⚠️ Breaking changes` (breaking для имплементеров интерфейсов), reference.md
- Не сделано (осознанно):
  - [x] Отдельный тест `reconnect_failed`-окна — покрывается тем же guard'ом, что и kick-окно (socket non-null, disconnected); зафиксировано здесь вместо теста
