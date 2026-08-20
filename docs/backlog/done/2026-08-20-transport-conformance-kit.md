---
title: "Transport conformance kit в stitchkit/testing"
description: Вынести повторяемую проверку HTTP/OpenAPI, MCP, Agent и CLI surfaces из starter-кода в framework-owned manifest и behavioral probe kit.
type: task
status: done
created: 2026-08-20
updated: 2026-08-20
completed: 2026-08-20 12:53 +00:00
related: docs/backlog/done/2026-08-10-surface-conformance-covers-all-four-surfaces.md
---

# Transport conformance kit

## Зачем

Официальный starter уже вручную реализует framework-aware surface manifest,
schema digests, snapshot comparison, real MCP discovery и CLI discovery.
Такая механика копируется consuming projects, хотя её форматы и transport
инварианты принадлежат Stitchkit. Исправление discovery или schema semantics
сейчас приходится переносить по проектам.

При этом совпадение operation names не доказывает одинаковое runtime behavior.
Нужны два честно разделённых слоя: декларативная surface conformance и
consumer-supplied behavioral probes через реальные transport adapters.

## Результат

- `stitchkit/testing` экспортирует framework-owned Zod schemas, типы и функции
  для:
  - построения canonical manifest из actual HTTP mount topology и полного
    `ToolSurfaceDefinition` (`services + runtimeTools`);
  - версионированных params/input/output/multipart schema digests;
  - сравнения с committed snapshot;
  - проверки OpenAPI metadata и наборов MCP/Agent/CLI operations;
  - запуска явно заданных behavioral probes на выбранных transports.
- Kit поддерживает частичную surface: HTTP-only или любое явно включённое
  подмножество не обязано монтировать отсутствующие transports.
- Cross-transport operations и CLI-only commands моделируются раздельно.
  Raw/native extensions либо явно включаются в expected extension bucket, либо
  явно исключаются; они не могут молча появиться как «лишние» или исчезнуть.
- Discovery проверяет внешне наблюдаемую surface там, где она существует:
  OpenAPI с живого handler/server, MCP через настоящий client, CLI через
  настоящий process/argv runner. Agent mount проверяется через публичный mount
  result и snapshot anchor.
- Behavioral probe задаёт operation identity, setup/teardown, fixture,
  transport capability matrix и per-transport expectations. Adapter сохраняет
  raw observation для bounded/redacted diagnostics и отдельно возвращает
  normalized success/validation/domain-error/aborted observation; различающиеся
  HTTP/MCP/Agent/CLI envelopes не маскируются одним `unknown`.
- Auth/context credentials, DB/file fixtures и domain expectations предоставляет
  consumer. Drivers имеют общий timeout/AbortSignal, output cap и cleanup;
  secrets/source bodies не попадают в diagnostics.
- В этой задаче официальный starter получает migration patch, готовый к
  применению после публикации core. Фактический переход template на
  неопубликованный Stitchkit запрещён и выполняется отдельной starter release
  task после core release.

## План

- [x] Разделить существующий starter implementation на generic core и
      project-specific wiring; перенести generic часть в
      `packages/core/src/testing`, не меняя template dependency на
      неопубликованную версию.
- [x] Определить topology-aware manifest input: HTTP path/group/scope mount
      configuration плюс canonical `ToolSurfaceDefinition`. Runtime-tool-only
      operations обязательны; CLI-only commands и raw/native extensions имеют
      отдельные declared buckets.
- [x] Спроектировать Zod-first/public types для manifest snapshot и probes без
      зависимости core runtime от MCP/AI peers при простом импорте
      `stitchkit/testing`; optional transport drivers загружать лениво либо
      через injected adapters. Base import не должен требовать даже type
      resolution optional transport package.
- [x] Опубликовать named `SurfaceManifestSchema` с `manifestVersion` и
      `digestVersion`; canonical serializer рекурсивно сортирует object keys,
      сохраняет array order и пинит algorithm/projection semantics между Bun,
      Node и поддерживаемой Zod version. Digest — change detector, не public id.
- [x] Включить отдельные projections/digests для params, input, output,
      multipart и transport/presentation identity; live OpenAPI comparison
      проверяет actual request/response schemas, а не только `x-stitchkit-has-*`.
- [x] Сделать настраиваемыми только snapshot location и read/write adapters;
      canonical schema, ordering и serialized bytes принадлежат framework.
      Test runner никогда не обновляет snapshot; regeneration — отдельная явная
      mutating command.
- [x] Добавить discovery adapters для OpenAPI, MCP, Agent и CLI. CLI canonical
      discovery использует machine-readable framework contract или injected
      adapter, а не парсинг human `--help`; command/cwd не hardcode-ятся.
- [x] Каждый external driver владеет timeout/signal/output cap/cleanup и
      получает explicit auth/context injection. MCP dependency — lazy optional
      subpath либо injected driver без peer-owned names в base public types.
- [x] Добавить Zod-first probe/observation/capability schemas, setup/teardown и
      per-transport assertions для success, validation error, domain error,
      cancellation и structured output. Не заявлять observability parity без
      явно подключённого observer/assertion.
- [x] Подготовить template/example wiring к новому kit, но фактическую замену
      template generic copy и dependency выполнить отдельной starter migration
      после публикации core; committed snapshot остаётся consumer-owned review
      artifact.
- [x] Покрыть core unit tests, runtime-tool-only manifest, CLI-only/native
      command bucket, actual HTTP mount topology, params/multipart drift,
      deterministic Bun/Node digest, real MCP client, machine CLI discovery,
      handler/OpenAPI, selected-transports, failing diff и cleanup after failed
      probe. Fake clocks/barriers предпочтительнее sleeps.
- [x] Добавить packed-consumer test, который импортирует kit только из
      `stitchkit/testing` и доказывает отсутствие обязательных optional peers.
- [x] Обновить testing guide, API reference, generated `llms`, starter docs и
      `CHANGELOG.md`. Релиз не входит.

## Acceptance

- [x] Новый consumer подключает conformance без копирования внутренних
      Stitchkit helpers и получает committed manifest snapshot плюс live
      discovery checks.
- [x] Удаление operation из одной surface, смена scope/input/output schema и
      неверный CLI/MCP mount дают детерминированный failing test с понятным
      diff.
- [x] Runtime tools, CLI-only commands, params/multipart schemas и actual HTTP
      mount topology присутствуют в manifest; raw/native surfaces явно declared
      or excluded.
- [x] HTTP-only consumer проходит kit без установки MCP, AI или CLI peers.
- [x] Canonical digest одного schema tree совпадает на Bun и Node; version bump
      digest projection описывает ожидаемую snapshot migration.
- [x] Behavioral parity заявляется только для реально выполненных probes;
      manifest-only run не выдаётся за проверку errors/cancellation/observability,
      а raw transport observation доступен только как bounded/redacted evidence.
- [x] Diff называет operation identity, transport и field, не печатает secrets
      или целиком огромный manifest.
- [x] Core kit проходит `bun run verify` и packed HTTP-only consumer lane.
      `starter-lane`/`starter-head-lane` и удаление template copy относятся к
      отдельной post-core-release starter migration task.

## Что сделано

- Добавлен peer-free stitchkit/testing kit: versioned topology-aware manifest, canonical schema digests, bounded discovery adapters и behavioral probes.
- Snapshot/diff reports называют operation/transport/field и не печатают payload или secrets; teardown выполняется при success, failure и timeout.
- Обновлены ADR 0087, testing guide, API reference, changelog, public surface и HTTP-only packed consumer lane.
- [x] Регрессия: packages/core/tests/surface-conformance-kit.test.ts::manifests contract, runtime and CLI-only surfaces with actual topology; packages/core/tests/surface-conformance-kit.test.ts::canonical schema digests ignore object key insertion order; packages/core/tests/surface-conformance-kit.test.ts::snapshot and live discovery fail on real drift; packages/core/tests/surface-conformance-kit.test.ts::behavioral probes are explicit, bounded and always tear down; packages/core/tests/surface-conformance-kit.test.ts::a non-cooperative driver cannot hold the runner past its timeout
