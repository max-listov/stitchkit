---
title: "ADR 0247: The candidate runs the tests that read release metadata"
description: The release-candidate preflight adds the few seconds of tests that read the changelog, migrations, maturity table and manifests a release commit changes.
type: decision
status: active
created: 2026-10-05 20:52 +07:00
updated: 2026-10-05 20:52 +07:00
---

# ADR 0247 — The candidate runs the tests that read release metadata

## Context

ADR 0223 left every unit test of a release candidate to the exact-SHA CI. Since ADR 0237 a release
commit holds release metadata only: the changelog roll, the promoted migrations, the version bumps,
`release-train.json` and the maturity table. The code under it reached the remote through ordinary
pushes, each behind the fast gate. So almost no test can change its answer between the last
ordinary push and the release commit — except the tests that read exactly those files. A
maturity-table sentence that disagrees with the rolled changelog passes lint and types, and is
found only when the release CI goes red. That costs a repair commit and a second CI run.

## Decision

`verify:candidate` runs lockfile, lint, types **and `test:release-metadata`**. That step runs the
tests that read the real release metadata. It is one list, in the root `package.json`:

- `scripts/surface-cadence.test.ts` — the maturity table against the changelog;
- `scripts/release-notes.test.ts` — the changelog parses into release notes;
- `scripts/release-validate.test.ts` — manifests, lockfile and the last release commit;
- `scripts/release-unchanged.test.ts` — manifests against their previous release;
- `packages/core/tests/upgrade-plan.test.ts` — the real changelog against the upgrade plan;
- `packages/core/tests/reference-coverage.test.ts` — the reference against the maturity table.

The set takes about 3 s. A test that reads one of these files belongs in the list. The step
is a subset of the fast `test` step (`FAST_SUBSET_STEPS` in `scripts/verify-profiles.ts`), so a
green fast record for the same tree still covers the candidate. The candidate still certifies
nothing as `verify:fast`. Every other decision of ADR 0223 stands: the full unit suite and the
lanes are evidence from the exact-SHA CI.

## Alternatives

- **The whole fast suite (about 200 s).** It repeats tests whose inputs the release commit cannot
  touch — the cost ADR 0223 removed.
- **Nothing (ADR 0223 as it was).** It leaves the one class of failure that a metadata-only commit
  can cause to the most expensive place to find it.

## Verification

`scripts/gate-parity.test.ts` pins the candidate steps, and every step must exist as a root script.
`scripts/verify-runner-profiles.test.ts` runs the candidate profile and checks that an existing fast
record still skips it. Changing one maturity-table figure from 49 to 50 fails `test:release-metadata`
on "the maturity table carries the figure the changelog supports".

Serves P. Amends ADR 0223.
