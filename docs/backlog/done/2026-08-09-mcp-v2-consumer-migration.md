---
title: "MCP SDK v2 — consumer migration, documentation и release gates"
description: "Дать потребителям механическую миграцию на breaking MCP release, проверить packed Bun/Node paths и синхронизировать guide, reference, llms и changelog."
type: task
status: done
created: 2026-08-09
updated: 2026-08-09
completed: 2026-08-09 16:14 +00:00
related: docs/backlog/done/2026-08-09-mcp-2026-v2-release.md
---

# MCP v2 consumer migration и release gates

## Зачем

Миграция меняет public SDK lineage, удаляет stateful HTTP mode и меняет wire
lifecycle. Одного зелёного framework test suite недостаточно: потребитель должен
понять, что удалить, какие imports заменить, как протестировать host negotiation
и что не относится к обычным HTTP/Agent/React/Socket.IO surfaces.

## Результат

- CHANGELOG содержит один полный `### ⚠️ Breaking changes` с before → after.
- Upgrade guide покрывает прямой jump с `0.43.x` на целевой breaking minor.
- MCP guide объясняет modern/legacy-stateless negotiation, отсутствие sessions,
  cache policy, MRTR и CIMD.
- Generated `llms.txt`/`llms-full.txt` отражают тот же public contract.
- Packed consumer lanes доказывают Bun, Node, HTTP, stdio, rawTools, runtimeTools
  и Apps на реально упакованном tarball.

## Migration matrix

| Consumer pattern до релиза | После релиза |
|---|---|
| `sessionMode: 'stateless'` | удалить поле: stateless является единственным mode |
| `sessionMode: 'stateful'` | вынести state в domain handle/MRTR; session continuity удалена |
| `Mcp-Session-Id`/initialize/SSE resume | modern negotiation либо официальный legacy-stateless endpoint |
| v1 `McpServer` import в `rawTools` | v2 type из `@modelcontextprotocol/server`, либо `runtimeTools` |
| ручной v1 stdio transport | публичный Stitchkit stdio entrypoint на `serveStdio` |
| `createMcpHandler(config)` как функция | `const { fetch, close } = createMcpHandler(config)` |
| `createStdioMcpServer()` возвращает raw server | closeable `McpStdioHandle` владеет serving lifecycle |
| обязательный `clients.register/get`, всегда `/register` | CIMD default; DCR storage/route только при explicit config |
| destructive tool без confirmation | typed MRTR confirmation при поддерживаемом host |

Обычные HTTP contracts, browser client, Agent tools, React helpers и Socket.IO не
должны требовать миграции; это закрепляется отрицательным diff/test statement, а
не обещанием без проверки.

## План

- [x] Обновлять `docs/guide/upgrading.md` одновременно с каждым утверждённым public
      break; финальный раздел содержит целостный jump, а не историю промежуточных
      implementation attempts.
- [x] Под `### ⚠️ Breaking changes` помещать только реальные breaks: split peer/
      raw `McpServer` lineage, callable HTTP handler→`{ fetch, close }`, stdio raw
      server→handle, удаление `sessionMode`/session semantics и conditional OAuth
      registration config. Cache policy/MRTR/CIMD usage описать в `Added`/guide,
      кроме конкретного DCR-default/config break.
- [x] Добавить exact before → after snippets для каждого break, включая
      `createMcpHttpRoute`/custom RawRoute mount и shutdown wiring. Для cache,
      MRTR/CIMD дать additive recipes без ложной маркировки breaking.
- [x] Обновить `docs/guide/mcp-and-agents.md`, auth guide, API reference и MCP
      architecture; удалить любые советы про protocol sessions/stateful mode.
- [x] Документировать compatibility matrix host era × HTTP/stdio × MRTR/Apps,
      включая fail-first поведение unsupported modern features.
- [x] Добавить dependency table: кто обязан установить
      `@modelcontextprotocol/server`, где `@modelcontextprotocol/client` остаётся
      только test/dev dependency, как изолирован `ext-apps` v1 peer и какие
      imports остаются browser-safe.
- [x] Добавить consumer audit checklist: resolved version, removed v1 SDK direct
      dependency, no `Mcp-Session-Id`, modern pinned smoke, legacy-stateless smoke,
      one real tool call, Apps resource read при использовании.
- [x] Расширить consumer lane fixture так, чтобы package устанавливался из tarball,
      а не workspace source; проверить emitted `.d.ts` и optional peer errors.
- [x] Добавить Node ≥22 smoke и Bun smoke для HTTP + stdio; Node adapter не должен
      стать обязательным для Web-standard consumer.
- [x] Добавить Apps lane с актуальным official ext-apps package и явным отчётом о
      transitive v1 dependency, пока upstream не переведён полностью.
- [x] Перегенерировать agent-facing docs только из canonical docs и проверить
      отсутствие stale imports/signatures.
- [x] Добавить compile fixture для unaffected Agent/CLI invoker: MRTR opt-in не
      расширяет обычный handler/result type и не требует consumer migration.
- [x] Запустить отдельно `bun run starter-head-lane`: он не входит в root
      `bun run verify`. `create-stitchkit` обновляет свой `catalog.stitchkit`,
      lockfile, version/changelog и выпускается независимо только после уже
      опубликованного framework version, если starter реально затронут.
- [x] Провести leak audit по private project names, absolute consumer paths,
      tokens/URLs и локальным fixtures.
- [x] Lockfile, changelog section, tag convention и npm packed contents сверены;
      package version оставлена без bump, commit/tag/publish — отдельный owner gate.

## Acceptance

- [x] Consumer на `0.43.x` мигрируется по одному guide без чтения framework source.
- [x] Все removed/changed APIs имеют before → after и причину.
- [x] Unaffected surfaces перечислены и подтверждены packed tests.
- [x] Tarball Bun/Node consumers выполняют реальные HTTP и stdio tool calls.
- [x] Generated docs и declarations не содержат v1 imports/stateful instructions.
- [x] Compatibility table явно говорит: MRTR modern HTTP/stdio, modern
      missing-capability `-32021`, legacy stdio shim при capability и
      deterministic failed tool result для per-request legacy HTTP; server
      push/resume удалены.
- [x] `bun run verify`, `bun run starter-head-lane` и packed Bun/Node/Apps lanes
      запущены отдельно и приложены к release report.
- [x] Public materials не называют и не содержат пути частных потребителей.
- [x] Release checklist запрещает publish до зелёного `bun run verify` и owner gate.

## Конвейер 2/2 со стопом

- [x] Валидатор плана 1: completeness/mechanical consumer migration.
- [x] Валидатор плана 2: packed release/docs/leak audit and unaffected surfaces.
- [x] Findings внесены; ожидается owner stop-gate перед кодом.
- [x] Валидатор реализации 1: follow guide as a cold consumer.
- [x] Валидатор реализации 2: tarball/docs/d.ts/release audit.

## Правки валидатора 1

- Changelog разделён на реальные breaking changes и additive v2 features.
- Зафиксированы точные HTTP/stdio return-shape snippets, OAuth conditional config
  и compatibility matrix без неверного обещания legacy-stateless MRTR.
- Добавлены peer-dependency и unaffected Agent/CLI compile migrations.

## Правки валидатора 2

- `starter-head-lane` вынесен в отдельный обязательный gate; starter release
  остаётся независимым и может следовать только за опубликованным framework.
- Уточнены packed tarball, Apps exception, Node 22 и public `.d.ts` audits.
- Версия не захардкожена до release gate: используется «следующий breaking minor».

## Что сделано

- [x] `docs/guide/upgrading.md` содержит mechanical remove/install commands,
      before → after для split imports, HTTP/stdio handles, MRTR и OAuth policy.
- [x] Compatibility/dependency matrices и unaffected surfaces синхронизированы в
      guides, API reference, README, skill и generated `llms*.txt`.
- [x] Packed consumer lane проверяет минимальный missing-peer diagnostic, полный
      Bun consumer и Node ≥22 HTTP/stdio consumer из реального tarball.
- [x] Target starter и local-HEAD starter прошли DB, HTTP, OpenAPI, Socket.IO,
      MCP, CLI и 33 Chromium/WebKit E2E каждый.
- [x] Leak audit изменённых public materials не нашёл private project names или
      absolute consumer paths; v1 mentions остались только в migration before.
- [x] Release guard закреплён: publish возможен только после зелёного verify и
      отдельного owner gate; version/commit/tag/publish здесь не выполнялись.
