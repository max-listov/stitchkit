---
title: Bootstrap the TUI npm package and bind its trusted publisher
description: Publish the first stitchkit-tui registry version, then hand all later releases to the existing OIDC workflow.
type: task
status: in-progress
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
- [ ] Publish the exact `0.1.1` CI tarball as public through an interactive npm session.
- [ ] Bind `max-listov/stitchkit`, `release.yml`, environment `npm-production` as the package's
      trusted GitHub publisher with publish permission.
- [ ] Rerun failed release workflow `33306836593`, verify npm and GitHub Release, then continue the
      starter release conveyor.

## Acceptance

- [ ] `npm view stitchkit-tui@0.1.1 dist.shasum` equals the validated CI artifact SHA-1.
- [ ] The tag workflow completes successfully and creates the GitHub Release.
- [ ] No long-lived npm publish token is added to the repository or GitHub environment.

## Current blocker

The package bytes and authentication are not the failure. The first PUT challenged for web
authentication, completed it, and then returned `404 Not Found` because `@stitchkit` is unavailable.
The immutable failed `0.1.0` tag remains historical; publication continues from a new `0.1.1`
release commit and tag under the unscoped `stitchkit-tui` identity.
