---
title: Composable agent harness foundation
description: Complete the optional agent-runtime building blocks needed for local, remote and terminal harnesses without making them mandatory or duplicating the runtime.
type: task
status: done
created: 2026-08-30
updated: 2026-08-30
priority: P1
completed: 2026-08-30 04:01 +0000
pipeline: composable-agent-harness
order: 0
depends-on: —
---

## Зачем

The process-local AgentRuntime and headless facade own durable execution, but a complete harness
still has to copy resource discovery, a reconnectable control client, interactive authorization,
large-output handling and guarded coding operations. Copying those pieces
creates a second implicit framework around the framework and makes terminal, web and remote clients
interpret the same run differently.

The program must keep one runtime and one durable history. Every additional layer is optional,
server-only and composable; applications may use the low-level runtime, individual leaves or the
integrated harness profile.

## Результат

- A minimal public foundation supports lazy instruction and skill resources, reconnectable clients,
  pending approvals, bounded referenced output and safe single-file coding transactions.
- Canonical snapshots remain authoritative. Transient progress never becomes a second history.
- UI rendering, transport authentication, process placement, provider credentials, deployment and
  product session metadata remain application-owned.
- Existing `mountAgent`, direct tools and `createAgentRuntime` continue to work independently.

## Программа

| Order | Task | Result | Depends on |
| --- | --- | --- | --- |
| 1 | `2026-08-30-failed-run-continuation-evidence.md` | failed terminal runs retain safe non-success evidence | — |
| 2 | `2026-08-30-bounded-harness-resource-discovery.md` | explicit-root resource discovery with provenance and budgets | 1 |
| 3 | `2026-08-30-agent-approval-continuations.md` | native durable two-turn approval continuation | 1, 2 |
| 4 | `2026-08-30-agent-control-client-and-view.md` | transport-neutral control protocol, leases and pure UI projection | 1, 2, 3 |
| 5 | `2026-08-30-agent-output-artifacts-and-coding-transactions.md` | referenced output, search and guarded single-file patch | 2, 3, 4 |
| 6 | `2026-08-30-integrated-agent-harness-profile.md` | reference composition and packed end-to-end proof | 2, 3, 4, 5 |

Interactive PTY/background process sessions remain a separate icebox item until two consuming
harnesses demonstrate a shared lifecycle. A unary bounded shell already covers the foundation.

## План

- [x] Run one global 2/2 conveyor: two independent plan reviews, implementation, full gates and two
  independent implementation reviews.
- [x] Keep state machines and ownership boundaries in architecture/ADR documentation.
- [x] Complete each child task with named regression evidence and honest lifecycle closure.
- [x] Rescan inbox, planned and in-progress after every green program pass.
- [x] Leave one release-ready review tree; commit, push, tag and publication are excluded until an
  explicit release command.

## Acceptance

- [x] A packed Bun consumer and a packed Node consumer can compose the integrated profile entirely
  from public package entrypoints.
- [x] A terminal or remote client can reconnect from a canonical snapshot after missing transient
  events without replaying tools or approvals.
- [x] Skills, direct tools, deferred tools, permissions and referenced output
  retain independent typed identities and explicit budgets.
- [x] Optional entrypoints do not load for contract-only, tool-only or low-level runtime consumers.
- [x] Existing public behavior is retained unless a deliberate breaking change has a migration,
  version-calibre release plan and regression proof.

## Non-goals

- A framework-owned terminal renderer, PTY/process supervisor, product session browser or deployment daemon.
- A generic tool execution gateway or a second agent loop.
- A new WebSocket engine, provider credential store, filesystem sandbox or git policy.

## Что сделано

- Two independent plan reviews and two independent implementation/security reviews covered the
  whole program. Rechecks closed approval chronology, resource-generation isolation, control ABA/
  overflow/lease rollback, patch races and byte-budget findings before the final gate.
- ADR 0131, architecture, guide, API reference, README/package docs, VISION, changelog and generated
  `llms.txt` surfaces describe the same optional composition and explicit host boundaries.
- `bun run verify` green on tree `2d6d2f378417`: 1,970 core tests, 26 scaffolder tests, 153 root-script
  tests, 95 template tests, 7 PostgreSQL tests, build, Next SSR, Node smoke, packed Bun/Node consumers,
  both starter lanes and supervised PM2 lane.
