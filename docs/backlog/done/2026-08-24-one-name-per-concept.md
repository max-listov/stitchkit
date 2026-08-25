---
title: "One concept keeps one name across the public surface"
description: "Убрать голый алиас AgentModelDeclaration, объяснить два оставшихся двойных имени и зафиксировать, почему они законны."
type: task
status: done
created: 2026-08-24
updated: 2026-08-24
completed: 2026-08-24 14:08 +0000
related:
  - docs/backlog/done/2026-08-24-one-shutdown-vocabulary.md
  - docs/backlog/done/2026-08-24-public-surface-is-usable-from-outside.md
---

# One concept keeps one name across the public surface

## Зачем

Правка публичной поверхности в соседней задаче завела ровно тот дефект, который
эта серия вычищала: чтобы удовлетворить гейт `check-public-types`, тип получил
экспортируемое имя `ApplicationResourcePhase`, а прежнее `ResourceFailure`
осталось алиасом — лишь бы не править четыре внутренних использования. Одно
понятие под двумя именами в одном файле.

Это тот же класс, что и `drainTimeoutMs` против `gracePeriodMs`. Общий вывод:
когда гейт требует переименования, переименовывать надо до конца — мост «чтобы
не трогать остальное» и есть способ завести второе имя.

Проверка остальной кодовой базы на тот же паттерн дала ещё два двойных имени, и
они оказались разной природы.

## Результат

- Ни одно понятие фреймворка не экспортируется под двумя именами.
- Двойные имена, которые остаются, остаются осознанно и объяснены на месте
  объявления, а не выглядят как недосмотр.

## Что сделано

- [x] `packages/core/src/application/kernel.ts`: алиас `ResourceFailure` удалён,
      все четыре использования переведены на `ApplicationResourcePhase`.
- [x] `packages/core/src/agent-runtime/models.ts`: удалён
      `AgentModelDeclaration` — голый алиас `AgentModelDescriptor`. Оба имени
      были экспортированы, из-за чего ограничение реестра называлось
      `AgentModelDeclaration`, а `registry.descriptor()` возвращал
      `AgentModelDescriptor`. Оставлено имя, парное схеме
      `AgentModelDescriptorSchema`.
- [x] Убрано из бареля `agent-runtime`, из `docs/api/reference.md` и из
      снапшота публичной поверхности.
- [x] `CHANGELOG.md` несёт `### ⚠️ Breaking changes` с before → after; написан
      раздел `## Unreleased migration: one name per concept`.
- [x] Регрессия: не требуется — удаление экспортируемого имени проверяется
      снапшотом публичной поверхности и typecheck'ом, которые входят в гейт.

## Что осмотрено и намеренно не тронуто

- [x] `SocketEventMap = EventsMap` (`browser/socket-io.ts`) — `EventsMap`
      принадлежит `@socket.io/component-emitter`. Алиас не даёт имени вендора
      протечь в наши сигнатуры; разные владельцы — два имени законны.
- [x] `AgentRun.ownerId` и `AgentRuntimeEvent.runtimeEpoch` — одно значение,
      генерируемое раз на `createAgentRuntime()`, но в двух ролях: на прогоне
      оно отвечает «кто владеет», на событии «какой рантайм это выпустил».
      Первоначально я счёл это тем же дефектом и ошибся: переименование
      ухудшило бы главное место — сравнение fencing
      `run.ownerId !== runtimeEpoch` читается как «владелец прогона — не этот
      рантайм», а `currentRun.runtimeEpoch !== runtimeEpoch` не читается никак.
      Вместо переименования связь описана в обоих объявлениях —
      `agent-runtime/schemas.ts` и `agent-runtime/events.ts`.
- [x] Имена диагностических колбэков (`onError`, `onSnapshot`, `onSinkError`,
      `onDrop`, `onResourceFailure`, `onCollectionError`) — не синонимы:
      отказ операции, снимок состояния, отказ синка, отброс по ёмкости, отказ
      фазы ресурса и отказ сбора метрик суть разные события.
