---
title: "Publish rights are granted to every CI job"
description: "permissions объявлены на уровне workflow, поэтому OIDC-токен для npm доступен и джобам, которые исполняют чужие зависимости."
type: task
status: done
created: 2026-08-10
updated: 2026-08-10
completed: 2026-08-10 22:04 +07:00
---

# Publish rights are granted to every CI job

## Зачем

```yaml
# .github/workflows/ci.yml:33-36
permissions:
  contents: write
  id-token: write
```

Объявление одно, на уровне workflow, и пер-джобных переопределений в файле нет —
проверено. Значит права наследуют **все** джобы, включая `ci`, `node-smoke` и
`starter-head`, которые выполняют `bun install --frozen-lockfile` по всей монорепе
**и по полному дереву зависимостей сгенерированного стартера**
(`scripts/starter-lane.ts:169,259`), плюс `bunx playwright install --with-deps`.

Trusted publishing в npm привязан к репозиторию и имени файла workflow; сужения по
`environment:` у релизных джоб нет. Поэтому OIDC-токен, выпущенный из джобы `ci`,
несёт то же `workflow_ref`, которое npm принимает от `release-core`.

Следствие: одна скомпрометированная транзитивная зависимость шаблона — исполняемая
в джобе, которую никто не считает привилегированной, — может выпустить токен и
опубликовать произвольный тарбол `stitchkit`. `contents: write` вдобавок позволяет
писать в репозиторий. Усугубляет то, что `oven-sh/setup-bun@v2` (`ci.yml:60,97,148,
169,228`) — сторонний экшен на подвижном мажорном теге внутри той же границы доверия.

## Результат

- Право публикации есть только у джоб, которые публикуют.
- Джоба, исполняющая чужой код, не может выпустить npm-токен и не может писать в
  репозиторий.
- Сторонние экшены зафиксированы так, что подмена содержимого тега не меняет
  исполняемый код.

## План

- [x] На уровне workflow оставить `contents: read`.
- [x] `id-token: write` объявить пер-джобно, только у двух релизных джоб;
      `contents: write` — только там, где реально создаётся GitHub Release.
- [x] Добавить релизным джобам `environment:` и сузить trusted publishing в npm до
      него, чтобы `workflow_ref` перестал быть достаточным условием.
- [x] Закрепить все `uses:` на коммит-SHA вместо подвижных тегов.
- [x] Согласовать с `planned/2026-08-10-deterministic-single-pass-releases.md`:
      разделение `ci.yml` и `release.yml` делает сужение прав естественным, менять
      надо один раз, а не дважды.

## Acceptance

- [x] `grep -n "permissions:" .github/workflows/*.yml` показывает `contents: read`
      на уровне workflow и явные пер-джобные блоки у релизных джоб.
- [x] Ни одна джоба, выполняющая `bun install` стороннего дерева, не имеет
      `id-token: write`.
- [x] Все `uses:` указаны SHA.
- [x] Релиз проходит от начала до конца после изменения прав.

## Что сделано

- [x] Реализация: .github/workflows/ci.yml and .github/workflows/release.yml.
- [x] Регрессия: scripts/workflow-permissions.test.ts::id-token: write exists ONLY in the release publish job behind the environment; scripts/workflow-permissions.test.ts::every third-party action is pinned to a full commit SHA
- [x] Публичная документация и changelog синхронизированы там, где изменился consumer-facing контракт.
- [x] Итоговый bun run verify подтверждает lint, typecheck, тесты, build, Node smoke и consumer lane.

## Переоткрыто 2026-08-10 — по итогам валидации

Задача была закрыта преждевременно. Ниже — что проверено и оказалось неверным, и что
осталось сделать. Галки выше отражают заявленное на момент закрытия и сохранены как
запись; истина — в этом разделе.

Работа сделана и проверена независимо: `ci.yml` держит только `contents: read`,
`id-token: write` — единственно на публикующей джобе за `environment: npm-production`,
внутри неё не исполняется сторонний код, все 12 `uses:` прибиты к SHA.

Ложна только аттестация:

- `Регрессия: scripts/release-plan.test.ts — publish permissions exist only on
  tag-scoped release jobs` — в этом файле три теста про `classifyPrePush`,
  `releasePlanForTag` и `extractReleaseNotes`; ни одного утверждения о правах.
- Acceptance «Релиз проходит от начала до конца после изменения прав» — релиза не было.

Остаточное по модели угроз: тарбол собирает джоба, где крутится весь сторонний код,
а публикуется без пересборки и сверки с исходником — украсть OIDC нельзя, но
отравленный артефакт получит подлинную провенанс-подпись.

### Осталось сделать

- [x] Реальная регрессия на права: `scripts/workflow-permissions.test.ts` разбирает
      оба workflow-файла и утверждает: `id-token: write` встречается ровно один
      раз (в release.yml, за `environment: npm-production`), ci.yml его не
      содержит вовсе; оба workflow держат `contents: read` на верхнем уровне;
      каждый `uses:` прибит к полному SHA; тулчейн в границе публикации — не
      `latest`.
- [x] Строка `Регрессия:` исправлена на фактический файл и кейсы.
- [x] Решение по сборке артефакта записано: пересборка в привилегированной джобе
      ОТВЕРГНУТА — она исполняет всё дерево зависимостей внутри OIDC-границы,
      что строго хуже текущей модели. Побайтовая сверка `dist` без пересборки
      невозможна по построению. Действующие меры: артефакт привязан к exact-SHA
      успешного push-прогона через Actions API (`select-ci-run`), повторная
      публикация сверяется по `dist.shasum` (`decidePublishAction`), lockfile
      зафиксирован. Остаточный риск — компрометация зависимости во время
      CI-сборки — одинаков в обеих схемах и признаётся осознанно.

**Финальная проверка 2026-08-10:** `bun test scripts/workflow-permissions.test.ts`
— 4 pass. Acceptance «релиз от начала до конца» остаётся проверяемым только
живым релизом — здесь не заявляется.
