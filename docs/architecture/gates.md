---
title: Local gates — what runs where, and why
description: Which local gate a push earns, why the release rows cost what they cost, and how the green memo and the publication-privacy scan are kept honest.
type: architecture
status: active
created: 2026-09-23
updated: 2026-10-03 13:36 +07:00
participants:
  - role: implemented
    harness: Codex
    model: GPT-6
    at: 2026-10-03 13:36 +07:00
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
packed Bun/Node contained-files probes (ADR 0135). Two portable gaps used to be: the Postgres
stores lane, until it turned a release run red, and the supervised lane, until the supervisor became a
pinned devDependency instead of a global install. Both gaps fell on the release commit — the one
commit whose red run cannot be repaired in place (see
[Order inside a release](./release-process.md#order-inside-a-release)) — and
`scripts/gate-parity.test.ts` now holds the equivalence mechanically rather than by review.

Lanes run side by side, and several read `packages/core/dist` while another rebuilds it — packing
the core runs `prepack`, which starts with `rm -rf dist`. Everything that writes or reads that
`dist` therefore runs under `scripts/package-build-lock.ts`, keyed on `packages/core`: the build,
`bun pm pack`, and `agent-template-lane`, which typechecks the agent template against it. The 0.94
starter-and-terminal train found the reader without the lock — its typecheck saw the declarations
vanish mid-rebuild and failed on `TS7016` for every `stitchkit/*` import.

## What runs where

CI plans evidence from changed paths or `release-train.json`. Portable core, TUI, starter,
supervised and real-Darwin lanes start independently after the small planner; only publication
assembly waits for selected evidence and native binaries. A starter release runs published-target
compatibility, a core release runs packed HEAD, and scheduled/manual CI retains the complete
target × HEAD matrix. Darwin packs the public package but executes only the platform-specific
contained-files proof. → ADR 0136.

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
version calibre, the promoted migration section, and from 0.94.0 the breaking-entry metadata of
[ADR 0198](../decisions/0198-stable-is-earned-and-kept-on-a-budget.md), amended by ADR 0204 — *before* `verify` starts,
out of the commit being pushed rather than the working tree. It is one file and a regular
expression; the gate behind it is eight minutes. Until 0.67.0 this ran for pushed **tags** only, so
a release commit went through the whole gate and a CI run before the tag was refused — at which
point the commit is public and the fix needs a second release commit, a second gate and a second
CI run. 0.67.0 paid that. The order now lives in one observed function (`prePushMetadataGate`)
rather than in the sequence of statements around it.

## The green memo

All profiles — candidate, fast, full, packed HEAD and each exact release target set — remember the last green
run **by what they actually checked** (`scripts/gate-memo.ts`): an unchanged tree is not gated
twice, any edit to any file runs it again, and a skip always prints which run answers for it. A
green full or selected release run writes a separate fast-subset attestation only if every fast
step, including the frozen-lockfile install, ran successfully. The fast attestation carries the
runtime fingerprint; heavy evidence retains its PostgreSQL/browser fingerprint.

The key is the working-tree hash plus the toolchain — never a commit, a branch or a clock — and for
each selected profile it carries only the external inputs its steps actually use: the PostgreSQL server
version and a credential-free digest of its connection coordinates when a database lane runs,
and the selected Playwright runtime's upstream registry executables (default Chromium
headless shell and WebKit) when a browser lane runs.
TUI-only releases depend on neither. Playwright owns path resolution, including overrides
and hermetic installations; missing exact runtime/context is unknown. Password-only changes
do not alter the connection digest. URL-mode probes use the lane's Bun SQL transport with a
SELECT-only query; local socket probes use the same sudo/psql endpoint. Neither is visible in a tree or a runtime version, so
without them a database upgrade would leave the memo answering for a run that happened under
different conditions. PostgreSQL probes have a finite execution/output/cleanup budget.
Unreachable or unmeasurable databases and absent browser installations cannot authorize
heavy memo reuse. Successful portable checks can still certify the fast subset.
The fingerprint does not attest every database permission/configuration or browser binary byte;
those behaviors remain checked by the lanes. The supervisor needs no entry: it is a pinned
devDependency, so it is already in the tree. The record lives in the machine's cache, never in the
repository, and the tree hash is taken through a scratch `GIT_INDEX_FILE`, so the gate never writes
to the index.

Reusable evidence is written only after checking the final content hash, input generation and
a second external-input fingerprint. Changed or unknown external inputs revoke heavy evidence
while a fully completed fast subset can still be certified. Memo mutations hold the canonical
exclusive lock across the complete read/modify/atomic-replace transaction. Readers see whole
old or new records; process interruption cannot expose a partial JSON file. Cache publication
uses atomic replacement with durability=none. The transaction uses ownerlessGraceMs:null:
an empty owner record remains unknown, however old, and times out until explicit owner recovery.
Inode change times detect content changed and restored within the run; input-directory
observers detect transient creation/removal using Git's ignore policy. Ignored build output
churn does not invalidate evidence. A mixed run saves no green record and removes matching
prior attestations, including its fast subset. Generated tracked declarations and the package
README are written only when their bytes differ, so regeneration and prepack synchronization
of unchanged inputs preserve reusable proof.
Git records symlink text rather than the target tools read. A non-ignored symlink input
therefore disables memo reuse and saving with an explicit diagnosis, including its fast
subset. The checks still execute. Ignored dependency links do not count as source inputs.
Generation observations qualify target drift within a run; they do not claim to attest
external target bytes across runs.
This is a local reuse decision; exact-SHA push CI remains the publication authority.

## CI is the only authority for publication

`select-ci-run` demands a successful **push** run for the exact SHA, and nothing local can
substitute for it.

ADR 0011 describes an earlier arrangement in which every push ran the whole gate. It is a
historical record and is not edited; this page and `AGENTS.md` are the live answer.


## Fast-subset attestation

A green full or selected release profile can certify `verify:fast` only when every
fast step completed successfully, including the frozen-lockfile install. Its own
heavy gate record retains the PostgreSQL and browser environment fingerprint;
the separately certified fast record uses the runtime fingerprint those portable
checks actually depend on. An incomplete subset does not certify fast. A changed
tree or runtime invalidates the fast record, and a changed lane environment still
invalidates heavy evidence. This preserves each gate's inputs when proof is reused.


## Candidate structural preflight

`bun scripts/verify.ts --candidate` runs lockfile, lint and types. Only release
commit tips pushed to the remote `release/**` namespace receive this profile;
an ordinary commit, unrelated topic branch or mixed ordinary push keeps fast
checks. An unproven default-branch release retains the full local gate.

Unit tests run in the mandatory exact-SHA push CI before any master/tag/npm.
Candidate evidence has its own gate identity and cannot certify `verify:fast`,
which includes tests. Full and fast diagnostic commands retain all their steps.
Privacy and metadata are never skipped; failed or mismatched CI blocks publication.

On Linux, the runner bounds affordable heavy concurrency by the smallest visible cgroup v2 or v1 memory-controller ancestor budget (limit minus usage), as well as host memory and exhausted-swap headroom. Host RAM alone cannot authorize allocations beyond a session or parent slice limit. Confirmed unlimited, unsupported and unavailable cgroup budgets are distinguished from measured zero. An unreadable visible limit keeps the effective budget unknown and selects one heavy lane; an explicit concurrency override retains its documented precedence. This admission estimate does not reserve RAM against other processes.
