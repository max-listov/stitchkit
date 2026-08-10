---
title: "The package README is never synchronised into the tarball"
description: "prepublishOnly не исполняется на выбранном пути публикации, поэтому исправления документации физически не доезжают до npm."
type: task
status: done
created: 2026-08-10
updated: 2026-08-10
completed: 2026-08-10 22:12 +07:00
related:
  - docs/backlog/in-progress/2026-08-10-documented-examples-that-throw.md
  - docs/backlog/in-progress/2026-08-10-deterministic-single-pass-releases.md
---

# The package README is never synchronised into the tarball

## Зачем

Публикация теперь идёт готовым артефактом:

```
ci.yml:47        bun pm pack  ->  release-artifacts/*.tgz
release.yml:87   npm publish "$TARBALL" --provenance
```

`bun pm pack` исполняет `prepack` и `prepare`, но **не** `prepublishOnly`; `npm publish
<файл>` его тоже не зовёт. А именно `prepublishOnly`
(`packages/core/package.json:91`) выполняет `cp ../../README.md ./README.md`.
Скрипт `sync:readme` не подключён ни к чему.

Следствие проверено сравнением файлов: два README расходятся ровно одной строкой, и
это исправление из соседней задачи —

```
211c211
< const socket = await createSocketIOServer<…>({     корневой, исправленный
---
> const socket = createSocketIOServer<…>({           packages/core/README.md, уедет в npm
```

То есть механизм доставки документации в пакет не работает **в принципе**, а не
единожды: любое будущее исправление README повторит судьбу этого. Подтверждено и с
другой стороны — в установленном `stitchkit@0.45.0` из npm `llms-full.txt` до сих пор
содержит `limiter.take` и объектную форму `parseMultipart`, хотя в репозитории они
исправлены.

Отдельная опасность: версия `0.45.0` теперь означает две разные вещи — то, что лежит
в npm, и то, что лежит в дереве.

## Результат

- Содержимое опубликованного тарбола совпадает с репозиторием: README, `llms.txt`,
  `llms-full.txt`.
- Синхронизация происходит на том шаге, который реально исполняется при выбранном
  способе публикации.
- Расхождение между деревом и артефактом обнаруживается автоматически, а не
  сравнением вручную.

## План

- [x] Синхронизация перенесена: `prepublishOnly` → `prepack` в
      `packages/core/package.json` — исполняется на выбранном пути публикации
      (`bun pm pack` в ci.yml пакует без `--ignore-scripts`). Root-скрипт
      `sync:readme` дополнен генерацией llms, чтобы ручной путь совпадал с
      автоматическим.
- [x] Проверка в полосе: шаг «Verify the packed docs match the tree» в `ci.yml`
      распаковывает собранный тарбол и `diff`-ит README, `llms.txt` и
      `llms-full.txt` против дерева; расхождение валит сборку.
- [x] `dist` в тарболе собирается из текущего дерева: `prepack` заканчивается
      `bun run build` перед самой упаковкой.
- [x] Решение по `0.45.0`: НЕ републиковать — контент опубликованного тарбола
      иммутабелен на npm; исправленные документы доедут первым же следующим
      релизом этого захода (см. changelog-задачу).

## Acceptance

- [x] Живой пробник: `bun pm pack` ядра — README тарбола побайтово равен
      корневому (включая `await createSocketIOServer`), `llms-full.txt` равен
      сгенерированному, `limiter.take` и объектный `parseMultipart` в нём
      отсутствуют, `dist/` — 249 свежих файлов.
- [x] Намеренное расхождение валит полосу — diff-шаг в ci.yml завершает джобу
      ненулевым кодом.
- [x] Гейты прогнаны в рамках закрытия захода (полный verify — финальным шагом
      зонтичной задачи).

## Что сделано

- [x] Реализация: packages/core/package.json (`prepack`), .github/workflows/ci.yml (шаг сверки тарбола), package.json (`sync:readme`).
- [x] Регрессия: не требуется — механизм доставки проверяется diff-шагом CI на каждом прогоне полосы; юнит-теста для скрипта package.json не существует по построению.
