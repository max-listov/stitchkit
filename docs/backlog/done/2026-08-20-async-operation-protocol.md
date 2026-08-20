---
title: "Composable async-operation protocol: start, status, wait, cancel, result"
description: Framework-owned transport descriptor для долгих операций с optional progress/cancel/artifacts без переноса persistence, queues и domain state в Stitchkit.
type: task
status: done
created: 2026-08-20
updated: 2026-08-20
completed: 2026-08-20 12:53 +00:00
related: docs/decisions/0081-generic-native-operations-use-managed-definitions.md
---

# Async-operation protocol

## Зачем

Генерации, exports, imports, broadcasts и другие долгие jobs повторяют одну
transport-связку: запустить работу, получить status/progress, дождаться
терминала, при поддержке отменить, затем получить result/artifacts. Отдельный
`defineWaitTool` закрывает polling primitive, но не связывает всю operation
surface и её presenters. Consumers повторно проектируют names, schemas,
cancellation propagation и MCP/Agent/CLI structured output.

Stitchkit не должен становиться queue/job engine. Persistence, leases, retries,
outbox, idempotency policy и доменные состояния остаются у приложения.

## Результат

- Один Zod-first async-operation descriptor связывает application callbacks и
  transport definitions для `start`, `status`, `wait`, optional `cancel`,
  optional `result` и optional `artifacts` в одном из двух явных modes:
  - `contract-backed` принимает literal references на уже объявленные contract
    methods; contract schemas/identity — единственная правда, descriptor только
    bind-ит callbacks и derives tool definitions;
  - `runtime-only` объявляет schemas в descriptor и не создаёт HTTP surface.
- Canonical Zod discriminated snapshot классифицирует один текущий ответ как
  `pending | running | succeeded | failed | cancelled`. Stitchkit не хранит
  предыдущий snapshot и не заявляет enforcement/монотонность переходов;
  приложение явно маппит domain state и владеет consistency.
- `progress` — типизированный snapshot, предоставленный приложением; процент,
  лог событий и монотонность не навязываются.
- `wait` использует существующую managed polling/cancellation механику и один
  абсолютный monotonic deadline. Sleep ограничивается remaining budget, poll
  получает linked deadline/caller signal. Cooperative AbortSignal прекращает
  ожидание, но не притворяется отменой самой job; неподдерживаемая transport
  cancellation отмечается capability matrix, а не обещается.
- `cancel` — capability, а не обязательная операция. Его Zod result различает
  `accepted | already_terminal | rejected` (либо эквивалентную явно
  application-supplied schema); фактический terminal state подтверждается
  status/wait.
- `failed` несёт только application-supplied caller-safe public failure schema;
  raw provider/queue cause проходит существующую internal observability/error
  boundary и никогда автоматически не копируется из stored state в presenter.
- `result` доступен только для mapped `succeeded` и получает уже inspected typed
  snapshot/state либо один atomic application read — framework не делает второй
  скрытый lookup. Artifacts пока consumer-supplied schema; neutral managed refs
  подключаются только после отдельной file-boundary задачи.
- `start` возвращает application-generated value, валидированный одной
  operation-id Zod schema; ровно эта schema используется всеми follow-up
  capabilities. Framework ловит definition/name collisions, но не обещает
  уникальность application job ids без app storage.
- Каждая capability имеет отдельные scope/authorization и safe-annotation
  semantics. Opaque operation id не является authorization: callback обязан
  fail-closed повторно проверить caller access без existence leak.
- Descriptor генерирует ordinary runtime/tool definitions и reusable schemas;
  HTTP contract остаётся `defineContract()` source of truth и подключается
  typed adapter, а не вторым скрытым роутером.

## План

- [x] Зафиксировать ADR со snapshot classification, capability matrix и
      ownership:
      descriptor/presenters/cancellation — Stitchkit; storage/execution/retry —
      application.
- [x] В ADR и guide дать compilable public API sketch для `contract-backed` и
      `runtime-only`, доказывающий single declaration каждой schema и отсутствие
      второго HTTP contract.
- [x] Спроектировать Zod discriminated schemas для operation id, start result,
      pending/running snapshots, succeeded, failed+public failure, cancelled,
      cancel result и optional progress/result/artifacts. Все optional
      capabilities исчезают из inferred keyed type при отсутствии callback.
- [x] Спроектировать callbacks `start/inspect/cancel/result/artifacts` и mapper
      в canonical phase. `result`/`artifacts` получают inspected state, чтобы
      framework не создавал TOCTOU двойным `inspect`; transactional consistency
      остаётся application responsibility.
- [x] Для каждой capability закрепить method/identity, default conservative
      MCP/Agent safety annotations, scope override, callback context,
      public/error output. `status/wait/result/artifacts` не считаются
      безопасными только по имени, если application не подтверждает annotation.
- [x] Документировать mandatory resource authorization на каждом callback и
      добавить fixture: чужой operation id получает caller-safe отказ без
      раскрытия существования.
- [x] Переиспользовать существующую surface collision machinery; разделить
      definition collision и application instance-id uniqueness.
- [x] До descriptor harden canonical `pollUntil`: один absolute monotonic
      deadline, injected clock для tests, sleep capped remaining time, linked
      timeout/caller signal и signal в каждый inspect. Зависший non-cooperative
      callback не объявлять гарантированно остановленным.
- [x] Провести cancellation plumbing audit/matrix для HTTP `req.signal`, MCP,
      Agent execution options и CLI SIGINT/caller signal. Добавить недостающую
      передачу signal как явный prerequisite либо честно пометить transport
      unsupported; descriptor не обещает больше текущего runtime.
- [x] Реализовать optional capabilities так, чтобы отсутствующие cancel/result/
      artifacts не существовали ни в runtime mount, ни в inferred type.
- [x] Дать contract-backed typed adapter по literal contract + named method
      mapping. Missing/wrong method/schema/capability должен падать по типам;
      runtime comparison двух Zod object identities не является source of truth.
- [x] Добавить presenters для MCP и Agent structured output и совместимость с
      CLI generation через ordinary definitions.
- [x] Покрыть snapshot scenarios: immediate success,
      pending→running→success convention, snapshot regression (валиден и не
      скрыто запрещается framework), public failure/internal cause boundary,
      accepted/already-terminal/rejected cancel, cancel race, unsupported
      cancel, abort/timeout wait, result-before-success, definition collision и
      повторный application id без ложной framework uniqueness guarantee.
- [x] Отдельный async-specific conformance fixture не добавлялся: descriptor
      возвращает ordinary `RuntimeToolDefinition`, а одинаковый runner по
      HTTP/MCP/Agent/CLI уже проверяет transport conformance kit; дублировать
      этот suite для одного factory не требуется.
- [x] Обновить MCP/Agent/CLI guide, API reference, generated `llms` и
      `CHANGELOG.md`; дать migration recipe с отдельных start/status/wait tools.
- [x] Cross-transport descriptor реализован после conformance kit, artifact
      integration использует `ManagedFileRef`; отдельный packed async fixture
      не добавлялся, потому что публичная сигнатура проверяется declaration/type
      gates, а transport behavior — общим conformance suite. Релиз не входит.

## Acceptance

- [x] Consumer описывает long-running operation один раз и получает связанный
      набор transport operations без ручного дублирования schemas/presenters.
- [x] В contract-backed mode ни одна Zod schema/identity не дублируется в
      descriptor; runtime-only mode не создаёт скрытый HTTP route.
- [x] Приложение может использовать in-memory runner, DB queue или внешний
      provider без framework adapter к конкретному storage/queue.
- [x] Job без cancellation не экспортирует `cancel` ни по типам, ни через
      discovery.
- [x] Abort ожидания не меняет job state; cancellation job происходит только
      через application callback.
- [x] Один wait deadline ограничивает remaining sleeps и cooperative polls;
      cancellation support по HTTP/MCP/Agent/CLI задокументирован и доказан
      отдельно, unsupported path не маскируется.
- [x] Framework валидирует каждый snapshot, но не обещает stored transition
      history или монотонность без application persistence.
- [x] Каждый follow-up callback повторно авторизует resource id; fixture чужого
      id не раскрывает наличие operation.
- [x] `failed`/result/cancel envelopes валидируются Zod и не раскрывают raw
      provider/queue details. `result` не требует скрытого второго inspect.
- [x] Domain failure details проходят существующую internal/public error
      boundary и не раскрывают provider internals.
- [x] Не появляется новый WebSocket/progress engine: realtime updates остаются
      обычным Stitchkit/Socket.IO contract поверх того же status model.
- [x] `bun run verify` зелёный.

## Что сделано

- [x] Runtime-only descriptor и capability-by-presence surface: `packages/core/src/tools/async-operation.ts`.
- [x] Contract-backed type/runtime binding: `packages/core/src/tools/async-operation.ts`, `packages/core/tests/async-operation.type-test.ts`.
- [x] Absolute wait deadline and cancellation: `packages/core/src/tools/wait-core.ts`, `docs/guide/mcp-and-agents.md`.
- [x] Public docs and decision: `docs/decisions/0089-async-operations-describe-transport-not-jobs.md`, `docs/api/reference.md`, `docs/guide/mcp-and-agents.md`, `CHANGELOG.md`.
- [x] Регрессия: packages/core/tests/async-operation.test.ts::one runtime descriptor exports only configured capabilities; packages/core/tests/async-operation.test.ts::unconfigured optional capabilities are absent at runtime and in the inferred keys; packages/core/tests/async-operation.test.ts::result is gated by the already-inspected snapshot and does no second lookup; packages/core/tests/async-operation.test.ts::wait abort never invokes the application cancel capability; packages/core/tests/async-operation.test.ts::contract-backed binding reuses literal contract schemas and creates no router; packages/core/tests/async-operation.test.ts::contract-backed runtime defence names the capability and shared schema requirement; packages/core/tests/async-operation.test.ts::every capability uses its suffixed action and configured scope override; packages/core/tests/async-operation.test.ts::accepted already_terminal and rejected cancel outcomes reach the caller; packages/core/tests/async-operation.test.ts::a terminal cancel race is reported as already_terminal after one inspect; packages/core/tests/async-operation.test.ts::definition name collisions fail across mandatory and optional capabilities; packages/core/tests/async-operation.test.ts::authorization denial hides existence and stops before inspect; packages/core/tests/async-operation.test.ts::snapshot regression is validated but not rejected as a transition; packages/core/tests/async-operation.test.ts::failed snapshot strips the internal cause at the public schema boundary; packages/core/tests/async-operation.test.ts::wait accepts pending running succeeded snapshots from one application state source; packages/core/tests/async-operation.test.ts::repeated application ids are accepted without framework uniqueness state; packages/core/tests/wait-core.test.ts::caps sleep to the remaining absolute deadline
