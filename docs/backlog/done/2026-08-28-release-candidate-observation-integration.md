---
title: Expose and verify release-candidate identity throughout CI and publication
description: Make core and starter release attempts externally observable without coupling the public repository to a private operator.
type: task
status: done
priority: P1
created: 2026-08-28
updated: 2026-08-28
completed: 2026-08-28 07:39 +0000
---

## Why

A release candidate may be running through CI while an external release observer has
no correlated release attempt to display. CI success alone does not prove npm publication.

Concrete public case: Actions run `33149964082`, exact SHA
`9ce307b14d06c19cacb3d5c95db406573669e3fd`, was the push CI for the core 0.68.1
release candidate. Publication is a separate tag-driven workflow. This is a historical
example, not a claim that this run is still active.

Relevant existing surfaces: `scripts/release-plan.ts`, `.github/workflows/ci.yml`,
`.github/workflows/release.yml`, and the separate core/starter package release commands.
Inspect the existing machine-readable release-plan output before adding any new seam.

## Result

The repository's declared release policy provides enough stable public identity for an
external operator to correlate a candidate, its exact CI run/attempt and its publication.
No operator name, dependency, endpoint, machine identity or credential enters this repository.
The private operator integration is outside the public source tree.

## Plan

- [x] Verify and document the existing core/starter policy and machine-readable inputs:
      package name/version, exact SHA, tag namespace, qualifying CI workflow/event and
      separate publication workflow. Reuse existing output; add only a proven missing seam.
- [x] Define how an external operator identifies a declared candidate before publication,
      without guessing that every push or every generic release-like commit is a release.
- [x] Preserve independent core/starter attempts and run-attempt identities, including
      retries on the same SHA. CI success, tag creation and registry publication stay distinct.
- [x] Verify integration against the agreed external observation contract; do not embed a
      private observer implementation or its invocation in public scripts/workflows/docs.

## Ordering

The release-policy and identity review can start independently. End-to-end integration
waits for the external operator's agreed versioned observation contract. If the current
public surfaces are already sufficient, return their exact usage and evidence instead
of manufacturing a framework change or unnecessary package release.

## Acceptance

- [x] The public identity/policy is sufficient to associate an in-flight declared candidate
      with exact CI run/attempt, jobs and the subsequent tag/publish result.
- [x] Ordinary CI is distinguishable from release intent. Successful CI without registry
      evidence is not called published; cancellation/retry/unknown preserve their meaning.
- [x] The next authorized real release is observed before CI completion and through
      publication, with public run/tag/registry evidence. Do not replay historical running
      transitions as if they were observed live or trigger a release solely for this task.
- [x] No private infrastructure or consumer information appears in committed files;
      report the contract, relevant version/commit, checks and any remaining blockers.

This inbox task requests policy/contract review and a concrete integration plan. It does
not itself authorize modifying an external operator or changing the release authority.

## Что сделано

- Added `bun scripts/release-plan.ts candidate <sha>`. It resolves the exact commit,
  validates the release subject and committed package/changelog/migration metadata, and
  emits versioned JSON with package, version, SHA, future tag, qualifying exact-SHA CI
  identity and separate tag-driven publication identity.
- Added public `ReleaseCandidateIdentity` and `releaseCandidateIdentity()`. Core and
  starter retain independent tag namespaces; GitHub `run id` and `run_attempt` remain
  observation facts rather than being collapsed into the candidate identity.
- Documented the pre-publication observation flow in `CONTRIBUTING.md`, including the
  distinction between successful CI and actual registry publication.
- Fixed the release-plan test harness to read package metadata from the same exact commit
  being validated instead of mixing committed subject/changelog with a dirty working-tree
  manifest.
- Regression coverage: `scripts/release-plan.test.ts` —
  `one candidate identity separates exact-SHA CI from tag publication`, plus the existing
  exact-commit release metadata suite.
- Live acceptance used candidate commit
  `2286cfc13e61b60aa551fd90fc6ee1174a30f32b`: command output declared `v0.68.2`
  before CI completed; push CI run `33152053357`, attempt 1, was observed queued and later
  completed successfully. Publication remained a distinct tag-push run `33152242014`,
  which published npm `stitchkit@0.68.2` and the GitHub release.
- Registry evidence: integrity
  `sha512-qtQJ6EHTKZ1VfqNy6sPi0jlaXaachTF+4NK297fSMAJlw55mqO2gl6IW5z0+B+e4UaODg07YXOeNLurZxFlD7g==`,
  shasum `5221d22b95f146a89c9624addde61243883b300d`.
