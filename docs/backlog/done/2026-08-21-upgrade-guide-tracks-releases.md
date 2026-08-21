---
title: "upgrading.md отстал от релизов и от текущей партии"
description: Два раздела «Unreleased migration» описывают уже вышедшее в 0.55.0, а пять breaking-изменений новой партии не описаны вовсе.
type: task
status: done
created: 2026-08-21
updated: 2026-08-21
completed: 2026-08-21 02:05 +00:00
---

# Гайд апгрейда должен идти за релизами

## Зачем

`docs/guide/upgrading.md` — единственный документ, по которому потребитель
механически переезжает между версиями. Сейчас он расходится с фактами дважды:

1. Разделы **«Unreleased migration: peer-free `implementRemote`»** и
   **«Unreleased migration: managed file boundary and strict auth returns»**
   описывают изменения, которые **уже вышли в 0.55.0** — при выпуске их не
   переименовали. Читатель делает вывод, что этого ещё нет ни в одном релизе.
2. Текущая партия несёт пять breaking-изменений (manifest v2, номинальный
   `ScopedAuthHook`, safe-реестр `FILE_*`, инспекция на чтении, wire-stable ID
   для contract-backed async-операций) — в гайде нет ни одного.

Отдельно: изоляция вкладов в `composeAuthHooks` сравнивает значения по
`Object.is` поверх поверхностной копии дескрипторов, поэтому мутация вложенного
объекта на месте (`ctx.user.role = 'x'`) не будет ни распознана как вклад, ни
запрещена. Дыры нет — framework-owned ключи защищены отдельно — но предел
изоляции должен быть назван, а не подразумеваться.

## Результат

- Разделы 0.55.0 названы «Released migration: 0.55.0» одним разделом с
  подсекциями, как у 0.53.0.
- Появился раздел «Unreleased migration» для текущей партии с before → after
  по каждому breaking-изменению.
- Предел изоляции вкладов записан в ADR 0094 и в auth-гайде.

## План

- [x] Слить два «Unreleased» в один `## Released migration: 0.55.0` с `###`.
- [x] Добавить `## Unreleased migration` по пяти breaking текущей партии.
- [x] Записать предел изоляции (`Object.is` + поверхностная копия) в ADR 0094
      и в раздел композиции auth-гайда.
- [x] `bun run verify`.

## Acceptance

- [x] В `upgrading.md` нет разделов «Unreleased», описывающих выпущенное.
- [x] Каждое breaking-изменение партии имеет механический before → after.
- [x] `bun run verify` зелёный.

## Что сделано

- [x] `docs/guide/upgrading.md` — два раздела «Unreleased migration», описывавших уже вышедшее, слиты в один `## Released migration: 0.55.0` с подсекциями `### Peer-free implementRemote` и `### Managed file boundary and strict auth returns`
- [x] `docs/guide/upgrading.md` — добавлен `## Unreleased migration` с before → after по всем пяти breaking текущей партии: manifest v2 (+`REALTIME` в `ConformanceTransport`), семь `FILE_*` кодов в exhaustive-мапах, номинальный `ScopedAuthHook`, инспектор на чтении + `inspectionTimeoutMs`, wire-stable ID для direct-биндинга async-операций
- [x] `docs/decisions/0094-auth-hook-composition-is-owned-and-atomic.md` — в Consequences назван предел изоляции: дельта по `Object.is` поверх поверхностной копии дескрипторов, поэтому in-place мутация существующего значения не считается вкладом
- [x] `docs/guide/auth-and-errors.md` — то же в разделе композиции, вместо мягкого «nested objects remain consumer-owned»
- [x] Регрессия: не требуется — изменения документационные; машинную проверку формы `done`-доков и аттестаций несёт packages/core/tests/docs-hygiene.test.ts
- [x] `bun run verify` — exit 0 на 2026-08-21. Commit, tag, push и релиз не выполнялись.
