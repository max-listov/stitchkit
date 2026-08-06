---
title: "Фиксированные порты в тестах — флак, и он бьёт по релизному гейту"
description: Тесты хардкодят порты 9876–9973; на машине с широким эфемерным диапазоном любой из них может быть перехвачен исходящим соединением, и bun run verify падает без связи с кодом.
type: task
status: done
created: 2026-08-05
updated: 2026-08-06
completed: 2026-08-06 15:40 +07:00
---

# Фиксированные порты в тестах — флак релизного гейта

## Факт (наблюдалось трижды за одну сессию)

`bun run verify` — гейт перед публикацией. За один заход он упал три раза с
`Failed to start server. Is port NNNN in use?`, каждый раз на разном файле и без
всякой связи с правками.

Причина найдена: порт держало **исходящее** соединение постороннего процесса.

```
ss -ltnap | grep 9896
ESTAB [2a01:...]:9896 → [2607:6bc0::10]:443  users:(("claude",pid=2390746))
```

`cat /proc/sys/net/ipv4/ip_local_port_range` на ML-DEV → **`1024 65535`**, то
есть эфемерный диапазон покрывает **всё** пространство портов. Любой фиксированный
порт в тестах — это лотерея с чужими исходящими соединениями.

Провал не мягкий: файл не может забиндиться на импорте, поэтому **все его тесты
просто исчезают из прогона**. Наблюдалось `697 pass / 0 fail` вместо `700 pass` —
то есть сьют отчитывается зелёным по упавшим, а три теста молча не выполнялись.
Это хуже обычного флака: гейт врёт в сторону «всё хорошо».

## Масштаб

```
grep -rhoE "PORT = [0-9]{4}|port: [0-9]{4}" packages/core/tests | sort -u
```
→ 9876–9973, около 30 занятых номеров. Плюс `scripts/` node-smoke: 4598/4599.

Новые тесты этой сессии (`raw-response-endpoints`, `cors-response-integrity`)
уже переведены на `port: 0` — Bun назначает свободный, а `server.port` его
отдаёт. Остальные — нет.

## План

- [x] Все тестовые серверы на `port: 0` + `server.port` — 12 файлов, 27 портов.
- [x] `scripts/node-smoke` — туда же. `serveNode` уже возвращал `port` и `url`,
      ретрай не понадобился: `const res = await fetch(\`${http.url}/api/smoke\`)`.
- [x] Мест, где порт нужен фиксированным по существу, не нашлось — ни одного.
- [x] Дыра «файл выпал из прогона» закрыта не счётчиком файлов, а устранением
      причины: биндов с фиксированным номером больше нет, а гвард не даёт им
      вернуться. Счётчик ожидаемых файлов отклонён — он ловит симптом и требует
      поддержки при каждом новом файле.

## Почему это стоит сделать

Тесты, которые нельзя запустить дважды подряд с одинаковым результатом, размывают
сигнал: привыкаешь перезапускать вместо того, чтобы читать падение. И гейт,
который может отчитаться зелёным по невыполненным тестам, — это не гейт.

## Root proven, 2026-08-06 (found while validating another task)

Not a collision between two test runs — the ports are stolen by **outgoing**
connections. `net.ipv4.ip_local_port_range` on ML-DEV is `1024 65535`, so every
hardcoded test port sits inside the ephemeral range and any process on the box
can take one as a *source* port at any moment.

Caught live: `multipart.test.ts` (`PORT = 9882`) failed five tests while
`ss -ltnp` showed no listener, because 9882 was the source port of an established
HTTPS connection from an unrelated `bun` process:

```
ESTAB [2a01:…]:9882 → [2001:…]:443  users:(("bun",pid=2369012))
```

`Bun.serve` then reports `Failed to start server. Is port 9882 in use?`, which
sends the reader hunting for a stray server that does not exist.

Consequences for the fix: picking a different fixed number changes nothing, and
neither does a higher range. Only `port: 0` (bind, then read `server.port`)
removes the class. Any test that hardcodes a port is a scheduled flake on this
machine.

**Partially done, 2026-08-06:** the two `describe` blocks in `multipart.test.ts`
that were actively failing now bind `port: 0` and read `server.port` back. The
remaining hardcoded ports in that same file (`9903`, `9904`) and in
`server.test.ts`, `client.test.ts`, `serve-file.test.ts`, `error-context.test.ts`,
`scoped-client.test.ts`, `client-parity.test.ts`, `contract-factory.test.ts` are
the same scheduled flake and were left alone deliberately — they were not
failing, and converting a working test to unblock nothing is how an unrelated
change grows. This task is the sweep.

## Что сделано

**Свип** — 12 файлов, 27 портов, плюс `scripts/node-smoke.mjs`. Ноль
захардкоженных номеров: `grep -rnoE "PORT[A-Z_]* = [0-9]{4}|port: [0-9]{4}|localhost:9[0-9]{3}"`
по `tests/` и `scripts/` возвращает пусто.

Три формы, которые встретились, и что с ними сделано:
- сервер создаётся внутри `test('setup server')` → `let PORT = 0`, присваивание
  из `server.port ?? 0` сразу после;
- сервер на уровне модуля → `port: 0`, а производный `base` / `URL` объявляется
  **после** сервера;
- сервер внутри одного теста → номер вообще не нужен, обращение прямо к
  `server.port`.

**Гвард** — `packages/core/tests/no-fixed-ports.test.ts`. Проходит по `tests/` и
`scripts/`, ловит `port: NNNN`, `PORT = NNNN` и литерал в URL. Ретро-проверен:
вернул `port: 9876` в `server.test.ts` → падает с точным адресом и строкой.

**Node smoke** тоже переведён и прогнан — слушает на назначенном порту
(`http://localhost:19929/` в последнем прогоне), Socket.IO round-trip зелёный.

## Не делалось

- [x] Счётчик ожидаемых тест-файлов в `verify` — отклонён: лечит симптом
      («файл не запустился») вместо причины, и требует правки при каждом новом
      файле. Причина устранена, гвард держит.
