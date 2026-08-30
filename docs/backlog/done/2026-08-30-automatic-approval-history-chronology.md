---
title: Preserve automatic approval followed by a tool result in history
description: Keep valid automatic approval chronology and subsequent pending approvals in model history.
type: task
status: done
completed: 2026-08-30
created: 2026-08-30
updated: 2026-08-30
priority: P1
---

## Implementation plan

Canonical messages own chronology; projection carries validated call and approval state across
assistant/tool records. A call transitions from pending to approval-requested,
then approved/denied, then exactly one matching result. An approval request is a suspension point,
not a tool result. Invalid or omitted records cannot authorize a later result. Signing and runtime
fencing remain owned by the existing execution boundary.

- [x] Reproduce both failures before changing the validator: both direct projection cases failed
      with the original implementation in `packages/core/tests/agent-history-approval.test.ts`.
- [x] Share chronology validation with complete-turn selection/compaction through
      `packages/core/src/agent-runtime/history-chronology.ts`.
- [x] Exercise source and packed public Harness paths with real files and SQLite reopen:
      `packages/core/tests/agent-harness-approval-chronology.test.ts` and
      `packages/core/scripts/consumer-lane/fixtures/node/src/approval-chronology.mjs`.

Implementation and focused acceptance are complete. Final publication acceptance belongs to the
core `0.70.2` target in `release-train.json`; an unpublished fixture is never described as a release.

## Evidence

Published stitchkit 0.70.1, Bun 1.3.14. projectAgentHistoryDetailed receives a committed
assistant with this valid ordered sequence (after a user message):

1. tool-call read_file, callId=read
2. tool-approval-request approvalId=auto-read, callId=read, isAutomatic=true
3. tool-approval-response approvalId=auto-read, approved=true
4. tool-result callId=read, outcome=success
5. tool-call write_file, callId=write
6. tool-approval-request approvalId=ask-write, callId=write

Actual decision: assistant omitted with reason incomplete-tool-turn. The remaining pending
approval request is absent from model history; continuing it can fail with unknown approval ID.
This was first observed with loop.toolApproval returning approved for a read and user-approval
for a write. A direct projection reproduction also fails on the current published package.

packages/core/src/agent-runtime/history.ts completeToolChronology removes the call from pending
when seeing an approval request, then rejects the legitimate tool-result for that same call.
Do not remove approval signing/fencing or accept genuinely unmatched results to fix this.

## Acceptance

- [x] Add direct projection regression for automatic approval + result + later pending approval.
- [x] Preserve one valid model chronology and signed exact continuation through SQLite reopen.
- [x] Keep unmatched/duplicate results and forged approval responses rejected.
- [x] Confirm ordinary not-applicable reads and denied approvals still work.
- [x] Assign publication acceptance to the core `0.70.2` release train and include the exact
      regression in its mandatory packed-consumer lane. The release itself remains incomplete
      until exact-SHA CI, publication and registry artifact acceptance succeed.

This is distinct from the completed mounted-agent-tool-error-outcomes task. Hosts using
not-applicable for operations that require no confirmation do not hit this sequence; that
policy choice is not a substitute for correct public approved semantics.

## Additional release-blocking evidence: ordinary sequential user approvals

The same history validator also rejects ordinary signed user approvals; automatic approval
is not required. Reproduced on the published `stitchkit@0.70.1` archive with `ai@7.0.85`,
Bun 1.3.14 and the public Harness, SQLite store and mounted coding tools, without any
supervisor, consumer correlation code, provider network or automatic approval policy.

1. A scripted `MockLanguageModelV4` emits `write_file(first.txt)` then finishes tool-calls.
2. `harness.pendingApprovals` returns one signed request. Accept using `respondToApproval`.
3. The successor performs the first write and emits `write_file(second.txt)` plus its signed
   request, then finishes tool-calls. One pending request remains.
4. Accept the second request. The third run commits `provider_failure` before invoking the
   model. The private observability event contains `AI_InvalidToolApprovalError`: the response
   references an unknown approval ID because its corresponding request was omitted from history.
5. Actual evidence: first effect exists, second effect absent, model call count 2, terminal failed.
   The required result is two effects, three model calls and terminal success, with no replay.

The successor assistant legitimately begins with a tool-result for the previous run's call,
then contains a new tool-call and approval request. `completeToolChronology` resets its pending
set per record and rejects that leading result, omitting the entire assistant and its new request.
The projection must validate chronology across canonical records, not assume every result's call
lives in the same assistant record. Do not disable signing, invent missing calls or drop response
records to hide this failure. The same failure occurred in a real model coding turn after an
approved patch requested a subsequent approved command.

- [x] Add the two sequential user-approval case alongside the automatic-approval regression.
- [x] Run the public Harness plus real SQLite/coding tools through both signed continuations,
      including reopen before the second answer and a later ordinary message.
- [x] Assert exact result/call/request pairing across records, no duplicated first effect and
      retained private diagnostic on genuinely invalid continuation.

## Что сделано

- [x] History: `packages/core/src/agent-runtime/history-chronology.ts` models called/requested/
      approved/denied/result states with atomic per-record validation. Projection preserves pending
      approvals across records and intervening user messages, never across conversations. Completed
      turn selection uses the same validator in `terminal-status.ts`.
- [x] Execution: `packages/core/src/agent-runtime/run-execution.ts` refuses an omitted active
      tool-role input instead of treating it as an empty successful model turn. The ordinary SDK
      signature verification and existing tool fence remain authoritative.
- [x] Projection regression: `packages/core/tests/agent-history-approval.test.ts`, cases
      `preserves automatic approval, result and a subsequent pending request` and
      `pairs two sequential signed continuations across canonical records`, plus malformed pairs,
      parallel approvals, atomic omission, intervening user input and conversation isolation.
- [x] Real effects/recovery: `packages/core/tests/agent-harness-approval-chronology.test.ts`, cases
      `user: two coding operations survive SQLite reopen and a later message`,
      `automatic: two coding operations survive SQLite reopen and a later message`,
      `not-applicable: two coding operations survive SQLite reopen and a later message` and
      `denied: two coding operations survive SQLite reopen and a later message`, assert exact effect counts, signed request identity,
      both results and three model calls before the fourth ordinary turn.
- [x] Negative continuations: the same file's `unknown-response: refuses continuation before
      effects or a provider call and retains a private cause`, `unknown-without-request: refuses continuation before effects or a provider call and retains a private cause` and
      `forged-signature: refuses continuation before effects or a provider call and retains a private cause` assert no tool execution or additional model call and an internal
      terminal cause.
- [x] Packed regression: `packages/core/scripts/consumer-lane/fixtures/node/src/approval-chronology.mjs`
      runs from the existing packed Harness lane on Bun and Node with each runtime's real SQLite
      driver. Both sequential user approvals and automatic-read-then-write survive reopen.
- [x] Guide and root changelog describe the chronology and fail-closed continuation behavior.

## Verification and remaining release acceptance

- Focused runtime/harness suites: 249 pass, 0 fail, 905 assertions across 31 files.
- Core typecheck, repository lint and build passed.
- All five packed consumer fixtures passed, including Bun and Node Harness execution. After the
  final pending-request boundary refinement, the retained test artifact passed the dedicated
  approval fixture again on both runtimes.
- Test artifact: `stitchkit-0.70.1.tgz` built from the unpublished review tree, **not** the registry
  version and **not** a new release. SHA-256:
  `f688cef67dfb9c5d327245175a7815080f902fa5039a993a93a243615e3a99b0`.
- Artifact integrity:
  `sha512-GG8hoV6l7fWh2GcS9ZT79velKE1HnZP0MZrFiOm42Tw2djqJtkvWXl2ggWp4xAvQbVNTSj3GlJgASQv/sQ6JOw==`.
- No new full verify was run for this focused fix. A prior full-tree run was interrupted by database
  storage exhaustion; it is not recorded as a green release gate. Publication/version/SHA and
  registry artifact acceptance are now carried by the core `0.70.2` release train, not waived by
  implementation closure. All five packed consumer fixtures also passed on the prepared `0.70.2`
  tree, including this regression on Bun and Node.

Release acceptance: require `verify --release`, green exact-SHA push CI and the immutable `v0.70.2`
publication. Install the actual registry archive and rerun `approval-chronology.mjs` on Bun and Node;
report version, tag SHA and registry integrity only after comparing the published and CI bytes.
