---
title: "Async operation: contract-backed привязка держится на ссылочном равенстве Zod"
description: bindContractAsyncOperation валидирует связь capability сравнением идентичности схем, хотя план требовал type-level проверку; структурно верная привязка падает в рантайме.
type: task
status: done
created: 2026-08-20
updated: 2026-08-20
completed: 2026-08-20 15:17 +00:00
related: docs/backlog/done/2026-08-20-async-operation-protocol.md
---

# Contract-backed binding: типы вместо identity-сравнения

## Зачем

`bindContractAsyncOperation` (`packages/core/src/tools/async-operation.ts`)
проверяет связность capability так:

```ts
if (status.input !== start.output || wait.input !== start.output) throw …
if (wait.output !== status.output) throw …
```

Это сравнение **ссылок на объекты Zod**. План закрытой таски явно требовал
обратного и стоит `[x]`: «Missing/wrong method/schema/capability должен падать
по типам; runtime comparison двух Zod object identities не является source of
truth». Фактически тип `capabilities` — это `keyof TEndpoints & string`, то
есть любой существующий ключ контракта компилируется, а диагностика приходит
только в рантайме.

Практическая ловушка: контракт, где `start.output` и `status.input` объявлены
двумя структурно одинаковыми инлайновыми `z.object({ id: z.string() })`,
семантически корректен, но падает — и текст ошибки не подсказывает, что схему
надо вынести в общую константу.

## Результат

- Неверная привязка capability не компилируется: тип требует, чтобы
  `status/wait/cancel/result/artifacts` указывали на endpoint, чей `input`
  совпадает со `start.output` (и `wait.output` со `status.output`).
- Рантайм-проверка остаётся как defence-in-depth для нетипизированных
  вызовов, но её сообщение объясняет требование общей схемы.
- Type-level проверка сравнивает `z.input` и `z.output`, а runtime identity
  остаётся отдельной defence-in-depth границей для нетипизированных вызовов.

## План

- [x] Ограничить literal-ключи capability по совпадению входного и выходного
      типов Zod (`z.input` и `z.output`), чтобы разные, но структурно
      эквивалентные schema instances компилировались, а несовместимые — нет.
- [x] Прототип типа: ключи capability ограничены теми, у кого
      `TEndpoints[K]['input']` совпадает со `TEndpoints[TStart]['output']`
      (проверить, тянет ли вывод literal-ключей через `ContractDef`).
- [x] Сузить `ContractAsyncOperationConfig` и добавить
      type-test: неверный ключ → ошибка компиляции, верный компилируется.
- [x] Runtime identity-check оставить defence-in-depth для нетипизированных
      вызовов: сообщения ошибок называют конкретную capability и
      требование «reuse the same schema instance».
- [x] Runtime-тест на структурно одинаковые, но разные инстансы схем —
      фиксирует выбранное поведение осознанно.

## Acceptance

- [x] Type-level structural compatibility и runtime identity defence закрыты
      раздельными тестами и отражены в ADR/guide.
- [x] Сообщение ошибки достаточно, чтобы починить привязку без чтения исходников.
- [x] `bun run verify` зелёный.

## Что сделано

- [x] Core: `packages/core/src/tools/async-operation.ts` выводит допустимые
      start/follow/wait keys из schema-compatible `z.input`/`z.output` типов и
      сохраняет capability-specific runtime identity diagnostics.
- [x] Public surface: новые inference-типы экспортированы из
      `packages/core/src/tools.ts`, описаны в `docs/api/reference.md` и запинены
      в `packages/core/tests/fixtures/public-surface.json`.
- [x] Docs: type/runtime граница зафиксирована в
      `docs/decisions/0089-async-operations-describe-transport-not-jobs.md` и
      `docs/guide/mcp-and-agents.md` с compilable shared-schema примером.
- [x] Регрессия: packages/core/tests/async-operation.type-test.ts::follow-up input does not match the start output; packages/core/tests/async-operation.type-test.ts::wait output does not match the status snapshot; packages/core/tests/async-operation.test.ts::contract-backed runtime defence names the capability and shared schema requirement
