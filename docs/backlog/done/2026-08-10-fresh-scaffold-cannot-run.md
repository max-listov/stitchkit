---
title: "A fresh scaffold cannot run"
description: "env:ensure копирует файл, которого после скаффолда нет; env валидируется раньше самолечения; blank-стартер требует БД, которой не пользуется."
type: task
status: done
created: 2026-08-10
updated: 2026-08-10
completed: 2026-08-10 21:59 +07:00
---

# A fresh scaffold cannot run

## Зачем

Три дефекта складываются в одно: сгенерированный проект не запускается тем
способом, который печатает сам CLI.

**1. `env:ensure` копирует несуществующий файл.**
`template/scripts/local-env.ts:7` копирует `_env` → `.env`, но скаффолдер
переименовывает `_env` в `.env` ещё при генерации (`src/scaffold.ts:26`), поэтому
`_env` в выводе отсутствует. Проверено на настоящем скаффолде:
`bun run env:ensure` → `ENOENT … copyfile '<root>/_env'`. Поскольку `db:generate`
зовёт `env:ensure`, вся цепочка (`db:setup`, `build`, `dev`) ломается **у второго
разработчика, клонировавшего сгенерированный репозиторий** — ровно тот сценарий,
ради которого самолечение и существует. Правильный источник — `.env.example`.

**2. Даже после починки самолечение недостижимо.** `template/scripts/dev.ts:3`
импортирует `packages/config/src/server`, который зовёт `createEnv` немедленно,
**до** строки 20 с `ensureLocalEnvironment(root)`. То есть `bun run dev` падает на
валидации окружения раньше, чем успевает его создать. Та же форма в `dev-lan.ts:6`
и `scripts/tooling-env.ts:15`.

**3. Blank-стартер требует базу, которой не пользуется.** `_env:2` содержит
`DATABASE_URL=postgresql://USER:PASSWORD@…` — заведомые плейсхолдеры;
`dev` → `db:setup` → `db:deploy` падает на ненулевом коде (воспроизведено, `P1000`).
`src/cli.ts:41-42` печатает `cd my-app` и `bun run dev`, ни словом не упоминая
`DATABASE_URL`. При этом `schema.prisma` не объявляет ни одной модели, а
`migrations/` содержит только `migration_lock.toml` — то есть база обязательна и
не используется, а `template/README.md:17-18` вдобавок обещает, что dev «применяет
закоммиченные миграции», которых нет.

## Результат

- Клон сгенерированного репозитория поднимается без ручного восстановления `.env`.
- Валидация окружения происходит после того, как окружение может быть создано.
- Blank-стартер либо не требует БД, либо инструкция скаффолдера называет это
  требование до первого запуска.
- README шаблона не обещает несуществующих миграций.

## План

- [x] `local-env.ts`: источник — `.env.example`, а не `_env`. Проверить, что файл
      действительно есть в выводе скаффолда.
- [x] Отложить чтение env в `dev.ts`, `dev-lan.ts`, `tooling-env.ts`: импорт
      конфигурации не должен исполняться до `ensureLocalEnvironment`.
- [x] Решить судьбу БД в blank-стартере: либо `db:setup` не входит в путь `dev`,
      пока нет ни одной модели, либо CLI и README явно называют `DATABASE_URL`
      обязательным первым шагом. Молчаливое падение недопустимо.
- [x] Убрать из `template/README.md` обещание применять несуществующие миграции.
- [x] Тест на реальном скаффолде: свежий клон → `bun run env:ensure` создаёт `.env`
      без ручных действий.
- [x] `starter-lane`: добавить сценарий «клон сгенерированного проекта без `.env`»,
      иначе класс остаётся непокрытым — сегодня полоса перезаписывает `.env`
      целиком и до этого пути не доходит.

## Acceptance

- [x] На свежем скаффолде без `.env` цепочка `env:ensure` → `db:generate` проходит.
- [x] `bun run dev` на blank-стартере либо работает без внешней БД, либо падает с
      сообщением, называющим `DATABASE_URL` и способ его задать.
- [x] README шаблона соответствует содержимому `migrations/`.
- [x] Полоса покрывает сценарий второго разработчика.

## Что сделано

- [x] Реализация: packages/create-stitchkit/src/scaffold.ts and packages/create-stitchkit/template/package.json.
- [x] Регрессия: packages/create-stitchkit/tests/scaffold.test.ts::creates a project-specific local environment from the neutral example; packages/create-stitchkit/template/scripts/local-env.test.ts::renders the application identity into a fresh .env and never touches an existing one
- [x] Публичная документация и changelog синхронизированы там, где изменился consumer-facing контракт.
- [x] Итоговый bun run verify подтверждает lint, typecheck, тесты, build, Node smoke и consumer lane.

## Переоткрыто 2026-08-10 — по итогам валидации

Задача закрыта преждевременно. Галки выше — запись на момент закрытия; истина ниже.

`env:ensure`, `db:generate` и `dev` действительно самолечатся. Но **две оставшиеся
точки входа — нет**, и `loadToolingEnv()` исполняется на верхнем уровне модуля:

```
rm .env && bun run runtime:smoke
  ❌ Invalid environment variables: DATABASE_URL / API_PORT / WEB_PORT   exit 1, .env НЕ создан
rm .env && bun run e2e
  ZodError at loadToolingEnv (scripts/tooling-env.ts:15) ← playwright.config.ts:4   exit 1
```

`runtime:smoke` — это команда, которую `AGENTS.md` шаблона предписывает выполнять
перед передачей работы, то есть второй разработчик упирается ровно в неё.

**Дополнительно: два разработчика получают разные базы из одного репозитория.**
Скаффолд материализует `_env` как есть (`…/stitchkit_starter`), а
`scripts/local-env.ts` подставляет слаг — но только когда `.env` отсутствует:

```
cat .env                      -> …/stitchkit_starter     (после скаффолда)
rm .env && bun run env:ensure
cat .env                      -> …/acme_app              (после самолечения)
```

### Осталось сделать

- [x] Самолечение до валидации во ВСЕХ точках входа: `loadToolingEnv()` в
      `scripts/tooling-env.ts` первым действием зовёт `ensureLocalEnvironment`
      (сам `ensureLocalEnvironment` переведён на синхронные fs-вызовы, чтобы
      синхронный `playwright.config.ts` тоже лечился — он идёт через
      `loadToolingEnv` и отдельной правки не требует). `runtime:smoke`,
      `surface-conformance` и `e2e` начинаются с `loadToolingEnv`.
- [x] Один источник имени БД: шаблон больше не поставляет `_env` — скаффолд не
      создаёт `.env` вовсе, единственный источник — `.env.example`, из которого
      `local-env.ts` рендерит identity-производное имя при первом запуске.
      Скаффолд и самолечение больше не могут разойтись, потому что ветка
      скаффолда не существует. Переименование `app.config.json` ПОСЛЕ генерации
      меняет БД следующего созданного `.env` — чего подстановка на этапе
      скаффолда не умела в принципе.
- [x] Сценарий второго разработчика в полосе (`scripts/starter-lane.ts`, оба
      варианта): `rm .env` → `bun run env:ensure` (проверка отрендеренного
      имени, отсутствие `stitchkit_starter`) → `rm .env` → probe через
      `loadToolingEnv()` (путь `runtime:smoke`/`e2e`) → сверка, что оба пути
      создали одинаковый файл. Юнит идемпотентности и рендеринга:
      `packages/create-stitchkit/template/scripts/local-env.test.ts::renders the
      application identity into a fresh .env and never touches an existing one`.

**Финальная проверка 2026-08-10:** тесты скаффолдера — 22 pass (включая
`creates a project-specific local environment from the neutral example`,
переписанный под «скаффолд не поставляет .env»); tsc шаблона чистый.
