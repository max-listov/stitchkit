---
title: "Форма релиза проверяется машиной, а не дисциплиной"
description: Тег 0.55.0 уехал на пост-фикс коммит, релизный коммит остался с красным CI, а в тело коммита попал литеральный \n — три шва, которые обязан ловить гейт.
type: task
status: done
created: 2026-08-20
updated: 2026-08-20
completed: 2026-08-20 17:05 +00:00
---

# Форма релиза как инвариант

## Зачем

Разбор релиза 0.55.0 (опубликован, работает, содержимое пакета проверено)
показал три шва, каждый из которых остаётся в истории навсегда:

1. **Тег не на релизном коммите.** `v0.55.0` указывает на
   `e2ae365 test(server): align shutdown timing with force budget`, а релизный
   коммит — предыдущий, `5ac767a release(core): … in 0.55.0`. `git show v0.55.0`
   и заголовок GitHub Release показывают правку тестов вместо релиза. Для
   проекта, где теги и changelog — контракт с агентом-потребителем при
   миграции, это ложный указатель.
2. **Красный CI на релизном коммите.** Прогон на `5ac767a` упал одним
   таймингочувствительным тестом; фикс приехал следующим коммитом. Дисциплина
   «не тегать красное» соблюдена, но порядок оказался обратным: релизный
   коммит запушили до зелёного, поэтому тег и был вынужден уехать на фикс.
   Существующий `assertTagOnReleaseHead` требует, чтобы тег стоял на head
   origin/master — и честно привёл к этому результату.
3. **Литеральный `\n\n` в теле коммита** `e2ae365` — артефакт квотинга; в
   истории остаётся слипшейся строкой. Замер по реальной истории: из последних
   50 коммитов такую слипшуюся строку несут **12**, включая четыре релизных —
   это не единичная описка, а системная.

Первое и второе — одна причина: гейт проверяет **положение** тега, но не
**природу** коммита под ним. Третье — отсутствие проверки текста сообщения.

Тег 0.55.0 не двигаем: он опубликован, его уже могли подтянуть. Чиним будущее.

## Результат

- Релизный тег невозможно опубликовать с коммита, который не является релизным
  коммитом своей версии и своего namespace: новая `assertReleaseCommitSubject`
  вызывается из publishing workflow (`assert-subject` рядом с `assert-head`),
  из `bun run release:*` и из `pre-push`. Серверный вызов — главный: локальный
  хук обходится `--no-verify` и отсутствует в свежем клоне без `bun install`.
- Правильный порядок («сначала фиксы, релизный коммит последним, зелёный
  прогон, потом тег») становится единственно проходимым, а не рекомендацией.
- Литеральный `\n` в теле коммит-сообщения отклоняется `commit-msg` хуком
  до создания коммита.
- Правило записано в релизный раздел `AGENTS.md` рядом с существующим потоком.

## План

- [x] `scripts/release-plan.ts`: чистая
      `assertReleaseCommitSubject(subject, version, scope)` — subject обязан
      начинаться с `release(<scope>):` для namespace своего тега и называть
      версию по границам цифр/точек (`0.56.0-rc.1` и `10.56.0` не проходят).
- [x] Прокинуть её в три пути: `assert-subject` в `release.yml` (единственный
      необходимый — публикация идёт только через него), `release`-команду и
      `pre-push`. В `pre-push` subject резолвится по **отправляемому SHA** из
      `classifyPrePush`, а не по локальному имени тега, иначе
      `git push origin <sha>:refs/tags/vX` обходил бы проверку.
- [x] Дешёвые проверки тегов в `pre-push` идут ДО полного `verify`.
- [x] `scripts/commit-message.ts` + `.githooks/commit-msg`: отклонять
      литеральные `\n`/`\t` в теле; бэктики и fenced-блоки освобождены,
      незакрытый fence не глотает хвост, экранированный `\\n` не считается
      слипом.
- [x] `AGENTS.md`: порядок, честное описание обеспечения (оба гейта серверные),
      путь восстановления после красного CI и новая форма release-subject
      вместо устаревшего примера `release: 0.4.0`, который гейт отклоняет.
- [x] `CONTRIBUTING.md`: три хука вместо двух, описан `commit-msg`.
- [x] Тесты в `scripts/release-plan.test.ts` и `scripts/commit-message.test.ts`.
- [x] `bun run verify` + два read-only валидатора.

## Acceptance

- [x] Тег на не-релизном коммите падает до публикации с внятной ошибкой.
- [x] Тег на релизном коммите правильной версии проходит.
- [x] Сообщение с литеральным `\n` не создаёт коммит; нормальное — создаёт.
- [x] `bun run verify` зелёный.

## Что сделано

- Гейт формы релиза:
  - [x] `scripts/release-plan.ts` — `releaseScopeForTag` + `assertReleaseCommitSubject(subject, version, scope)`: subject обязан быть `release(<scope>): … in X.Y.Z` для namespace своего тега, версия матчится по границам цифр/точек
  - [x] `.github/workflows/release.yml` — шаг `assert-subject` рядом с `assert-head`: проверка живёт в единственном пути публикации и не зависит от локальных хуков
  - [x] `scripts/release-plan.ts` — `PrePushPlan.releaseTags` несёт отправляемый SHA (`ReleaseTagPush`), subject резолвится по нему, а не по имени тега; дешёвые проверки идут до полного `verify`
- Гигиена сообщений:
  - [x] `scripts/commit-message.ts` + `.githooks/commit-msg` — литеральные `\n`/`\t` в теле отклоняются; бэктики и парные fenced-блоки освобождены, незакрытый fence не глотает хвост, экранированный `\\n` слипом не считается
- Документация:
  - [x] `AGENTS.md` — порядок релиза, честное описание обеспечения (оба гейта серверные), путь восстановления после красного CI, новая обязательная форма release-subject вместо устаревшего примера `release: 0.4.0`
  - [x] `CONTRIBUTING.md` — три хука вместо двух, описан `commit-msg`
- Проверено на реальной истории:
  - [x] `assert-subject` отклоняет настоящий `v0.55.0` (`test(server): …`) и пропускает настоящий релизный `5ac767a` и starter-релиз `0.3.3`
  - [x] Замер `commit-msg` по последним 50 коммитам: 12 несут литеральный `\n`, включая четыре релизных
- Не сделано (осознанно):
  - [x] Тег `v0.55.0` не переставлен: он опубликован, его могли подтянуть — двигать published-тег запрещено; чинится будущее, не прошлое
- [x] Регрессия: scripts/release-plan.test.ts::a release tag on a non-release commit is refused, naming the honest order; scripts/release-plan.test.ts::the version must match on boundaries — prerelease and longer numbers do not pass; scripts/release-plan.test.ts::the subject scope is bound to the tag namespace; scripts/release-plan.test.ts::classifies by the REMOTE ref: HEAD:master and sha:refs/tags forms are covered; scripts/commit-message.test.ts::rejects a body whose paragraph break arrived as the two characters backslash-n; scripts/commit-message.test.ts::an unterminated fence does not swallow a real slip after it; scripts/commit-message.test.ts::an intentionally escaped backslash-n is not a slip
- [x] `bun run verify` — exit 0 на 2026-08-20: 1331 core, 24 scaffolder, 34 script, обе стартер-лейны, consumer lane, node smoke. Commit, tag, push и релиз не выполнялись.
