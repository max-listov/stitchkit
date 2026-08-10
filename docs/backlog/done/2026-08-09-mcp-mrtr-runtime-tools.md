---
title: "MCP MRTR — typed input_required для contract/runtime tools"
description: "Добавить framework-owned multi-round tool flow для подтверждений и elicitation без server sessions, сохранив validation, lifecycle, hooks и audit."
type: task
status: done
created: 2026-08-09
updated: 2026-08-09
completed: 2026-08-09 16:14 +00:00
related: docs/backlog/done/2026-08-09-mcp-2026-v2-release.md
---

# MCP MRTR для framework-owned tools

## Зачем

В stateless protocol tool больше не может держать открытый server→client request.
Он возвращает `input_required`, клиент исполняет elicitation/sampling/roots и
повторяет исходный call с `inputResponses` и byte-exact opaque `requestState`.

Для Stitchkit главный кейс — явное подтверждение destructive или дорогой
операции. Raw SDK escape hatch это позволяет, но обход framework runner снова
лишит consumer lifecycle/RBAC, validation, hooks и audit. Нужна framework-owned
абстракция, общая для contract и runtime tools.

## Результат

- Opt-in MCP execution policy декларативно возвращает typed запрос
  пользовательского ввода, не расширяя обычный HTTP/Agent/CLI handler result.
- Повторный round проходит через тот же identity/lifecycle/validation pipeline.
- `requestState` не хранится на сервере, защищён от подделки и имеет TTL.
- Каждый transport attempt завершает обычные lifecycle/hooks; дополнительный
  logical-flow summary может агрегировать rounds в observability sink.
- Одна declaration работает на modern HTTP/stdio и, где SDK действительно умеет,
  через session-capable legacy stdio shim. Legacy-stateless HTTP отвечает
  fail-first `-32021`, не поддельным tool result.

## Модель

- Framework предоставляет opt-in MCP policy/helpers поверх SDK `inputRequired`,
  response readers и schema-aware APIs; не копирует protocol unions и не меняет
  тип обычного contract/runtime handler.
- `requestState` содержит только минимальный continuation payload, сериализуется
  официальным `createRequestStateCodec` и HMAC-подписывается server secret; это
  **не encryption**, поэтому secrets/PII в payload запрещены.
- Ответы клиента всегда untrusted: принимаются только через Zod/Standard Schema.
- Отказ, cancel, malformed response, expired/tampered state и rounds overflow —
  отдельные нормализованные outcomes, а не `undefined` fallback.
- До подтверждения destructive side effect не выполняется; retry после accepted
  confirmation должен быть идемпотентным на уровне consumer operation.
- Signed state предотвращает tampering, но не повтор валидного token до expiry.
  Exactly-once обеспечивается domain idempotency/stable operation ID либо
  отдельным persistent consumed-token store, которого Stitchkit здесь не вводит.

## Целевая публичная форма

```ts
const tool = defineRuntimeTool({
  name: 'project_delete',
  input: DeleteProjectInputSchema,
  output: DeleteProjectOutputSchema,
  mcp: {
    multiRound: {
      handler: async ({ input, round, requestInput, finish }) => {
        if (round.phase === 'initial') {
          return requestInput.confirmation({ message: `Delete ${input.name}?` });
        }
        if (!round.confirmed) return finish.declined();
        return finish.success(await deleteProject(input));
      },
    },
  },
  handler: deleteProject,
});

createMcpHandler({
  runtimeTools: [tool],
  multiRound: {
    requestState: { key: env.MCP_REQUEST_STATE_KEY, ttlMs: 300_000 },
  },
});
```

Имена helper-ов сверяются с фактическими SDK v2 types при реализации, но граница
фиксирована: MRTR живёт внутри `mcp.multiRound`, а canonical Agent/CLI/direct
handler остаётся final-only.

## План

- [x] На фактическом SDK v2 изучить `inputRequired`, request-state sealing hook,
      `acceptedContent`/`inputResponse`, legacy shim и maximum rounds semantics.
- [x] Спроектировать `multiRound`/`inputRequired` как opt-in MCP transport policy
      рядом с tool declaration. Обычный `handler(input, context)` сохраняет
      final-output type; Agent/CLI/HTTP invoker не получает protocol continuation.
- [x] Добавить type tests: без opt-in handler физически не может вернуть
      `input_required`; opt-in callback получает typed round phase/responses.
- [x] Расширить framework execution result так, чтобы input-required не проходил
      через обычную output validation как final output и не превращался в error.
- [x] Добавить typed elicitation schema/request definition и typed response reader;
      sampling/roots оставить SDK-shaped только если runner может сохранить типы
      без speculative abstraction.
- [x] Передавать в round handler только verified continuation state и parsed
      responses; сырой requestState не становится domain context.
- [x] Настроить `createRequestStateCodec` через единственную typed config boundary;
      HMAC key минимум 32 bytes, TTL и max payload bytes fail-first. Если framework
      обещает max rounds, round number хранится/проверяется в signed state; иначе
      не выдавать client default за server guarantee.
- [x] Bind state к auth principal, tool identity/name, canonical digest исходных
      arguments, phase/round и expiry; тестировать cross-principal/tool/args replay.
- [x] Сохранить per-round auth/lifecycle: scope проверяется заново на retry,
      identity change между rounds отклоняется cryptографически/политикой state.
- [x] Сохранить текущий hook contract: каждый законченный attempt получает свой
      `afterToolCall`; `input_required` — typed continuation outcome, не error и не
      final success. Optional logical-flow event агрегирует rounds отдельно и не
      подавляет attempt hooks; межзапросная агрегация живёт только в sink/store.
- [x] Прокинуть v2 per-request `mcpReq`/era metadata в runner явным аргументом;
      запретить global/ALS continuation state и leakage между parallel calls.
- [x] Добавить generic fixtures: confirmation accepted, declined, cancelled,
      malformed content, tampered/expired state, identity switch, two rounds,
      rounds exceeded, parallel independent flows.
- [x] Прогнать одинаковые fixtures через contract tool и `defineRuntimeTool`:
      modern HTTP, modern stdio и legacy stdio shim при заявленной capability.
      Legacy-stateless HTTP и unsupported host обязаны вернуть `-32021`.
- [x] Не рекламировать MRTR capability там, где era/transport/host её не исполняет;
      prompts/resources и `subscriptions/listen` остаются вне scope.
- [x] Документировать destructive confirmation pattern, security boundaries и
      idempotency responsibility consumer-а.

## Не входит

- UI конкретного host-а или собственный MCP client.
- Persisted workflow engine и Tasks extension.
- Автоматическое подтверждение всех tools по annotations.
- Хранение pending rounds в памяти/БД Stitchkit.

## Acceptance

- [x] Consumer описывает confirmation/elicitation без `rawTools` и SDK casts.
- [x] Accepted typed content доходит до handler; malformed content не выполняет
      side effect.
- [x] Tampered, expired или чужой identity requestState отклоняется до handler.
- [x] Parallel MRTR flows не разделяют context/state.
- [x] Output validation применяется только к final result.
- [x] Lifecycle/hooks/audit семантика документирована и закреплена тестами.
- [x] Один declaration работает на modern HTTP/stdio и supported legacy stdio;
      modern host без capability получает `-32021`, а официальный
      legacy-stateless HTTP bridge возвращает deterministic failed tool result
      без выполнения handler.
- [x] Signed state tamper-resistant, но replay/ exactly-once ограничения честно
      документированы и покрыты domain-idempotency fixture.
- [x] Обычные Agent/CLI/HTTP invocation types и поведение не изменились.

## Конвейер 2/2 со стопом

- [x] Валидатор плана 1: MRTR wire/state/security semantics.
- [x] Валидатор плана 2: runner typing/lifecycle/hooks/audit composition.
- [x] Findings внесены; ожидается owner stop-gate перед кодом.
- [x] Валидатор реализации 1: tamper/expiry/concurrency/protocol audit.
- [x] Валидатор реализации 2: public API/type inference/runner equivalence.

## Правки валидатора 1

- Убрано неверное обещание legacy-stateless MRTR: оно работает modern HTTP/stdio,
  а legacy shim допускается только на session-capable stdio/host capability.
- State привязан к principal/tool/args/phase/round/expiry через официальный HMAC
  codec; отдельно зафиксировано, что подпись не шифрует и не предотвращает replay.
- Unsupported flow, decline, cancel и malformed response получили точные typed
  outcomes и `-32021`, без fake success envelope.

## Правки валидатора 2

- MRTR вынесен в opt-in MCP execution policy, чтобы не загрязнять canonical
  contract handler и Agent/CLI/HTTP result types.
- `afterToolCall` сохранён per attempt; logical multi-round summary — отдельный
  optional observability event, не скрывающий промежуточные attempts.
- Explicit per-request MCP context заменяет global/ALS state; добавлены compile-time
  и parallel-isolation gates.

## Что сделано

- [x] Typed `input_required` round model, elicitation schemas и signed opaque state
      реализованы в `packages/core/src/tools/mcp-round.ts`.
- [x] State привязан к principal, tool, args, phase, round и expiry; tamper,
      cross-identity, malformed, expiry и parallel isolation покрыты
      `packages/core/tests/mcp-mrtr.test.ts`.
- [x] Contract и runtime tools проходят один execution/lifecycle/hooks/output
      pipeline; final output validation не применяется к промежуточному round.
- [x] Unsupported capability даёт modern `-32021`; legacy HTTP возвращает
      deterministic failed tool result без выполнения domain handler.
- [x] Replay boundary и требование domain idempotency документированы и закреплены
      regression fixture без обещания exactly-once.
