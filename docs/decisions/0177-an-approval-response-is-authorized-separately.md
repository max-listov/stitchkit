---
title: "ADR 0177: An approval response is authorized separately from the approval request"
description: "The signed request proves which approval is being answered; a response-time policy decides whether this responder may answer it, and a refusal leaves the request pending."
type: decision
status: accepted
created: 2026-09-12
updated: 2026-09-12
---

# ADR 0177 — An approval response is authorized separately from the approval request

## Context

Tool approval already had a durable request side: a tool marked `user-approval`
parks the run, `pendingApprovals` reads the parked request out of canonical
messages, and `respondToApproval` writes a durable `tool-approval-response`.
The AI SDK's signed request proves that an answer refers to *this* request and
that its tool call and input are unchanged.

It proves nothing about the responder. In a multi-tenant or multi-channel
deployment, the signature says the request is authentic; it does not say the
principal who answered the channel is allowed to decide. Treating the two as the
same guarantee leaves a hole exactly where authority matters.

## Decision

`createHeadlessAgentHarness` accepts an optional `authorizeApprovalResponse`
policy. It runs before a decision is written and receives the responder the
caller supplied, the conversation, the request (`approvalId`, `callId`,
`toolName`, `input`) and the proposed decision. It returns `allowed` or
`rejected` with a reason.

A rejection is a fact about the responder, not about the approval. It is
recorded as one durable `approval/response-rejected` ledger event with its
reason, it does **not** write a `tool-approval-response`, and the request stays
pending — so the initiating principal, or any other responder the policy admits,
can still answer it. Absent the policy, behaviour is unchanged: the signature
check alone authorizes the response.

The policy judges only identity the application supplies as the decision
context. The harness does not authenticate it because it is not where the
session principal lives; the application wires the same verified principal it
trusts for the channel. What the harness guarantees is that the decision is made
on that identity and not on a field inside the signed request.

## Alternatives

- **Fold authority into the signed request.** Rejected: a signature and a right
  are different guarantees, and one cannot carry the other without making the
  signing key an authority oracle.
- **Drop the pending request on refusal.** Rejected: that lets one unauthorized
  responder destroy an approval the initiator still needs.
- **A durable promise/registry keyed by approval id.** Rejected: the request is
  already durable in canonical messages; a second store would be a second source
  of truth for the same wait (ADR 0175).

## Consequences

A channel can now say "this responder is not allowed" without losing the
request, and the refusal is auditable with its reason. The policy is synchronous
with the decision and cannot be bypassed by the request body. Applications that
need no response authorization keep the old behaviour by omitting the policy.
