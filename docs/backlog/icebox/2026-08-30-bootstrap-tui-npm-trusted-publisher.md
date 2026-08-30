---
title: Bootstrap the TUI npm package and bind its trusted publisher
description: Publish the first stitchkit-tui registry version, then hand all later releases to the existing OIDC workflow.
type: task
status: icebox
created: 2026-08-30
updated: 2026-08-30
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

## Plan

- [x] Build and validate the exact TUI tarball in clean exact-SHA CI.
- [x] Download the CI artifact and verify its SHA-1 is
      `7dfbd10bd14c9bef18426cd9d48b9d6893c05c68`.
- [x] Cut the complete public package/import surface over to `stitchkit-tui` without aliases.
- [x] Publish the exact `0.1.1` CI tarball as public through an interactive npm session.
- [ ] Bind `max-listov/stitchkit`, `release.yml`, environment `npm-production` as the package's
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
