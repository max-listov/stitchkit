---
title: "Typed composition of multiple auth domains"
description: Композировать несколько createAuthHook с routing по owned scopes и выводом общего handler context без ручных intersections.
type: task
status: done
created: 2026-08-21
updated: 2026-08-21
completed: 2026-08-21
related: docs/decisions/0094-auth-hook-composition-is-owned-and-atomic.md
---

# Typed composition нескольких auth domains

## Зачем

`createAuthHook` теперь выводит async rule contributions, но приложение с
несколькими независимыми identity domains всё ещё вручную dispatch'ит hooks по
scope и вручную пишет `AuthScopes<A> & AuthScopes<B>`. Обычный последовательный
вызов hooks неверен: каждый одиночный hook fail-closed на чужом scope.

Framework уже владеет declared rules, fail-closed policy, ordered execution и
context contribution merge. Он должен уметь безопасно объединить эти hooks,
не объединяя доменные identities/RBAC в один framework model.

## Результат

- `composeAuthHooks(...)` принимает только scoped hooks, созданные canonical
  auth factory, и возвращает один `ScopedAuthHook` с автоматически объединённым
  `AuthScopes`.
- Runtime dispatch вызывает только hooks, объявившие выбранный scope; zero
  owners fail closed, shared scope выполняет owners в declaration order.
- Contributions owners вычисляются на isolated shadow contexts, вместе проходят
  reserved/unsafe validation и fail-closed на любом cross-owner key collision,
  затем одним commit попадают в original context. Consumer side effects и
  nested object mutations framework откатить не обещает.
- Один explicit composite `defaultScope` не зависит от порядка hooks; child
  defaults обязаны отсутствовать или совпадать.
- Одиночный `createAuthHook` не получает domain registry API и остаётся простым.

## План

- [x] Зафиксировать state/dispatch model для zero/one/many scope owners и
      default scope.
- [x] Добавить module-private `WeakMap` ownership plan и private type brand к
      canonical scoped hook без раскрытия mutable rules map.
- [x] Реализовать typed scope-map composition без consumer casts и manual
      intersection.
- [x] Вынести общий internal evaluator: каждый owner получает shadow context,
      cancellation signal проверяется между owners, все contributions
      commit'ятся один раз после общего успеха.
- [x] Покрыть disjoint scopes, shared scope/order, async contributions,
      anonymous/forbidden, unknown scope, reserved/colliding fields,
      HTTP/tool parity и cancellation.
- [x] Исправить guide example с невалидным `ScopedAuthRule<User, object>` на
      текущий `AuthRuleContribution`/inferred pattern.
- [x] Обновить exports, ADR/reference/guides/generated docs/changelog и
      compile-time tests.

## Acceptance

- [x] Consumer не пишет ручной scope dispatcher или `AuthScopes<A> & ...`.
- [x] Чужой scope не запускает resolver hook'а и неизвестный scope fail-closed.
- [x] Shared scope требует успешного прохождения всех declared owners в
      стабильном порядке.
- [x] Любой cross-owner contributed key collision — deterministic pre-commit
      error; type merge не скрывает несовместимость через `never`.
- [x] Ни один failed composed request не достигает handler с partial fields.
- [x] Type-level context совпадает с реально гарантированными runtime fields на
      HTTP, MCP, Agent и CLI tool paths.
- [x] Все guide snippets компилируются; `bun run verify` зелёный.

## Конвейер 2/2

- [x] Plan validator 1/2 — уточнены collision/default/atomic evaluation.
- [x] Plan validator 2/2 — сужена atomicity и cancellation guarantee.
- [x] Implementation validator 1/2 — PASS: nominal ownership и literal scope
      inference не требуют consumer casts.
- [x] Implementation validator 2/2 — PASS: owner routing, shadow contexts,
      collision checks и atomic commit соответствуют runtime contract.

## Что сделано

- [x] Core: `composeAuthHooks` композирует nominal `createAuthHook` domains по
      owned scopes, запускает только owners выбранного scope и атомарно
      коммитит их contributions после полного успеха.
- [x] Types/docs: общий handler context выводится из child hooks; invalid
      generic auth example заменён Zod-derived contribution contract.
- [x] Регрессии:
      `packages/core/tests/auth-hook.test.ts::dispatches only the owner of a disjoint scope on HTTP and tool contexts`;
      `packages/core/tests/auth-hook.test.ts::runs every owner of a shared scope in declaration order and commits once`;
      `packages/core/tests/auth-hook.test.ts::rejects cross-owner collisions before committing any owner fields`;
      `packages/core/tests/auth-hook.test.ts::discards staged fields when a later owner rejects`.
