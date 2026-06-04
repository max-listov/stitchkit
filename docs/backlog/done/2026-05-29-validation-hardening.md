---
title: "Validation-hardening sweep — пост-валидационные фиксы CLI / native-tools"
description: "10 находок 3 валидаторов по done-таскам (CLI-транспорт, generic native tools) — proto-pollution, passthrough-clobber, view_file sandbox, error-guarding, doc-fixes, тесты. Затрагивает stitchkit + потребителя."
type: task
status: done
created: 2026-05-29
updated: 2026-05-29
completed: 2026-05-29 16:28
related: docs/backlog/done/2026-05-26-cli-transport.md
---

# Validation-hardening sweep

## Контекст

После закрытия CLI-транспорта и generic native tools 3 субагента-валидатора нашли
10 находок. Перед фиксом каждая перепроверена отдельным агентом против текущего
кода (вердикт: 9 `confirmed`, 1 `partial` — view_file, латентная). Чинилось по
фазам с обязательным гейтом пересборки stitchkit dist + `bun install` у потребителя
между stitchkit-правками и потребительскими.

## Что сделано

### stitchkit — core
- [x] **F1 proto-pollution** — `tools/cli-args.ts` `setNested`: `if (path.some(isUnsafeKey)) return;`.
  Единственная client-key граница без guard'а (остальные 6 уже имели). Политика —
  только `__proto__` (как в `internal/safe-json.ts`).
- [x] **F2 passthrough-clobber** — `tools/cli.ts` `collectPassthrough`: новый
  `passthroughBase()` парсит JSON-строку поля (coerce-then-merge), так что
  `--parameters '{json}' --extra foo` больше не теряет JSON (был silent data loss
  из-за порядка: passthrough ДО `coerceJson`).
- [x] **F7 native error-guarding** — `tools/mount-wait.ts` обёрнут целиком,
  `tools/mount-download.ts` схлопнут в один try/catch (fetch/mkdir/writeFile) →
  `textResult('Wait/Download failed: …', true)`. Единый фрейминг, не зависим от
  catch-обёртки SDK. `mount-upload.ts` уже был эталоном.
- [x] **F3 view_file sandbox** (stitchkit-половина):
  - `internal/within-dir.ts` — нормализация trailing-sep (убит баг `root+sep === '//'`,
    из-за которого `root='/'` случайно запрещал ВСЁ; теперь containment по смыслу).
  - `tools/view-file.ts` локальная ветка — `realpath` + повторный `isWithinDir`
    (анти-symlink-escape) + media-allowlist (`EXT_MIME`): никогда не читает
    `config.json` / `.env` / `id_rsa`, даже внутри sandbox.

### stitchkit — docs
- [x] **F6 fails-closed → fails-open** — `docs/guide/cli.md` + `docs/decisions/0016-cli-transport.md`:
  переписано. Без `lifecycle` scoped-команда идёт **unguarded** (gate opt-in на всех
  tool-транспортах, parity верна — полярность врала). Рекомендация валидатора:
  чинить доки, не код (core domain-free, ADR 0002).
- [x] **FLOW1** — `docs/api/reference.md:287`: удалён мёртвый `formatSuccess`
  (символа нет в коде).

### stitchkit — tests (+68 assertions, 320 → all green)
- [x] `tests/wait-core.test.ts` (новый) — `pollUntil` backoff/last-repeat/timeout/
  poll-before-sleep/onTick через инъекцию `sleepFn`.
- [x] `tests/native-tools.test.ts` (новый) — `textResult` envelope + mountWait/
  Download/Upload через реальный in-memory `McpServer`↔`Client` (success + error-фрейминг).
- [x] `tests/cli.test.ts` — F1 (proto-pollution + constructor-own-key) + F2 (passthrough merge).
- [x] `tests/security.test.ts` — `isWithinDir` root-нормализация + `resolveMedia`
  sandbox (media-read / non-media-refuse / escape / symlink-escape).

### Потребитель — отдельная backlog-таска по F5
- [x] **F3 половина на стороне потребителя** — `mcp/config.ts` дефолт `fileRoot` = output-dir (не `/`),
  один источник с download-dir; `mcp/native.ts` использует `config.outputDir`.
- [x] **F4 deps** — `stitchkit`/`zod` (cli), `stitchkit`/`zod`/`@modelcontextprotocol/sdk`
  (mcp) перенесены devDeps → dependencies + externalized в build. **Критично:** единый
  инстанс zod (две копии сломали бы `instanceof z.ZodObject` интроспекцию stitchkit).
- [x] **F5 admin-leak** — см. backlog потребителя `.../client-safe-contracts.md` (Что сделано).
- [x] **F8 fetchMe** — `cli/auth.ts`: `AuthUserSchema.parse`, без fallback `'unknown'/0`,
  локальный тип удалён.
- [x] **F9 McpToolContext** — `backend/mcp/server.ts`: `interface`→`type`, index-sig
  убран, 6 полей объявлены явно (вернул type-checking фабрики контекста).

## Верификация
- stitchkit: `bun run check` чист, `bun test` — 320 pass / 0 fail, `bun run build` ok.
- потребитель: `bun run check` — 8/8 пакетов зелёные; cli+mcp build; admin-leak grep = 0;
  built-бандл грузится через node (external zod/stitchkit резолвятся); `--help`
  рендерит таблицу аргументов (instanceof через external-границу работает).

## Что НЕ делалось
- **F6 опц. hardening** — startup-assert в `createCli` (кидать если scoped-метод без
  lifecycle) НЕ добавлен — отдельная фича, не блокер; доки теперь честны.
- **F8 unit-тест у потребителя** — в `packages/cli` нет тест-инфры; скаффолдить harness =
  scope creep. Логика проста (`AuthUserSchema.parse`), покрыта типами. Гэп отмечен.
- **frontend prod-chunk grep** (F5) — полный `next build` не гонялся.
- **docs-vs-exports lint** (предложен валидатором как анти-регрессия для FLOW1) —
  кандидат в inbox, не в этом sweep.
