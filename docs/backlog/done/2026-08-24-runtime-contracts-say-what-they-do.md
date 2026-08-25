---
title: onResourceFailure и close() перестают обещать больше, чем делают
description: Две находки аудита из прошлых итераций: не каждый сбой фазы сообщает причину, и контракт close() содержит три взаимно невыполнимых утверждения.
type: task
status: done
tags: [audit, application, agent-runtime, contracts]
related: docs/backlog/done/2026-08-24-post-audit-hardening.md
created: 2026-08-24
updated: 2026-08-24
completed: 2026-08-24 18:47 +00:00
---

# onResourceFailure и close() перестают обещать больше, чем делают

## Зачем

Обе находки пришли из того же аудита, что и hardening-раунд, обе воспроизведены,
и обе относятся не к declaration-контуру, а к agent-runtime и application из
предыдущих итераций. Держать их внутри того раунда значило бы не закрыть его
никогда.

Общее у них одно: **текст обещает механику, которой в коде нет** — тот же класс
дефекта, что и переоценённая «граница держится формой».

## Результат

### 1. `onResourceFailure` покрывает то, что заявлено

Проверено: в `packages/core/src/application/kernel.ts` восемь вызовов
`reportFailure` против четырнадцати `catch`-блоков, а changelog утверждает, что
причину сообщает **каждый** сбой фазы. Аудит называет как минимум позднее
завершение, `close` при откате, недоступную зависимость и force-путь.

Кроме того, колбэк объявлен как `(failure) => void`. TypeScript пропустит
`async`-наблюдателя, а его отклонённый промис никто не поймает: синхронный
`try/catch` вокруг вызова его не видит.

Тест с именем *every failing phase* проверяет `seen.length > 0` — это не «every».

- [x] Пройти каждый `catch` и решить по нему: сообщает или намеренно нет.
- [x] Сигнатура `void | Promise<void>` с изоляцией отклонения.
- [x] Таблица всех фаз с точной ожидаемой причиной вместо счётчика.

### 2. `close()` получает один выполнимый контракт

`docs/guide/agent-runtime.md` утверждает одновременно: «every combination is
bounded», «omit `forceTimeoutMs` and it waits for settlement» и «`close()` never
returns while a run is still in flight». Без force timeout ожидание не
ограничено; с ним возврат возможен при живом прогоне. Три утверждения не
выполняются вместе ни при какой реализации.

- [x] Выбрать один контракт и привести к нему код и текст. Предпочтительный
      вариант — structured result (`settled` / `timedOut` / `remaining`): он
      описывает то, что действительно происходит, вместо обещания, которого не
      бывает.

## Acceptance

- [x] Ни одно утверждение о `onResourceFailure` и `close()` не сильнее того, что
      делает код.
- [x] Асинхронный наблюдатель не может уронить жизненный цикл, который он
      наблюдает.
- [x] Тест на фазы перечисляет фазы, а не считает события.
- [x] `bun run verify` зелёный.

## Что сделано

### 1. `onResourceFailure`

- [x] Пройден каждый `catch` в `packages/core/src/application/kernel.ts`. Три
      пути молчали и теперь сообщают:
      **close при откате** неудавшегося старта (записывал фазу и терял причину);
      **force** у ресурса, чей `close` уже вызван и не завершился (запись
      `force-failed` вообще без причины — читается как необъяснимый сбой вместо
      таймаута); **старт, который догнал shutdown** (ошибка самого ресурса
      просто перебрасывалась).
- [x] Собственное прерывание ядра отделено типом:
      `ApplicationStartupInterruptedError`. Оно намеренно **не** сообщается —
      там ничего не падало, и отчёт о нём похоронил бы тот сбой, который был.
- [x] Сигнатура `void | Promise<void>` с изоляцией отклонения: `async`-наблюдатель
      проходил типизацию под `void`, а его отклонённый промис не видел
      синхронный `try/catch`. Ядро его не ждёт — медленный наблюдатель не
      удлиняет shutdown.
- [x] Счётчик заменён таблицей фаз —
      `packages/core/tests/application-kernel.test.ts::every failing phase
      reports the cause the phase label cannot carry`: по одному приложению на
      фазу (`start`, `ready`, `completion`, `close` при откате, `admission`,
      `drain`, `close`, `force` дважды), каждая проверяет точный ресурс, точную
      фазу и точную причину. Старый тест проходил при молчащем большинстве фаз,
      потому что shutdown **короткозамыкает**: первый сбой ставит
      `gracefulFailed`, и циклы drain и close не выполняются вовсе.

### 2. Контракт `close()`

- [x] Выбран structured result: `close()` возвращает
      `{ settled, timedOut, remaining }`
      (`packages/core/src/agent-runtime/coordinator.ts`). Три взаимно
      невыполнимых утверждения заменены таблицей комбинаций бюджетов в
      `docs/guide/agent-runtime.md`: без `forceTimeoutMs` ожидание не ограничено
      и в полёте ничего не остаётся; с ним возврат при живом прогоне — это
      ровно то, ради чего бюджет и существует.
- [x] `remaining` считается, а не выводится: на таймауте вызывающему нужно
      знать, **сколько** прогонов он оставляет, а проигранная гонка
      `Promise.all` говорит только «хотя бы один».
- [x] `packages/core/tests/agent-runtime-coordinator.test.ts::close() reports
      what it achieved` — строка на комбинацию бюджетов плюс счёт трёх живых
      прогонов.
- [x] Breaking-запись в `CHANGELOG.md` и секция
      `## Unreleased migration: close() says what it achieved` в
      `docs/guide/upgrading.md`.

### Не сделано

- [x] `bun run verify` зелёный (exit 0).
