---
title: "ADR 0295: Quiet suppresses profile selection notices"
description: The default sole-profile notice follows the CLI invocation's quiet setting, including selection before discovery.
type: decision
status: accepted
amends: ["0186"]
amendedBy: ["0310"]
created: 2026-11-20 00:37 +08:00
updated: 2026-11-23 15:48 +08:00
---

# ADR 0295 — Quiet suppresses profile selection notices

Amends the announcement clause of [ADR 0186](0186-the-cli-owns-its-own-distribution.md)
and serves **I8** and **I9**.

## Context

A CLI can resolve a profile before calling `createCli` because it needs the
credential to discover its commands. The notice for an inferred profile is
informational. The refusal of a missing or unreadable profile is actionable.

## Decision

`--quiet` suppresses the default notice for a sole profile whenever the caller
omits a profile name. Early selection uses the process arguments and the same
reserved boolean grammar as the CLI (amended by [ADR 0310](0310-one-model-for-cli-invocation-and-json-schema-keywords.md):
projected from `scanCliInvocation`, rejecting unknown inline boolean values before
emitting profile notices). Inside `createCli` the notice uses the
invocation's own arguments and stderr sink. That scope lets concurrent embedded
invocations use different settings in the same process.

An explicit name resolves to that profile or produces a refusal. Profile
refusals keep their existing reporting and exit codes. The application owns
the output of a supplied `announce` callback.
