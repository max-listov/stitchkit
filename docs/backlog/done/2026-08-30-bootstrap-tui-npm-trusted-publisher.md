---
title: Bootstrap the TUI npm package and bind its trusted publisher
description: Publish the first stitchkit-tui registry version, then hand all later releases to the existing OIDC workflow.
type: task
status: done
created: 2026-08-30
updated: 2026-08-31
completed: 2026-08-31 17:12 +00:00
priority: P0
---

## Why

The exact `stitchkit-tui-v0.1.0` release SHA passed CI and produced the validated
`stitchkit-tui-0.1.0.tgz`. The GitHub release workflow obtained OIDC provenance but npm refused
the first package PUT with `E404`: the package used the unavailable `@stitchkit` organization
scope. The repository and `npm-production` environment contain no publish token, and the release
machine has no interactive npm session.

npm's trust contract requires the package to exist before `npm trust github` can bind a workflow.
The public package identity is therefore the available unscoped `stitchkit-tui`, consistent with
`stitchkit` and `create-stitchkit`; `@stitchkit` is not an owned namespace. The first publication
needs one interactive 2FA-authenticated bootstrap from the exact CI artifact. Later versions
remain tokenless OIDC publications.

## Почему это не icebox

Icebox is for work frozen by choice, with a defrost condition. This is neither:
it is a P0 with one open step, and the step is an action only the repository
owner can take — an interactive 2FA npm session to bind the trusted publisher.
Parked in icebox it was invisible to the backlog conveyor, which never reads
that directory, while the next `stitchkit-tui-vX.Y.Z` tag would fail at
`npm publish` exactly as `0.1.0` already did.

**Blocked on:** the repository owner, running exactly this in an interactive
shell — the runtime cannot, because npm raises a separate browser 2FA challenge
that a release runner has no way to answer, and no publish token is kept
anywhere on purpose:

```bash
npm trust github stitchkit-tui \
  --file release.yml \
  --repo max-listov/stitchkit \
  --env npm-production \
  --allow-publish
```

**How to tell whether it is already done, without asking anyone.** The registry
does not expose the binding, but it exposes its consequence — an OIDC
publication carries a provenance attestation and a manual one does not:

```
npm view stitchkit@0.70.6    dist --json | jq -r 'keys[]'   # → attestations …
npm view stitchkit-tui@0.1.1 dist --json | jq -r 'keys[]'   # → no attestations
```

Measured 2026-08-31: `stitchkit` has `attestations`, `stitchkit-tui` does not —
`0.1.1` was the interactive bootstrap. This task closes when the next
`stitchkit-tui-vX.Y.Z` publishes from the workflow and its `dist` carries
`attestations`. Nothing in the repository changes either way: the workflow is
already written for OIDC.

## Plan

- [x] Build and validate the exact TUI tarball in clean exact-SHA CI.
- [x] Download the CI artifact and verify its SHA-1 is
      `7dfbd10bd14c9bef18426cd9d48b9d6893c05c68`.
- [x] Cut the complete public package/import surface over to `stitchkit-tui` without aliases.
- [x] Publish the exact `0.1.1` CI tarball as public through an interactive npm session.
- [x] Bind `max-listov/stitchkit`, `release.yml`, environment `npm-production` as the package's
      trusted GitHub publisher with publish permission.
- [x] Run the corrected `0.1.1` tag workflow, verify npm and GitHub Release, then continue the
      starter release conveyor.

## Acceptance

- [x] `npm view stitchkit-tui@0.1.1 dist.shasum` equals the validated CI artifact SHA-1.
- [x] The tag workflow completes successfully and creates the GitHub Release.
- [x] No long-lived npm publish token is added to the repository or GitHub environment.

## Current blocker

The package and its corrected `0.1.1` release are public and verified. Only the optional future
OIDC binding remains: `npm trust github stitchkit-tui --file release.yml --repo
max-listov/stitchkit --env npm-production --allow-publish` reaches npm's separate browser 2FA
challenge, which cannot be completed by the non-interactive release runtime. Thaw this task when
the package owner is present to approve that browser challenge; no source or release change is
needed.

## Publication evidence

- Package `stitchkit-tui@0.1.1`, SHA-1 `45e1b57f8876a64174b3bfdcec793c7c11d0f125`, integrity
  `sha512-Ub4RJiiwGLVqf6fr0Iu3LA+j0ICfiFep+1Jggh5foAR3ZP0+4eXKDsR5sZNXvrEbPWT4Bnwwz008QcUhVhruog==`.
- Source/tag SHA `80b3e9162c974585e7d947fea7730bef1acf5d78`; exact-SHA CI `33311720156`; successful
  release workflow `33312857100`; GitHub Release `stitchkit-tui-v0.1.1`.
- Trusted publisher binding still requires npm's separate browser 2FA challenge; the CLI session
  reached that challenge without exposing or creating a publish token.

## Что сделано

Verified directly, not inferred. `npm trust list stitchkit-tui`, run by the owner
on 2026-08-31 after authenticating the CLI through its browser link, returns the
binding with every required parameter matching:

```
type: github
id: 8d43fd42-e777-4aa9-972d-5d2e7986fe07
file: release.yml
repository: max-listov/stitchkit
environment: npm-production
permissions: publish
```

### Что стоило времени и почему

- [x] The two `npm trust github …` attempts that failed with `E401 Unauthorized —
      You must be logged in to publish packages` were **not** a problem with the
      command or the binding. `npm whoami` on the release host returned `E401`
      and `~/.npmrc` carried no auth token: there was simply no npm session.
      `npm trust list` then asks for the browser authentication that creates one.
- [x] The check itself is not performable by an agent on this host, and that is
      by design rather than an obstacle: reading or creating a trust binding
      requires the owner's second factor. An agent can verify the *consequence*,
      never the binding.

### Что остаётся наблюдаемым

The first `stitchkit-tui` version published **from the workflow** will carry a
provenance attestation, which is checkable without any session:

```bash
npm view stitchkit-tui@<next> dist --json | jq -r 'has("attestations")'
```

`0.1.1` will never gain one — it was the interactive bootstrap, and provenance is
not added retroactively. Its absence says nothing about the binding.

### Что не сделано

- [x] No long-lived npm publish token was added to the repository, the
      `npm-production` environment or the release host — the whole point of the
      binding, and still true.
