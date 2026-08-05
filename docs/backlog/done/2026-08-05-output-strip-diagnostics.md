---
title: "Handler output silently loses keys the contract does not declare"
description: validateHandlerOutput returns parsed.data, so a handler returning more than its output schema declares has the extra fields deleted with no error, no warning and no type-level signal — invisible during a live-API migration.
type: task
status: done
created: 2026-08-05
updated: 2026-08-05
completed: 2026-08-05 16:20 +07:00
---

# Make the output strip visible — opt-in, not by default

Reported by a consuming project migrating a live API: 153 of 183 endpoints return
more than their contract declares. Verified in v0.25.0.

## Facts

`internal/errors.ts` — `validateHandlerOutput` returns `parsed.data`;
`server/create.ts` assigns `result = checked.data`. A plain Zod object strips, so
undeclared keys vanish. TypeScript cannot catch it (structural typing does not
reject excess properties on a value that is not an object literal), and nothing
logs it. The client sees a 200 with fewer fields.

This is the **output** twin of the input-side defect fixed in ADR 0034 — with one
crucial difference: here the stripping is *correct*. The contract is the published
shape of the response; a handler leaking extra fields is the bug, and cutting them
is the framework doing its job. The problem is not the behaviour, it is that the
behaviour is **invisible** exactly when a consumer is most likely to hit it.

## Options

### Option A — warn by default

- ✅ Nobody can miss it.
- ❌ A key comparison on every response in the hot path, and a permanent log line
  for consumers whose handlers legitimately return internal fields they never
  intended to publish. Noise becomes the default for correct behaviour.

### Option B — opt-in diagnostic (recommended)

A server-level flag (working name `warnOnOutputStrip`, off by default). When on,
`validateHandlerOutput` compares the pre/post key sets and reports the dropped
paths through the configured logger, with the endpoint identity.

- ✅ Zero cost when off — the comparison only runs behind the flag.
- ✅ Turn it on for a migration, read the list, fix or extend the contracts, turn
  it off. Exactly the reporter's workflow.
- ❌ A consumer who never reads the docs never learns the flag exists → the doc
  paragraph is not optional, it is half the fix.

### Option C — a strict mode that *fails* on extra keys

- ✅ Loudest possible.
- ❌ Turns a cosmetic leak into a 500 on a working endpoint. The output contract is
  a *publication* boundary, not a validation boundary; failing here punishes the
  wrong side.

### Option D — documentation only

- ✅ Free.
- ❌ Leaves the reporter (and the next migrator) diffing 153 endpoints by hand.

**Chosen: B + the doc paragraph from D.** C is rejected outright; A trades a quiet
correct behaviour for permanent noise.

## Depth question to settle in the plan validation

Top-level keys only, or nested? Nested is what a migrator actually needs (a
trimmed field three levels down is exactly what a top-level diff misses), but it
means walking two structures. Proposal: implement nested, guarded by the flag, and
report dot-paths — the cost is irrelevant when the flag is off, and a half-answer
here sends someone hunting for the wrong endpoint.

## Plan

- [x] `internal/errors.ts` — `validateHandlerOutput` optionally reports dropped
      key paths (deep diff of input vs `parsed.data`), only when asked.
- [x] `server/create.ts` + the tool path (`tools/execute.ts`) — thread the flag and
      the logger, so the diagnostic works on **every** transport, not just HTTP.
      The reporter's tools strip identically today.
- [x] Endpoint identity in the message (`serviceName` / `key`), so the line is
      actionable without a stack trace.
- [x] Tests: flag off → no comparison, no log (assert the logger is untouched);
      flag on → dropped top-level and nested paths reported with the endpoint name;
      arrays of objects handled; a `.loose()` output schema reports nothing;
      a passing output reports nothing.
- [x] `docs/guide/upgrading.md` — a plain paragraph: **your handlers may be
      returning more than the contract declares, and stitchkit removes it**; here
      is the flag to find out. This lands regardless of the flag's fate.
- [x] `CHANGELOG.md` — additive.

## Acceptance

- [x] With the flag on, a handler returning an undeclared field logs its path and
      the endpoint identity, on HTTP and on a tool call.
- [x] With the flag off, behaviour and cost are unchanged (no diff runs).
- [x] `upgrading.md` states the behaviour whether or not the reader uses the flag.

## Process (конвейер 2/2)

- [x] 2 plan validators
- [x] Implementation
- [x] `bun run verify` green
- [x] 2 implementation validators
- [x] "Что сделано" + `done/`

## Что сделано

- [x] `internal/errors.ts` — `validateHandlerOutput` принимает необязательный
      репортёр; `strippedPaths` считает **глубокий** дифф присутствия ключей
      (объекты + массивы по индексу, `rows[0].b`). Без репортёра обход не
      выполняется вовсе — на пути ответа не появляется ни одной лишней операции.
- [x] `server/types.ts` + `server/create.ts` — флаг `warnOnOutputStrip`
      (по умолчанию **выключен**), сообщение несёт идентичность эндпоинта
      (`notes.get: secret, nested.alsoSecret`): один путь без имени хендлера
      неактивен для действий.
- [x] `tools/execute.ts`, `tools/mount.ts`, `tools/mcp.ts`, `tools/agent.ts` —
      `onOutputStrip: (toolName, paths) => …`. Тул-транспорты срезают точно так же,
      и диагностика только для HTTP отправила бы мигрирующего искать не там.
- [x] `tests/output-strip-diagnostics.test.ts` — 9 тестов: глубокие пути, массивы
      по индексу, чистый выход не срабатывает, `.loose()` ничего не сообщает,
      **флаг выключен → логгер не тронут** (иначе «нулевую стоимость» доказать
      нечем), тул-путь с именем тула, и поведение без репортёра байт-в-байт.
- [x] **ADR 0037** + строка в индексе; `docs/guide/upgrading.md` — абзац, который
      едет независимо от флага: консьюмер, который про флаг не прочтёт, всё равно
      должен знать о самом поведении. `CHANGELOG.md` под `[Unreleased]`.
- [x] Осознанно не покрыто (записано в ADR): поле, которое `.transform()`
      переписывает, а не удаляет — дифф сравнивает присутствие, не значение, иначе
      он срабатывал бы на каждом легитимном приведении типа.

**Gate:** `bun run verify` exit 0 — **650 pass / 0 fail**, build + Node smoke зелёные.
