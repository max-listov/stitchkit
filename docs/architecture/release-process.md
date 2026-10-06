---
title: Release process — breaking changes, versions and the release train
description: How a breaking change is marked and migrated, which number moves, and the order of a release with the incidents that shaped each step.
type: architecture
status: active
created: 2026-09-23
updated: 2026-10-03 13:36 +07:00
---

# Release process — breaking changes, versions and the release train

The rules are one line each in [`AGENTS.md`](../../AGENTS.md); this page holds the full protocol
and the incidents behind it. Much of it is scar tissue from runs that went wrong. The CI graph and
the exact-SHA publication boundary are in [`ci-release.md`](./ci-release.md); which local gate a
push earns is in [`gates.md`](./gates.md).

## How a release happens

Five steps, one command each. Every command is idempotent until the last one.

| # | Do | Command | What it guarantees |
| --- | --- | --- | --- |
| 1 | Commit each feature or fix on its own, with its own conventional subject and a body | `git commit` | `git log`, `bisect` and `revert` work per change |
| 2 | Write the release metadata: version, changelog roll, train | `bun scripts/release-plan.ts prepare core@X.Y.Z && bun install --ignore-scripts` | next patch or minor only; the notes carry real content |
| 3 | Check it before anything expensive | `bun run release:check` | version matches manifest and lockfile; a break is a minor and carries `**Who must act:**` and its promoted migration; the package differs from its previous release |
| 4 | Commit the metadata as `release(train): <summary> in X.Y.Z`, push `release/X.Y.Z`, wait for its push CI run, fast-forward master | `git push -u origin release/X.Y.Z` | a green exact-SHA push run exists before anything is public |
| 5 | Tag the master head | `bun run release:train` | tags only the proven head; CI then publishes the artifact CI built, and the registry bytes are checked |

The tag workflow publishes nothing CI did not build for that SHA. Details of each rule are below;
the pre-push and tag-time gates refuse every shape that skips a step.

### The consumer canary

A release that is breaking, or that changes `stitchkit/process`, is tried on the consumers the owner
controls before it is tagged. After step 4's CI run is green and before the fast-forward, run
`bun run consumer-canary` on the release commit: it downloads the tarball CI built for it (the file
that will be published), runs each consumer's own tests on a scratch clone of its committed HEAD with
`stitchkit` overridden to the tarball, judges a failure against the consumer's own pinned version,
and records a green result for that tree. `bun run release:train` (step 5) refuses a required canary
without a record. `--local` and `--tarball <path>` give a first look before CI and are never
recorded. A consumer that fails because the release breaks it on purpose is released by committing
the reason in `release-train.json` as `consumerCanaryWaiver`. The consumers live in the machine
profile `STITCHKIT_CONSUMER_CANARY_PROFILE` (default `~/.config/stitchkit/consumer-canary.json`), not
in this repository:

```json
{
  "schemaVersion": 1,
  "consumers": [
    { "name": "app", "path": "/abs/path/of/its/checkout", "test": ["bun", "run", "test"] }
  ]
}
```

`install` (default `bun install`) and `timeoutMs` (default twenty minutes) are optional. → ADR 0250.

### Measuring the pipeline

A pipeline benchmark never needs a published version. Run steps 2 to 4 on a throwaway branch and
stop before step 5: the push run of `ci.yml` for the exact SHA is the measured candidate. Pack the
train with `bun scripts/pack-release-train.ts` and run `npm publish --dry-run ./release-artifacts/<tarball>`
to measure the publish step without a registry write. The dry-run line has not been exercised by a
test in this repository. A release whose packed files equal the previous release is refused by
`release:check`, so a benchmark cannot reach step 5 by accident.

## Breaking changes and migration

Breaking changes are **allowed** — pre-1.0, an evolving API is expected. The rule is not "never
break", it is "**never break silently**". One source of truth, one format, so an agent upgrading a
long-frozen consumer can recover the full diff between versions mechanically.

When a change breaks a public API (removed/renamed export, changed signature or return shape,
changed default, stricter validation):

1. **Mark it in `CHANGELOG.md`.** Under `[Unreleased]`, lead the version with a
   **`### ⚠️ Breaking changes`** section (this exact heading — agents grep it). Each item **starts
   with the backticked entrypoint name(s) it breaks** (from the maturity table in
   `docs/guide/getting-started.md`), then states *what* broke, *why*, and a **before → after**
   snippet; an item breaking a **stable** entrypoint also cites its ADR. `release:check` refuses an
   item without the prefix or the required stable-entrypoint ADR citation. Release cadence
   is reported without a calendar limit (→ ADR 0198, ADR 0204):

   ```md
   ### ⚠️ Breaking changes

   - `stitchkit/tools` — **`createMcpHandler` no longer accepts `foo`** — it moved to `bar` because …
     `// before: createMcpHandler({ foo })` → `// after: createMcpHandler({ bar })` → ADR NNNN
   ```

   A version with **no** `### ⚠️ Breaking changes` section is purely additive — safe to adopt
   without code changes. (0.1.0–0.7.0 had none.)

2. **Bump minor** pre-1.0 (`0.7 → 0.8`) — the caret (`^0.7.0` = `< 0.8.0`) means a consumer never
   crosses a breaking minor on a plain `install`; the upgrade is an explicit opt-in. Post-1.0 a
   breaking change is a **major** bump.

3. **No deprecation shims / compat wrappers / aliases** (one clean path, PRINCIPLES I8). The
   consumers this repository's owner controls migrate in the **release wave**: after the version is
   published, following `docs/guide/upgrading.md` — never inside an unreleased batch, where the
   target they would migrate to does not exist on the registry yet. That migration review *is* the
   notification channel while consumers are few, and it is also the proof the recipe works.

4. The **upgrade flow** an agent follows to move a consumer across versions lives in
   [`docs/guide/upgrading.md`](../guide/upgrading.md) — keep it in sync if this convention changes.
   A generated project is a consumer too, and has its own channel:
   [`packages/create-stitchkit/UPGRADING.md`](../../packages/create-stitchkit/UPGRADING.md). That is
   where a scaffolder release's **operator** steps go — delete these supervisor processes, rename
   these variables — because a changelog entry carrying them is overwritten by the next release.
   Both channels are held by the same gate in `scripts/release-plan.ts`: a
   `### ⚠️ Breaking changes` section with no promoted `## Released migration: X.Y.Z` in that
   package's guide is refused.

## Which number moves

The minor is reserved as the *breaking* signal — that is what makes a consumer's caret
(`^0.56.0` = `< 0.57.0`) a real gate: crossing it is always an explicit opt-in, never a plain
`install`. Everything non-breaking is a **patch**, new API included: it is safe to auto-adopt by
construction, and spending a minor on it would strand consumers on the fixes shipped beside it
(0.48.1 added `stitchkit/testing`; 0.49.1 added `forceTimeoutMs`). So the question at release time
is not "is there a `### Added` section" but "is there a `### ⚠️ Breaking changes` section" — that
one alone moves the minor. The gate enforces it: a patch whose notes carry any breaking marker —
a heading that opens with `⚠️`, an item that opens with `Breaking`, or a `**Who must act:**` line —
is refused by `release:check`, whatever the section is called.

## Two packages, one train

Tag-driven and independently published (npm via OIDC trusted publishing + GitHub Releases), but
coordinated by one exact-tree release train. The tag flow lives in the
`.github/workflows/release.yml` header; `ci.yml` carries the branch and pull-request gate.

- **stitchkit:** bump only `packages/core/package.json`, roll the root `CHANGELOG.md`, add the
  target to `release-train.json`, then tag `vX.Y.Z`. CI checks the core version, publishes only
  `stitchkit` and reads the root changelog. Rolling the changelog adds a minor to the count in the
  maturity table (`docs/guide/getting-started.md`), which `scripts/surface-cadence.test.ts` derives
  from the changelog and holds by exact sentence — recompute both sentences with the test's own term
  lists and update the table and the test in the same commit, or the first `verify` after the roll
  is red.
- **create-stitchkit:** update the template's single `catalog.stitchkit` target and lockfile —
  `bun run update:starter` moves both and restores every `"stitchkit": "catalog:"` reference a raw
  `bun update` would dissolve — pass the planner-selected compatibility lane, bump only
  `packages/create-stitchkit/package.json`, roll its own `CHANGELOG.md`, promote every
  `## Unreleased migration:` heading in its own `packages/create-stitchkit/UPGRADING.md`, then tag
  `create-stitchkit-vX.Y.Z`. CI checks the scaffolder version and publishes only
  `create-stitchkit`.
- **stitchkit-tui:** declares `stitchkit` as a **peer** (`workspace:^`, and the same as a dev
  dependency for the workspace), so a project installs one framework, its own. `bun pm pack` freezes
  that spec into `^<core version>` at pack time, and pre-1.0 a caret holds one minor: **a core
  release outside the range the published `stitchkit-tui` froze carries `tui` in the same train.**
  `assertTrainCarriesItsCompanions` (`scripts/release-companions.ts`) refuses the train otherwise —
  in `release:check` and at push, from the repository's release tags. As a hard dependency the
  frozen range gave every project a second, older stitchkit beside its own once the framework moved
  on, which breaks `instanceof` across the package boundary.

The package versions never need to match. A framework release must not silently advance or publish
the starter; a starter release must target a Stitchkit range that already exists on npm — and its
**lockfile must resolve the newest published version that range allows**, which is a gate
(`scripts/starter-lockfile.ts`), not a habit. 0.4.1 shipped a `^0.60.0` range over a lockfile
pinning 0.60.0 on the day 0.60.1 existed: every manifest read as correct and a real scaffold
installed the previous framework. The registry is an external dependency of that gate, so an
unreachable registry is a refusal, never a silent pass. It also refuses a lockfile pinning a
version npm does **not** serve: the staleness comparison only looks downward, and a forward pin
would leave the scaffold to fail at `bun install` on someone else's machine.

**The starter rides in a LATER train than the framework it tracks.** A train that publishes core@X
and `create-stitchkit` together, where X satisfies the starter's range, is refused by
`assertTrainDoesNotOutrunTheStarter` — because the starter's lockfile is written by an install and
cannot name X until X is public, while the rule above requires exactly that once X exists. 0.6.1
rode in 0.90.6's train, passed every gate at push time because 0.90.6 was not published yet, and
became a scaffold on 0.90.5 one minute later. Release the framework, wait for npm, run
`bun run update:starter`, then tag the starter. A starter deliberately targeting an older minor is
outside this and still rides along.

## Order inside a release

`release-train.json` lists every package and version to publish. The `release(train): … in X.Y.Z`
commit carries release metadata only: versions, changelogs, the train, the lockfile, the promoted
migration heading and the maturity-cadence sentences. Every feature or fix is its own commit
before it, with a conventional subject and a body
([ADR 0237](../decisions/0237-release-commit-holds-metadata-only.md)).

```bash
# 1. Metadata, then the check that costs a second.
bun scripts/release-plan.ts prepare core@0.87.2 && bun install --ignore-scripts
bun run release:check
# 2. The release commit on its own branch. Nothing is published by this push.
git switch -c release/0.87.2   # created before the feature commits
git commit -m 'release(train): publish core in 0.87.2'
git push -u origin release/0.87.2
# 3. Wait for the push run of ci.yml for this exact SHA (see below).
# 4. Fast-forward master to the proven SHA, then tag it.
git push origin HEAD:master
bun run release:train
```

`release:train` ends by retiring every `release/…` branch, local and on `origin`, whose tip the
tagged head already contains; the tag is the lasting record. An unreleased branch is never
touched, and a failed cleanup is reported without failing the release.

`release:check` runs the metadata gate the push runs, against the working tree: version against
manifest and lockfile, breaking section against its `**Who must act:**` line and the version
calibre, the promoted migration heading, breaking-entry metadata (ADR 0198, ADR 0204), and that
each package differs from its previous release. It refuses a package whose packed closure — its
directory minus tests and the changelog, plus the guides and scripts that build its tarball — is
unchanged since the previous tag except for the version: an npm version is permanent, and a
release of identical files gives every consumer an update that changes nothing.

Step 4 does not re-run the gate: the SHA already has a green push run, and `pre-push` asks GitHub.
The master push of that SHA starts an empty CI run. Where a release commit goes straight to master
instead, the full local gate runs first, because pushing it there publishes it. Pushing the release
commit to master before it is green forces the tag onto whatever lands next. Two gates hold the
shape, both in the publishing workflow so neither depends on local hooks: `assert-head` keeps the
tag on the master head, and `assert-subject` requires the head to be the release commit of a train
that selects the tag's package and version, or fix commits with their own types stacked on it. The
release commit must be non-empty and metadata-only; a fix commit must be non-empty. `pre-push`
runs the subject and metadata checks earlier and does not run `assert-head`, which needs the remote
head.

If a pushed release commit's run goes red, land a fix commit on the branch with its own type, wait
for a green run of the new head, and tag it, or make a new release commit on top. Tagging a red
SHA is refused because the tag needs a green push run for the tagged SHA itself.

## Waiting for the green run — the query has to be able to answer

Between pushing the release commit and tagging it there is exactly one thing to wait for: the
**push** run of `ci.yml` for that **exact SHA**. Ask for it the way the publishing workflow itself
does, and give it the full forty-character SHA:

```bash
SHA="$(git rev-parse HEAD)"
gh api "repos/<owner>/<repo>/actions/workflows/ci.yml/runs?head_sha=$SHA&status=completed" \
  --jq '.workflow_runs' | bun scripts/release-plan.ts select-ci-run "$SHA"
```

`gh run list --commit "$SHA" --json status,conclusion` and
`gh run list --branch master --json headSha,status,conclusion` (filtered on `headSha`) answer the
same question. All three need the **full** SHA.

**`gh run list --commit` with a short SHA returns `[]`.** No error, no warning — the same empty
list a commit with no runs yet would give. A poll loop built on it therefore waits forever while
the run it is waiting for is already green, and reports "still running" the whole time. That is not
a `gh` quirk to remember so much as an instance of a rule worth applying to every wait: **run the
query once against a case whose answer you already know before you start waiting on it.** An empty
result from a filter you have never seen return a row is not evidence that the event has not
happened.

## Releasing several packages from one tree

Put every target in `release-train.json`; one `release(train)` commit carries the complete green
tree and every selected tag points at it. `assert-head` and manifest membership refuse a tag on
another commit or a package/version absent from the train. Publication remains independent per
package, but validation is paid once per tree rather than once per tag. →
[ADR 0136](../decisions/0136-one-exact-tree-drives-a-package-aware-release-train.md).

## Bounded registry visibility

The publication job has a 45-minute ceiling. Its idempotent tarball publication step has
10 minutes, followed by a separate registry visibility step with a 30-minute monotonic
deadline and one minute of workflow shutdown grace. Every fetch, response body and sleep
is bounded by the remaining deadline; an exact response arriving after it is refused.
Matching existing tarball bytes remain a valid rerun; different bytes at one version refuse
publication. These budgets bound failure; they are not measured registry latency.
