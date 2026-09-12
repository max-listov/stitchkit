---
title: "ADR 0179: The parent owns a child's blocking events"
description: "The child manager owns settlement per child conversation; blocking requests are presented on the parent and routed back by request identity."
type: decision
status: accepted
created: 2026-09-12
updated: 2026-09-12T16:48+07:00
---

# ADR 0179 — The parent owns a child's blocking events

## Decision

The child manager owns one live handle and settlement promise per child
conversation. A late result cannot overwrite a terminal state. `subagent` waits
for settlement and reads the same canonical row as `list_agents`; no second
call-id settlement implementation is introduced.

Each blocking request has a child-local identity and a parent-scoped identity.
The parent answers exactly that request. `batchId` groups presentation only;
answering one request never discards unanswered siblings. Approval responses
carry `approved` and optional `reason`; input responses carry a JSON `value`.
A response of the wrong kind is refused before reaching the child.

A child harness uses `blockingPresentation: 'parent'`: its presentation events
and `snapshot()` omit approval requests, while canonical storage and
`pendingApprovals()` retain them. The host bridges `pendingApprovals` and
`respondToApproval` through the child handle to the parent manager. Custom input
requests use the same handle contract with `kind: 'input'`. The host owns child
principal inheritance and response authorization; no token forwarding is added.

Presentation polls and responses are serialized. A presentation is marked only
after its ledger append succeeds. A failed spawn persistence stops the host
handle and reconciles any surviving live row. Settlement failures remain
observable through `waitChild` without becoming unhandled rejections.

## Boundaries

The relay owns presentation for live handles in this process. Reconstructing a
remote host handle and reconnecting its UI remain host responsibilities.
Applications must present through the harness/parent APIs, not render private
canonical storage as a second approval interface.
