---
title: Release metadata is checked only on the tag, so a bad changelog costs two full releases
description: pre-push validates release notes only for pushed tags, so a release commit passes the eight-minute gate and a CI run before the millisecond-long changelog check refuses it — and by then the fix needs a second release commit.
type: task
status: done
created: 2026-08-26
updated: 2026-08-26
completed: 2026-08-26 12:04 +00:00
---

## Зачем

`pre-push` runs the cheap release-metadata validation **only for tags**:

```ts
for (const { tag, sha } of plan.releaseTags) {
  const validated = await validateReleaseTag(root, tag);
  assertReleaseCommitSubject(...);
}
const pushesReleaseCommit = plan.verify && (await hasReleaseCommit(plan.branchHeads));
```

Pushing the release **commit** carries no tag, so `plan.releaseTags` is empty and
nothing about the changelog is checked. Two lines later the same hook already
knows the push carries a release commit — that is how it selects the expensive
profile.

So the order is inverted exactly where it is most expensive. `validateReleaseTag`
reads one file and answers in milliseconds; it refuses a `### ⚠️ Breaking changes`
section with no `**Who must act:**` line, a version/changelog mismatch, a missing
migration section. All of that is knowable before the push. Instead the answer
arrives at `git push origin vX.Y.Z` — after the full local gate and a CI run —
and by then the release commit is already public, so the fix cannot be amended
in. `AGENTS.md` prescribes a **new** release commit for the same version, which
is a second full gate and a second CI run.

The hook's own comment states the principle it fails to apply:

> Cheap deterministic metadata first: a bad tag should not cost the full
> browser/starter gate before it is reported.

It is true of tags and false of release commits.

## Как воспроизводится

Measured on 0.67.0, 2026-08-26. The changelog carried a breaking section with no
audience line:

| | first release commit | second release commit |
|---|---|---|
| local gate in `pre-push` | ~8 min | ~8 min |
| CI (exact SHA, push event) | 2 min 26 s | 2 min 30 s |

The second column is entirely waste: the same tree plus ten lines of prose. The
refusal that caused it would have taken milliseconds before the first push.

## Результат

- Pushing a release commit validates that commit's own release metadata **before**
  the expensive gate, with the same function the tag path uses. The version comes
  from the commit subject, which `assertReleaseCommitSubject` already parses.
- A missing audience line, a changelog/version mismatch or an unpromoted
  migration section is refused while the commit is still local and amendable —
  one release commit, one gate, one CI run.
- The prose in `AGENTS.md` about the release order says which checks run at which
  push, so the guarantee is readable rather than inferred from the hook.

## Открытый вопрос

Is `pre-push` the right place at all, or should this be a `commit-msg` /
`pre-commit` check? A release commit is recognisable from its own subject, and
refusing at commit time means the mistake never reaches a push. The argument
against is that the changelog can be edited after the commit is written; the
argument for is that the cheapest possible moment is the point of the whole
change.

## Что сделано

### Scripts

- [x] `prePushMetadataGate` — дешёвая половина `pre-push` вынесена в одну
      экспортируемую функцию, где порядок наблюдаем, а не следует из
      последовательности операторов: сначала метаданные тегов, затем метаданные
      релизных коммитов, и только потом выбор профиля гейта
      (`scripts/release-plan.ts`).
- [x] `validateReleaseCommit` — тот же набор проверок, что и у тега, но по
      релизному коммиту. Версия берётся из манифеста в дереве коммита, а subject
      проверяется на неё существующим `assertReleaseCommitSubject` — то же
      направление, что и на теговом пути.
- [x] Проверки читают **дерево коммита**, а не рабочее: `readFromCommit(sha)`
      через `git show`. Пуш публикует коммит, и проверка рабочего дерева могла бы
      пройти, пока на сервер уходит сломанное.
- [x] `ReleaseTreeReader` протянут через `validateReleaseTag`,
      `readStarterResolution` и `assertStarterLockfileIsCurrent`, чтобы у
      стартерного релиза lockfile тоже проверялся в том дереве, которое публикуют
      (`scripts/starter-lockfile.ts`).
- [x] `hasReleaseCommit` → `releaseCommitsIn`: возвращает сами коммиты, а не
      булево. Информация была уже собрана и выбрасывалась.

### Docs

- [x] `AGENTS.md` — строка таблицы «What runs where» для релизного пуша и абзац
      «Metadata before machinery, on both pushes» с ценой, которую заплатила
      0.67.0.

### Tests

- [x] `scripts/release-plan.test.ts` — 10 новых тестов: извлечение scope из
      subject, имя тега по scope и версии, отказ на breaking-секцию без
      `Who must act` **на коммите**, отказ на subject с чужой версией, отказ на
      несовпадение scope и namespace, приём корректного additive-коммита,
      проверка настоящего HEAD (со `skip`, а не с тихим `return`), и четыре теста
      порядка: релизный коммит проверяется и профиль становится дорогим; отказ
      останавливает пуш до выбора гейта; обычный пуш не читает метаданные вовсе;
      теговый пуш проверяет тег первым.
- [x] Фальсификация: снятие цикла `validateCommit` из `prePushMetadataGate` →
      3 красных.
- [x] Решающая проверка на настоящем дефекте: `pre-push` со stdin, описывающим
      пуш коммита 577aac2 (тот самый, без строки `Who must act`), отказывает
      сразу и с тем самым сообщением — до единого шага гейта.
- [x] `bun run verify:fast` зелёный.

### Что не сделано

- [x] Открытый вопрос «не перенести ли проверку в `commit-msg`/`pre-commit`»
      закрыт в пользу `pre-push`. Причина: релизный коммит и его changelog
      правятся вместе, и отказ на `git commit` мешал бы писать коммит до того,
      как дописан changelog. `pre-push` — первый момент, где решение уже принято
      и ещё обратимо: коммит локальный, `git commit --amend` доступен.
