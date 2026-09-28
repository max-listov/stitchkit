---
title: Model invocations share provider evidence
description: Plain completions and agent loops use one store, an atomic admission fence and one audited provider boundary.
status: accepted
created: 2026-09-28
---

# Model invocations share provider evidence

## Context

A plain completion needs causal evidence without acquiring a conversation prompt,
tools, or a tool loop. Recording it in an application-owned second ledger separates
provider attempts from the agent's evidence. Treating a completion as a one-step
agent changes the prompt and makes its behavior depend on agent policy.

## Decision

`createModelInvocationLedger` belongs to `stitchkit/agent-runtime`, an evolving
entrypoint. Its completion path calls the AI SDK once per explicitly declared model
attempt, with `maxRetries: 0`, the supplied user prompt, and no tools or instructions.
The existing agent loop opts into the same provider middleware via `invocations`.
It retains its admission, tools, step checkpoints, retry policy and fencing.

The canonical `AgentRuntimeStore` event log owns invocation starts, provider requests,
provider responses and invocation finishes. No second database, history engine or
agent loop is introduced. Runtime integration requires the same store object.

- Host authorization produces the caller; neither caller nor executing-process
  identity is accepted from request fields. Process identity is measured locally.
- An operation identifies its invocation; every actual provider call has a fresh
  attempt ID. `currentModelInvocationAttempt()` exposes these IDs inside the
  provider transport, including streamed reads. Run ID is present for agents.
- Requested selection, sent SDK model/parameters, and provider-reported effective
  identity are separate facts. Missing effective identity remains null; usage uses
  the existing provenance-aware normalizer, including gateway-specific corrections.
- `appendEventOnce` checks and appends under the existing driver transaction.
  Completion repeats return the existing invocation, never call the provider again,
  and reject changed input/caller/trace under the same key. A crash after admission
  leaves uncertain work claimed; a new key is an explicit new operation, not recovery
  that guesses whether the provider ran. Built-in memory and SQLite stores implement
  the capability; custom stores must implement its atomic contract before opting in.
- Provider payloads are AES-256-GCM artifacts in the same log. Associated data binds
  conversation, invocation and artifact identity. The key is supplied by the host and
  kept outside the database/archive. Metadata queries exclude encrypted artifacts;
  plaintext reads have a separate host authorization action. Request headers are
  excluded even from artifacts. Existing agent conversation-history authorization
  remains the host's responsibility; this does not encrypt its history tables.
- Admission or audit persistence refusal prevents the provider call. Audit errors
  remain runtime failures and never trigger provider retries. Every attempt records
  usage once, including an error stream that still supplies a billed finish.

The receipt describes the SDK adapter boundary. It does not claim to observe an
upstream gateway's hidden retries or infer wire bytes from SDK parameters. Hosts use
the transport context to attach their actual wire audit. Explicit completion
fallback is bounded to eight attempts and one overall deadline. Payload artifacts
are bounded; stream evidence has a 1 MiB cap.

## Consequences

Applications share one query and one evidence vocabulary for both modes. Completion
idempotency is durable at-most-once admission, not a promise of exactly-once provider
execution across crashes. Reads are paginated over the existing event log; atomic
admission currently scans that conversation's events inside the write transaction.

Legacy agent configurations keep their existing request-ledger format. Opting into
invocation receipts switches that writer to the common audited boundary, preventing
duplicate provider records. Existing archives remain readable. An encrypted archive
is useful only with its separately retained payload key; rotation requires retaining
the key for records written with it.

Serves I3, I8, I10, I12, I13 and I15.
