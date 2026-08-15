---
title: Доказать forced shutdown и exact-SHA runtime gates
description: Убрать ложный physical-zero на Bun, гарантировать forced cleanup после ошибок и включить Next SSR fixture в release CI.
type: task
status: done
created: 2026-08-15
updated: 2026-08-15
completed: 2026-08-15 01:24 +0000
related: docs/backlog/done/2026-08-14-managed-http-socketio-shutdown.md
---

# Доказать forced shutdown и exact-SHA runtime gates

## Зачем

Первый managed-shutdown release корректно закрывает обычные HTTP/Socket.IO paths,
но forced Bun adapter очищает свой WebSocket tracker до server-side `close`, а
ошибка graceful-фазы может завершить shared Promise без обязательного
`forceStop()`. Кроме того, release CI не запускает реальный Next 16.3 SSR retry
fixture, хотя локальный полный gate его включает. Из-за этого часть заявленных
physical и exact-SHA гарантий сильнее фактического доказательства.

## Результат

- Forced result никогда не получает `pendingWebSockets: 0` из ручной очистки
  tracker: Bun ждёт физический close callback после `terminate()`.
- Ошибка graceful realtime/runtime phase всегда запускает best-effort forced
  cleanup; неуспешный или зависший forced adapter завершается ограниченно и
  возвращает честную ошибку вместо зависания или ложного success.
- Repeat OS signal реально проверяет одну shutdown chain и ускоряет её в forced
  transition.
- Exact-SHA GitHub core job запускает production Next 16.3 SSR retry fixture.
- Canonical WebSocket composition и starter используют только managed API.

## План

- [x] Добавить regressions для forced Bun WebSocket physical close, graceful
      adapter error, bounded forced completion и повторного OS signal.
- [x] Исправить shared lifecycle и Bun/Node adapters без ручного обнуления
      physical state и без обхода forced cleanup при исключении.
- [x] Добавить Next SSR smoke в exact-SHA core job и закрепить workflow test.
- [x] Исправить canonical composed-WebSocket example и lifecycle docs.
- [x] Завершить starter migration на managed handle и опубликованный patch.
- [x] Выпустить и проверить `stitchkit@0.49.1` через exact-SHA pipeline.

## Acceptance

- [x] Active Bun WebSocket при уже triggered force закрыт до разрешения
      shutdown Promise; snapshot ненулевой, final physical pending равен нулю.
- [x] Исключение `closeRealtime()` или `stopGracefully()` не обходит
      `forceStop()`; исходная ошибка не маскируется.
- [x] Force adapter, который не завершает physical confirmation, не способен
      оставить `shutdown()` pending без ограниченного и диагностируемого исхода.
- [x] Два настоящих OS signals дают одну lifecycle chain, второй signal вызывает
      forced transition, subprocess выходит самостоятельно.
- [x] GitHub CI exact SHA содержит и успешно выполняет `smoke:next-ssr` до
      упаковки publication artifact.
- [x] Target и HEAD starter lanes проходят с canonical managed API; release
      bridge task закрыта после обновления lock на опубликованный patch.

## Что сделано

- [x] **Failure containment:** `packages/core/tests/server-shutdown-lifecycle.test.ts`
      доказывает forced cleanup и сохранение исходной ошибки в tests
      `closeRealtime failure still forces transport cleanup and preserves the original error`,
      `stopGracefully failure still forces transport cleanup and preserves the original error`,
      `a non-settling forced adapter rejects within its explicit completion timeout`
      и `a forced-cleanup failure retains the original graceful phase error`.
- [x] **Physical Bun close:** `packages/core/tests/server-shutdown.test.ts`, test
      `forced raw Bun WebSocket waits for the server-side close callback`, не
      разрешает forced result до server-side close callback и не обнуляет tracker
      вручную.
- [x] **Повторный signal:** `packages/core/tests/server-shutdown-signal.test.ts`,
      test `a second real SIGTERM forces the same Bun shutdown chain and exits naturally`,
      отправляет subprocess два настоящих `SIGTERM` и проверяет одну forced chain.
- [x] **Exact-SHA CI:** run `31856039330` для commit
      `26be1b548c22b6bf0523611ad7a83b4a951a86b6` успешно выполнил
      `smoke:next-ssr` до pack/upload; `scripts/workflow-permissions.test.ts`, test
      `the graph fits nine runners without dropping the runtime consumer gates`,
      закрепляет runtime gates в release graph.
- [x] **Release:** `stitchkit@0.49.1` опубликован из exact-SHA artifact с npm
      shasum `cdd7ee1cc5d400c02bf031e3d7910655156f5fc7`; tag и GitHub Release
      `v0.49.1` созданы release run `31856154413`.
- [x] **Starter bridge:** template catalog и lock разрешают опубликованный
      `stitchkit@0.49.1`; `bun run verify` прошёл target blank/repository lanes,
      а `bun run starter-head-lane` — HEAD blank/repository lanes, обе с полным
      browser E2E. Отдельный release `create-stitchkit` в эту core-задачу не входит.
- [x] **Commit gate:** `scripts/check-staged.test.ts`, test
      `the staged-path hook checks root and nested template Biome projects`,
      закрепляет выбор правильного Biome config для starter-only commit.
