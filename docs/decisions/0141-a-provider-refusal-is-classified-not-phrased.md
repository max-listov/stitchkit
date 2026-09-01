---
title: "ADR 0141: A provider refusal is classified, not phrased"
description: The core names which provider failure occurred and what evidence says so; the sentence a user reads stays with the application.
type: decision
status: accepted
created: 2026-09-01
updated: 2026-09-01
---

# ADR 0141 — A provider refusal is classified, not phrased

## Context

Three independently maintained consuming applications carry the same 69-line
file for turning a provider failure into something a person can read. Two copies
are byte-identical but for one `catch`; the oldest carries
`LIBRARY FILE: no project-specific imports` in its header — the author knew it
was a library and had nowhere to put it.

The runtime reported `provider_failure` and kept the provider's envelope, and
said nothing about *which* failure. Running out of credits, being rate limited
and naming a model that does not exist are three situations with three different
next moves — top up, wait, choose another model — and all three arrived as one
word. So each application derived the taxonomy again from its own traffic, and
they disagree on details that only production reveals.

This is not a domain model (→ ADR 0002): "the provider answered 402" is a fact
about the provider, not about anyone's business. The core is where that answer
arrives, and it is the only place that sees it.

## Decision

**The core classifies; the application phrases.**

`classifyProviderFailure` returns the reason, the status when the provider gave
one, whether the same request could work unchanged, and — the part that makes
the rest usable — **the evidence the answer rests on**. A status code is the
provider stating its own answer. A message match is us reading its prose, which
changes without notice and differs between providers. `none` is an honest
refusal to guess. A caller deciding whether to retry automatically needs to know
which of the three it got, and a classifier that hides that difference invites
exactly the automation that should not be built on prose.

The sentence stays with the application. Its tone, its language and its decision
about what to admit to a user are product choices; a core that wrote them would
be answering a question nobody asked it, and every consumer would immediately
need to override the wording anyway.

`retryable` separates waiting from rewriting: a rate limit can pass, and an
oversized prompt repeated unchanged fails identically forever. An unrecognised
failure is **not** retryable — a retry loop built on a guess is how one broken
request becomes a bill.

`isToolResultFailure` covers the other half of the copied file: a tool can
answer `200` with `{ error: … }`, and a loop reading only the transport counts
that as work done.

## Consequences

- Both are plain functions with no runtime dependency, which is the point: the
  application that hand-rolls its model loop is exactly the one that copied this
  file, and a primitive it cannot reach without adopting the whole runtime would
  not have helped it. → the same reasoning exported
  `normalizeOpenRouterUsage`.
- The message table is a fallback and is documented as fragile. It runs only
  when no status survived, and it reports itself as prose-derived.
- What did **not** come along: extracting an ORM's error text out of a tool
  failure. That is one consumer's persistence layer showing through, and it
  belongs to that consumer.
