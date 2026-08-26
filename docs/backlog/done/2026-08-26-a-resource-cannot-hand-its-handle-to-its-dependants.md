---
title: A resource cannot hand its handle to its dependants
description: The graph orders resources but carries no values between them, so every dependency that is a real object — a connection, a socket server, a client — is threaded through a mutable module-local with a null guard that can never fire.
type: task
status: done
created: 2026-08-26
updated: 2026-08-26
completed: 2026-08-26 10:57 +00:00
---

## Зачем

`dependsOn` выражает **очерёдность**, но не **передачу**. `start` возвращает
`ManagedResourceStartResult` — то есть `ready` и `completion`, оба `Promise<void>`.
Значения там нет, и `ManagedResourceContext` тоже не даёт доступа к соседям:

```ts
interface ManagedResourceContext {
  applicationId: string
  signal: AbortSignal
  deadlineAt?: number
  forceDeadlineAt?: number
  now(): number
  reportHealth(health): void
}
```

Между тем зависимость почти всегда не только временна́я, но и предметная: HTTP-серверу
нужен объект Socket.IO, воркеру — клиент базы, публикатору — транспорт. Ядро гарантирует,
что сосед уже готов, но забрать у него результат нечем.

## Что получается у потребителя

Единственный доступный способ — изменяемая переменная в замыкании и страж, который
по построению графа сработать не может:

```ts
let socket: SocketHandle | null = null

const socketIo = defineManagedResource({
  id: 'socket-io',
  start: async () => { socket = await createSocketServer(config) },
})

const http = defineManagedResource({
  id: 'http',
  dependsOn: ['socket-io'],
  start: () => {
    if (!socket) throw new Error('socket is not initialized')  // недостижимо
    server = createServer({ socket })
  },
})
```

Цена:

- **тип теряется**: `SocketHandle | null` вместо `SocketHandle`, и `null` приходится
  разбирать в каждой точке использования;
- **страж — шум**: он существует только чтобы успокоить компилятор, и читатель тратит
  время на выяснение, когда он может сработать (никогда, если граф корректен);
- **инвариант уезжает из графа в голову**: связь «http получает сокет от socket-io»
  объявлена в `dependsOn` лишь наполовину, вторая половина — в порядке присваивания
  переменной, который ничем не проверяется;
- **это пишет каждый**. Приложение из одного ресурса без зависимостей — редкость,
  а как только ресурсов больше двух, шаблон появляется обязательно.

Показательно, что все рецепты в `application-migration-recipes.md` обходят это
стороной: `database`, `poller`, `queue consumer` и `publisher` замкнуты на
собственные модульные синглтоны и ничего друг другу не передают. Как только ресурсы
начинают обмениваться объектами — а это норма, а не экзотика, — рецепта нет.

## Результат

Один из двух путей, на выбор владельца:

1. **`start` публикует значение.** `ManagedResourceStartResult` получает поле
   (например `value`), а зависимые читают его типизированно —
   `context.dependency('socket-io')` или аргументом в `start`.
2. **Явный отказ, записанный в документации.** Если ядро принципиально не переносит
   значения, это надо сказать прямо и назвать шаблон с замыканием рекомендованным —
   вместе с тем, как в нём не терять тип. Сейчас документация о нём молчит, и каждый
   потребитель изобретает его заново, считая костылём.

Второй путь дешевле и тоже закрывает задачу: проблема не столько в отсутствии
механизма, сколько в том, что его отсутствие нигде не названо.

## План

Выбран путь 1 — `start` публикует значение, зависимые читают его типизированно.
Путь 2 (задокументировать отказ) отклонён: шаблон с `let x: T | null` теряет тип и
уносит половину инварианта из графа в порядок присваиваний.

- [x] `ManagedResourceStartResult` получает `value?: unknown`.
- [x] `ManagedResourceContext` получает `use(resource)`, возвращающий опубликованное
      значение с точным типом. Тип извлекается условным типом из возвращаемого типа
      `start`, а не выводом из параметра: вывод из контекста присваивания делает
      `use` несостоятельным (проверено пробником — `T` подхватывается из ожидаемого типа).
- [x] Ресурс, ничего не опубликовавший, даёт брендированный тип-отказ, а не `never`:
      `never` присваивается чему угодно и молчит.
- [x] `dependsOn` принимает `string | ManagedResource` — иначе связь «http берёт сокет у
      socket-io» остаётся объявленной наполовину.
- [x] Рантайм-правила `use`: отказ на нехватку объявления в `dependsOn`, отказ на ресурс
      без значения, отказ на неизвестный ресурс. Сообщения называют оба id.
- [x] ADR о решении + строка в `docs/decisions/README.md`.
- [x] Рецепт «ресурс передаёт handle зависимым» в `application-migration-recipes.md`.

## Acceptance

- [x] Тест: `database` публикует соединение, `http` читает его через `use` и получает
      точный тип; значение — то же самое, что вернул `start`.
- [x] Тест: `use` на ресурс, которого нет в `dependsOn`, падает с сообщением, называющим
      оба id.
- [x] Тест: `use` на ресурс без опубликованного значения падает.
- [x] Тест типов: чтение значения у ресурса, который ничего не публикует, не компилируется.
- [x] Тест: `dependsOn` со ссылкой на объект ресурса даёт тот же порядок, что и со строкой.

## Что сделано

### Core

- [x] `ManagedResourceStartResult.value?: unknown` — `packages/core/src/application/resource.ts`.
- [x] `ManagedResourceContext.use(resource)` возвращает опубликованное значение с точным
      типом; тип извлекается условным типом `ManagedResourcePublished<TResource>` из
      возвращаемого типа `start`.
- [x] Ресурс без значения даёт `ManagedResourcePublishesNoValue` — брендированный интерфейс,
      а не `never`: `never` присваивается чему угодно и молчал бы.
- [x] `dependsOn` принимает `string | ManagedResource`; `managedResourceDependencyId`
      экспортирован для тех, кто читает `dependsOn`.
- [x] Рантайм-правила `use`: отказ на нехватку объявления, отказ на ресурс без значения,
      оба сообщения называют оба id — `packages/core/src/application/kernel.ts`.
- [x] Значение живёт всю жизнь приложения: читается из `activate` и из фаз остановки.

### Docs

- [x] ADR 0114 + строка в `docs/decisions/README.md`.
- [x] Рецепт «Handing a handle to the resources that depend on it» + раздел в
      `docs/guide/application-kernel.md`; исполняемый источник в consumer-lane фикстуре.
- [x] `docs/api/reference.md`, `packages/core/tests/fixtures/public-surface.json`.
- [x] `CHANGELOG.md` 0.67.0 (breaking: расширение `dependsOn`) + migration.
- [x] Строка зрелости `stitchkit/application` в `docs/guide/getting-started.md` получила
      собственную частоту переопределений, как у agent-runtime, и закреплена гейтом
      `scripts/surface-cadence.test.ts`.

### Tests

- [x] `packages/core/tests/application-resource-values.test.ts` — 7 тестов: чтение того же
      объекта с точным типом; отказ на необъявленную зависимость; отказ на ресурс без
      значения (плюс `@ts-expect-error` — не компилируется); значение читается из
      `activate` и `close`; `dependsOn` по ссылке даёт тот же порядок; отсутствующая
      зависимость по ссылке ловится до сайд-эффектов; `value: undefined` — это отсутствие
      значения.
- [x] Фальсификация: снятие публикации → 4 красных; снятие проверки объявления → 1 красный.

### Что не сделано

- [x] Путь 2 (задокументировать отказ и назвать шаблон с замыканием рекомендованным) не
      выбран: он оставлял потерю типа и половину инварианта вне графа.
