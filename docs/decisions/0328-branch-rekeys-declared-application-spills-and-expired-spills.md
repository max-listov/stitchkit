---
title: "ADR 0328: Branching carries expired spills as history and rekeys declared application spill references"
description: branchConversation accepts spills legitimately removed via spill/deleted without requiring live bytes, preserves delete provenance across throughRunId cutoffs, and adds sourceIdentity 'rekey-spill' on applicationKeys for host tool JSON containing spill references.
type: decision
status: accepted
amends: ["0300"]
created: 2026-11-25 13:41 +08:00
updated: 2026-11-25 13:41 +08:00
---

# ADR 0328 — Branching carries expired spills as history and rekeys declared application spill references

Amends [ADR 0300](0300-a-record-of-the-past-is-not-a-reference.md). Serves **I8**, **I12**, and **I15**.

## Context

Under ADR 0258 and ADR 0300, `branchConversation` required every `spill/created` event in the selected prefix to have a live entry in `archive.spills`, and refused any declared `applicationKeys` value naming a source spill regardless of mode (`'refuse'` or `'retain'`).

Two real operational patterns broke under those rules:

1. **Legitimately expired spills:** A spill store deletes expired spill bodies and records a `spill/deleted` event in the conversation archive. Once the last spill expires, `archive.spills` is empty while the earlier `spill/created` event and message/tool references remain in immutable history. Branching that conversation — or branching it with `throughRunId` at a point before `spill/deleted` was appended — failed with `integrity` ("Source archive is missing spill bytes") even though the archive was consistent.
2. **Application tools returning spill references in JSON:** Application tools that read or transform large outputs return structured JSON whose fields hold spill references (for example `artifactId` or `reference`). Because ADR 0300 refused every spill reference under `applicationKeys`, conversations containing such tool outputs could not be branched even when the host authorized spill copying (`artifactAuthorization`).

## Decision

1. **Expired spills cross as deterministic rekeyed history with integrity verification:**
   - `branchConversation` scans the full source archive (including inert `runtime/branch-observation` entries from prior branches) to reconcile every `spill/created` against `spill/deleted` and live `archive.spills`.
   - A spill that has a matching `spill/created` and `spill/deleted` (matching `bytes` and `sha256`) and is absent from `archive.spills` is classified as legitimately expired. It gets a deterministic destination spill reference without copying bytes, requires no `artifactAuthorization` when no live spills remain, and rekeys references in the copied prefix consistently.
   - Any integrity anomaly — an orphan `spill/deleted` without `spill/created`, duplicate `spill/created` or `spill/deleted` for one reference, mismatched `bytes` or `sha256`, a `spill/deleted` whose spill is still present in `archive.spills`, or a `spill/created` absent from both `archive.spills` and `spill/deleted` — still refuses immediately with `AgentConversationBranchRefusedError` (`code: 'integrity'`).
   - When `throughRunId` cuts the copied prefix before the source's `spill/deleted` event, the branch appends an inert `runtime/branch-observation` recording the rekeyed `spill/deleted` before `runtime/branched`, so a subsequent branch of that branch observes the same valid provenance instead of seeing an unaccounted spill.
2. **`sourceIdentity: 'rekey-spill'` on `applicationKeys`:**
   - `applicationKeys` adds a third mode: `sourceIdentity: 'rekey-spill'`, amending ADR 0300's rule that a declared key naming a spill always refuses.
   - Under `'rekey-spill'`, a string matching a source spill reference (live or legitimately expired) is rewritten to the destination's rekeyed spill reference, provided live spills are authorized via `artifactAuthorization`. If live spills exist without authorization, the branch collects the standard `artifact-authorization-missing` refusal.
   - Non-string JSON values (such as `null`, numbers, booleans) pass through, and nested arrays/objects are walked recursively; any string value under `'rekey-spill'` that is not exclusively a source spill — including a foreign spill reference not belonging to the source conversation, an application file reference, or another source runtime identity (conversation, run, message, tool call, approval, operation, idempotency key, schedule, child, owner) — still refuses before any destination write.
   - Rewriting opaque JSON payloads is pure: the transformed JSON replaces the field in messages, observations, and provider journal entries (recomputing any envelope `sha256` over the canonical rekeyed payload).

## Consequences

- Conversations whose spills expired under retention remain branchable — including with `throughRunId` and across multi-hop branches — while genuine archive corruption still fails closed with `integrity`.
- Application tools can return spill references in structured outputs and still branch cleanly once declared with `{ key, sourceIdentity: 'rekey-spill' }`, with zero leakage of source spill addresses and zero silent acceptance of foreign references.
- The change is additive on `applicationKeys` (`'refuse'` remains the default and `'retain'` is unchanged).
