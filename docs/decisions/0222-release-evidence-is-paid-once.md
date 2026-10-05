---
title: "ADR 0222: A release candidate pays for evidence once"
description: "Full exact-SHA CI authorises publication; the local candidate passes the fast gate, and a full local result separately confirms the fast subset."
type: decision
status: active
created: 2026-10-01 15:43 +07:00
updated: 2026-10-01 15:43 +07:00
---

# ADR 0222 — A release candidate pays for evidence once

## Decision

The candidate is pushed to `release/X.Y.Z` after the metadata preflight and the
fast gate. The full set of selected CI lanes checks the exact SHA before the
fast-forward of master and the tag. The full portable local gate stays a diagnostic
tool and protects an unverified direct release push to master.

A green full or selected release gate stores a separate fast attestation, but only
if it ran every fast step, including the frozen-lockfile install. The fast key
contains tree/runtime; the heavy-evidence key also contains the PostgreSQL/browser
environment. A change of environment does not cancel the lint/types/tests evidence,
but never allows heavy evidence from another environment to be reused.

The core publication artifact is built once through the existing `prepack`.
All build checks and the real Darwin qualification stay. The tag workflow publishes
the immutable artifact of the successful exact-SHA push CI.

## Why

A sequential full local run before the same full CI repeats the portable evidence.
The release branch allows a red candidate to be fixed before publication; a
separate local heavy run does not change the publication authority. An incomplete
fast subset and mismatched fingerprints are not evidence for skipping the fast gate.

## Limits

The privacy scan runs on every push. A red CI, a different SHA, a missing artifact
and mismatched published bytes forbid confirming the release. The full local gate
is available explicitly; CI coverage, OIDC and the protected publication
environment are not weakened. The time of upload acceptance and of real npm
availability is measured separately; shorter polling does not speed up the
registry's processing.

Serves P.
