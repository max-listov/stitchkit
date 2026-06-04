---
title: "Full-review fix sweep — 65-файловое ревью пред-релизного пласта"
description: "Фиксы находок per-file Opus-ревью всех незакоммиченных изменений с 0.3.0 (CLI / OAuth / OpenAPI / native tools / MCP apps). 2 CRITICAL + 6 HIGH + MED/LOW, тройной анти-доверие гейт."
type: task
status: done
created: 2026-05-29
updated: 2026-05-29
completed: 2026-05-29 17:51
related: docs/backlog/done/2026-05-29-validation-hardening.md
---

# Full-review fix sweep

## Контекст

Per-file ревью 65 незакоммиченных файлов (46 Opus-ревьюеров → adversarial verify
каждой находки → мой личный re-read CRITICAL+HIGH). 95 подтверждённых находок.
Один вердикт саба (zod-peer = CRITICAL) **отклонён** моим гейтом как неверный
(zod намеренно required-peer ради единого инстанса; перенос в deps сломал бы
`instanceof`). Системная тема: SSRF/size-cap/path-containment гарды жили только
в `view-file.ts` — новые fetch-пути их не переиспользовали.

## Что сделано

### Системный secure-fetch / containment (CRIT 1,2 · HIGH 4,5)
- [x] `internal/secure-fetch.ts` (новый) — извлечён SSRF-гард из view-file:
  `isPrivateIp` / `assertPublicUrl` / `fetchGuarded` / `readCapped`. **+scheme-allowlist**
  (редирект на `file:` отбит — закрыта LFI) **+empty-host reject**.
- [x] `view-file.ts` — использует shared secure-fetch (убраны локальные копии).
- [x] `mount-download.ts` — `fetchGuarded` (SSRF) + `readCapped` (cap) + `allowPrivateHosts`/`maxBytes`.
- [x] `tools/cli.ts` `downloadResults` — `fetchGuarded` + `readCapped` + **basename+isWithinDir**
  (path-traversal закрыт) + `allowPrivateDownloadHosts`/`maxDownloadBytes`.

### Прочие HIGH
- [x] **HIGH 7** `mcp-app.ts` — `require('node:fs') as …` → статический `import { readFileSync }` (ADR 0003).
- [x] **HIGH 8** `tests/secure-fetch.test.ts` (новый) — SSRF: scheme/file:, numeric, private, per-hop redirect, cap.
- [x] **HIGH 9** `docs/guide/cli.md` — `lifecycle: authHook` (голый) → `{ beforeHandle: authHook }` (иначе gate молча не работает; потребитель не пострадал — делает правильно).

### OpenAPI (HIGH 6 + MED)
- [x] multipart-эндпоинт → `multipart/form-data` (читает `method.multipart`).
- [x] DELETE input → query (как клиент); **централизовано** в `internal/http-input.ts`
  `inputIsQuery()` — один источник для client + openapi (убран дубль правила).
- [x] `requestBody.required` по факту наличия required-полей.
- [x] **`unrepresentable: 'any'` для openapi** (`toJsonSchema` теперь конфигурируем,
  дефолт `'throw'` для tools) — одно `z.date()`-поле больше не схлопывает весь эндпоинт в `{}`.

### OAuth (MED + LOW)
- [x] RFC 9728 §3.1 — metadata-URL вставляет well-known **перед** path (`/mcp` не дропается); путь роута консистентен.
- [x] DCR `grant_types` рекламирует `refresh_token` только если grant включён.
- [x] PKCE — `plain` удалён целиком (S256-only, OAuth 2.1); `verifyPkce(verifier, challenge)`.
- [x] DCR redirect — `http` только loopback (RFC 8252), `https` всегда.

### Прочее
- [x] `implement.ts` — `key as keyof T` → `typedEntries` + `String(key)` (убран `as`; line-41 seam оставлен — документированный typed↔loose).
- [x] `cli-args.ts` — proto-guard на top-level flag/boolFlag boundaries.
- [x] `cli-format.ts` — undefined-data success явный (не полагается на falsy stringify).
- [x] `mount-upload.ts` — `upload()→undefined` → `null` (не undefined-как-текст).
- [x] Доки: `toToolName` (verb-aware, не `prefix_key`); reference `ServerConfig`→`HandlerConfig`/`BunServerConfig`, `ALL_TRANSPORTS`/`Transport`/`TransportSource` +CLI; README/VISION «~4000»→«~8500».
- [x] CHANGELOG — `RequestEvent` поля + секция «Security & correctness hardening (pre-release)».

### Тесты
- [x] `secure-fetch.test.ts` (новый) · `oauth.test.ts` (+refresh single-use, code-injection client_id/redirect, refresh-disabled, DCR loopback, RFC9728 path) · `cli.test.ts` (+download containment) · `native-tools.test.ts` (download URL → public-IP literal).

## Верификация
- stitchkit: tsc чист · **339 pass / 0 fail** · biome чист · build ok.
- потребитель: **8/8 пакетов** typecheck green против пересобранного dist · cli/mcp build · cli-смоук грузится · F5 admin-leak = 0 (без регрессии).

## Что НЕ делалось (осознанно)
- **zod-peer** — отклонено (by-design, единый инстанс; см. Контекст).
- `implement.ts:41` typed↔loose `as` — документированный seam (ADR 0003), редизайн `Handlers` рискован.
- `mount-download.dirFromArgs` / `mount-upload.path` containment — ответственность потребителя (ADR 0019 mechanism-only).
- Часть MED test-gaps (audit-hook, mcp-app inliner success-path, wait-core done-vs-timeout, remote) — добавлены security-критичные (SSRF/oauth/cli-download); остальные — кандидаты в inbox.
- LOW edge: `--wait-timeout abc` fail-first, value-option-съедает-флаг — отложено (поведенческий риск, низкая ценность).
- `docs-vs-exports` lint (анти-регрессия) — кандидат в inbox.
