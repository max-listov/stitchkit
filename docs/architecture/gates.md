---
title: Local gates — what runs where, and why
description: Which local gate a push earns, why the release rows cost what they cost, and how the green memo and the publication-privacy scan are kept honest.
type: architecture
status: active
created: 2026-09-23
updated: 2026-10-04 09:21 +07:00
---

# Local gates — what runs where, and why

The rules live in [`AGENTS.md`](../../AGENTS.md#what-runs-where); this page holds their reasoning.
The CI graph and the publication boundary are in [`ci-release.md`](./ci-release.md); the release
protocol in [`release-process.md`](./release-process.md).

## `verify` is every portable gate CI runs

Release candidates use the structural candidate profile on `release/X.Y.Z`, followed by the complete selected CI
for the exact SHA. `bun scripts/verify.ts --release` protects a direct unproven master release. `verify` is the whole portable local gate and it runs **every portable gate CI
runs**: the frozen-lockfile install every runner performs first, lint, typecheck, tests, the
Postgres stores lane (the agent store and the Telegram update store against a real server), build, the Next-SSR and Node smokes, the packed consumer lane, the packed
starter lanes and the supervised PM2 lane. Its prerequisites are listed in
[`CONTRIBUTING.md`](../../CONTRIBUTING.md), and all of them arrive with `bun install` except a
reachable PostgreSQL and the Playwright browsers.

The only CI-only qualifier is work another kernel cannot execute: real macOS arm64/x64 builds and
packed Bun/Node process/files probes, plus relocated JS and standalone native artifacts
with integrity and refusal controls (ADR 0135). Every other CI lane has a local step, and
`scripts/gate-parity.test.ts` holds that equivalence mechanically. A lane that only CI runs
is a lane whose red result lands on the release commit, the one commit whose run cannot be
repaired in place (see [Order inside a release](./release-process.md#order-inside-a-release)).
The supervised lane needs no global install: its supervisor is a pinned devDependency.

Lanes run side by side, and several read `packages/core/dist` while another rebuilds it — packing
the core runs `prepack`, which starts with `rm -rf dist`. Everything that writes or reads that
`dist` therefore runs under `scripts/package-build-lock.ts`, keyed on `packages/core`: the build,
`bun pm pack`, and `agent-template-lane`, which typechecks the agent template against it. The 0.94
starter-and-terminal train found the reader without the lock — its typecheck saw the declarations
vanish mid-rebuild and failed on `TS7016` for every `stitchkit/*` import.

## What runs where

CI plans evidence per SHA. A release commit, a scheduled run and a manual run select every
package; an ordinary push or pull request narrows by the paths it changed, and shared tooling,
workflows, hooks, root manifests and `bun.lock` select every package. A push whose SHA already
has a successful push run (the master fast-forward of a release branch) selects nothing, so a
release pays for one full matrix. Portable core, TUI, starter, supervised and real-Darwin lanes
start independently after the small planner; only publication assembly waits for selected
evidence and native binaries. A starter-only change runs published-target compatibility, a core
change runs packed HEAD, and a release or scheduled run retains the complete target × HEAD
matrix. Darwin packs the public package but executes only the platform-specific
process/files and native artifact proofs from the installed registry. Each macOS runner qualifies
its real architecture; portable skips and cross-builds cannot certify native execution. → ADR 0136.

So the local gate **complements** CI instead of copying it, and `pre-push` picks by what a red run
would cost on the commit being pushed:

| Push | Local gate | Why |
| --- | --- | --- |
| ordinary branch push | `lockfile`, `lint`, `check`, `test` (~40s) | a red CI run costs one follow-up push |
| `release(...)` commit to a **`release/**`** branch | metadata, then lockfile/lint/types | nothing is published; CI gates that exact SHA before master sees it |
| `release(...)` commit **to master** with no green run for its SHA | metadata, then `verify --release` for the selected train (heavy concurrency measured from host and cgroup headroom, `VERIFY_HEAVY_CONCURRENCY` overrides) | a red run here cannot be repaired in place |
| `release(...)` commit to master that CI already passed | metadata only | the fast-forward publishes a tree CI has answered for on this exact SHA |
| tag only | release metadata; for a **scaffolder** tag also the lockfile check | the commit already has a green exact-SHA run |

The release rows are the whole argument. `assert-subject` requires a tag to sit on a
`release(<scope>): … in X.Y.Z` commit and `assert-head` requires that commit to be the branch head,
so a red run on an already-pushed **master** release commit is repaired only by making a **new**
release commit. That asymmetry is what the expensive local gate buys, and it exists only where the
commit lands on master unproven. Push the same commit to `release/X.Y.Z` first and CI answers for
the exact SHA before anything is published — a red run there is repaired by amending the commit.
The local gate then has nothing left to prove, and `ciAlreadyAnsweredFor` says so out loud rather
than skipping silently: it prints whether it skipped because the run was green, because it was not,
or because GitHub could not be reached. Everywhere else, red is two and a half minutes and a fix.

## The publication-privacy scan is never memoised

The scan runs on both pushes and is never memoised. It reads the index, and the memo's key is a
working-tree hash that counts untracked files — so a new file is inside the key and outside the
scan at the same time, and `git add` moves neither. A push therefore skipped it once and published
a real machine path; CI went red afterwards, which for a public repository is a report rather than
a refusal. It costs 367 ms. → [ADR 0164](../decisions/0164-a-local-gate-refuses-ci-only-reports.md)

## Metadata before machinery

On both pushes a release commit's changelog is read — version against the manifest,
`### ⚠️ Breaking changes` against its `**Who must act:**` line, the breaking section against the
version calibre, the promoted migration section, and the breaking-entry metadata of
[ADR 0198](../decisions/0198-stable-is-earned-and-kept-on-a-budget.md), amended by ADR 0204 — *before* `verify` starts,
out of the commit being pushed rather than the working tree. It is one file and a regular
expression; the gate behind it is eight minutes. It runs for every pushed release commit, not only
for tags: a bad release commit would otherwise go through the whole gate and a CI run before the tag
was refused, at which point the commit is public and the fix needs a second release commit, a second
gate and a second CI run. The order lives in one observed function (`prePushMetadataGate`)
rather than in the sequence of statements around it.

## The green memo

Only the `fast` subset (`lockfile`, `lint`, `check`, `test`) is remembered
(`scripts/gate-memo.ts`). An unchanged tree is not gated twice, any edit to any file runs it
again, and a skip always prints which run answers for it. Heavier lanes read PostgreSQL,
browsers and the network, none of which a tree hash can see, and exact-SHA CI is what answers
for them; they run every time or are left to CI.

The key is the working-tree hash plus the toolchain (Bun, Node, platform) — never a commit, a
branch or a clock. A green run of any profile that contains every fast step (`fast`, `full`,
`--release`) writes the fast record; a profile whose steps are all fast steps (`fast`,
`--candidate`) is skipped by `--if-changed` when that record exists. `--if-changed` on any
other profile prints that it runs in full. The candidate profile writes nothing: it has no
unit tests, so it cannot certify the fast subset.

The record lives in the machine's cache, never in the repository, and the tree hash is taken
through a scratch `GIT_INDEX_FILE`, so the gate never writes to the index. The file is one Zod
schema (`GateMemoSchema`); a damaged gate entry reads as empty. Memo updates hold the exclusive
lock across the whole read, modify and atomic replace, so readers see a complete old or new
document and an interrupted writer leaves the old bytes.

A run saves nothing when its inputs moved: the tree hash is taken before and after, and the
input generation (inode change times, plus watchers on the input directories that follow Git's
ignore policy) catches content changed and restored within the run. Ignored build output churn
does not count. A non-ignored symlink input disables reuse and saving with an explicit
diagnosis, because Git records the link text and not the target the tools read. The checks still
execute. Generated tracked declarations and the package README are written only when their
bytes differ, so regeneration of unchanged inputs preserves the record.

This is a local reuse decision; exact-SHA push CI remains the publication authority.

## CI is the only authority for publication

`select-ci-run` demands a successful **push** run for the exact SHA, and nothing local can
substitute for it.

ADR 0011 describes an earlier arrangement in which every push ran the whole gate. It is a
historical record and is not edited; this page and `AGENTS.md` are the live answer.


## Candidate structural preflight

`bun scripts/verify.ts --candidate` runs lockfile, lint, types and `test:release-metadata` — the
few seconds of tests that read the changelog, migrations, maturity table and manifests a
metadata-only release commit changes (ADR 0247; the list is that root script). Only release
commit tips pushed to the remote `release/**` namespace receive this profile;
an ordinary commit, unrelated topic branch or mixed ordinary push keeps fast
checks. An unproven default-branch release retains the full local gate.

The rest of the unit tests run in the mandatory exact-SHA push CI before any master/tag/npm.
A candidate run cannot certify `verify:fast`, which includes tests; it can be skipped
by an existing fast record for the same tree. Full and fast diagnostic commands retain all their steps.
Privacy and metadata are never skipped; failed or mismatched CI blocks publication.

Heavy-lane concurrency is `floor(available memory / 3.5 GiB)`, at most two, where 3.5 GiB is the measured
footprint of the heaviest lane (Next build plus three browsers). Available memory is the host's `MemAvailable`; when
swap is nearly exhausted it is `MemFree`, because evicting needs somewhere to go. An unreadable `/proc/meminfo`
selects one lane. `VERIFY_HEAVY_CONCURRENCY` overrides the estimate, and a session under a cgroup memory limit sets it
because the host figure does not see that limit. A failing lane is named with the memory floor the lanes ran through,
so a kill is never attributed to memory without a number.
