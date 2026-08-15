---
title: Доказать forced shutdown и exact-SHA runtime gates
description: Убрать ложный physical-zero на Bun, гарантировать forced cleanup после ошибок и включить Next SSR fixture в release CI.
type: task
status: in-progress
created: 2026-08-15
updated: 2026-08-15
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
- [ ] Завершить starter migration на managed handle и опубликованный patch.
- [ ] Выпустить и проверить `stitchkit@0.49.1` через exact-SHA pipeline.

## Acceptance

- [x] Active Bun WebSocket при уже triggered force закрыт до разрешения
      shutdown Promise; snapshot ненулевой, final physical pending равен нулю.
- [x] Исключение `closeRealtime()` или `stopGracefully()` не обходит
      `forceStop()`; исходная ошибка не маскируется.
- [x] Force adapter, который не завершает physical confirmation, не способен
      оставить `shutdown()` pending без ограниченного и диагностируемого исхода.
- [x] Два настоящих OS signals дают одну lifecycle chain, второй signal вызывает
      forced transition, subprocess выходит самостоятельно.
- [ ] GitHub CI exact SHA содержит и успешно выполняет `smoke:next-ssr` до
      упаковки publication artifact.
- [ ] Target и HEAD starter lanes проходят с canonical managed API; release
      bridge task закрыта после обновления lock на опубликованный patch.
