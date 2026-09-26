---
title: Release process — breaking changes, versions and the release train
description: How a breaking change is marked and migrated, which number moves, and the order of a release with the incidents that shaped each step.
type: architecture
status: active
created: 2026-09-23
updated: 2026-09-23
---

# Release process — breaking changes, versions and the release train

The rules are one line each in [`AGENTS.md`](../../AGENTS.md); this page holds the full protocol
and the incidents behind it. Much of it is scar tissue from runs that went wrong. The CI graph and
the exact-SHA publication boundary are in [`ci-release.md`](./ci-release.md); which local gate a
push earns is in [`gates.md`](./gates.md).

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
one alone moves the minor.

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

`release-train.json` lists every package/version to publish. The `release(train): …` commit is the
LAST commit of the release. Land every fix first, then:

```bash
# 1. Everything the release commit will carry: version bumps, release-train.json,
#    the changelog section, the promoted migration heading. Then, in one second:
bun run release:check
# 2. The commit, on its own branch. Nothing is published by this push.
git switch -c release/0.87.2 && git commit -m 'release(train): publish core in 0.87.2'
git push -u origin release/0.87.2
# 3. Wait for the push run of ci.yml for this exact SHA (see below).
# 4. Fast-forward master to the proven SHA, then tag it.
git push origin HEAD:master
bun run release:train
```

`release:check` runs the same metadata gate the push runs, against the working tree, before
anything expensive: version against manifest, breaking section against its `**Who must act:**`
line and against the version calibre, the promoted migration heading, and breaking-entry
metadata (ADR 0198, ADR 0204). It costs a second, and the mistake it catches otherwise costs a whole gate run —
editing `release-train.json` after a green local gate invalidates the memo, and 0.87.0 paid
exactly that.

Step 4 does not re-run the gate: the SHA already has a green push run, and `pre-push` asks GitHub
rather than assuming. It does start a second CI run, on master, for a SHA already proven on the
branch — expected, and deliberately not suppressed: nothing waits for it, and the alternative is a
network call inside the one job every other job waits on. Where a release commit goes straight to
master instead, the full local gate runs first, because pushing it there publishes it. Pushing the
release commit to master before it is green forces the tag onto whatever fix lands next —
`git show <tag>` then points at the wrong change, and the release commit keeps a red run forever
(that is what 0.55.0 did). Two gates hold the shape, both in the publishing workflow, so neither
depends on local hooks: `assert-head` keeps the tag on the branch head, and `assert-subject`
requires that head to be a `release(train): …` commit whose manifest selects the tag's own package
and exact version. The `pre-push` hook runs the **subject** check earlier, before the expensive
gate; it deliberately does not run `assert-head`, which needs the remote head and belongs where the
remote is authoritative. So a tag pointing at a superseded release commit passes `pre-push` and
fails in the workflow — after the tag is already pushed, and a published tag is never moved. Tag
the head.

If a release commit is already pushed and its run goes red, the fix does not become taggable: land
the fix, then make a **new** release commit for the same version on top of it (or bump the patch),
and tag that. Recovering by tagging the fix itself is exactly the shape these gates refuse.

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
