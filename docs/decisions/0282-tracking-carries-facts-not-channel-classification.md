---
title: "ADR 0282: Tracking carries facts, not channel classification"
description: Attribution separates raw campaign tags, referrer and configured click-marker names; the application classifies channels on the server.
type: decision
status: accepted
created: 2026-11-04 15:58 +07:00
updated: 2026-11-04 15:58 +07:00
---

# ADR 0282 — Tracking carries facts, not channel classification

Amends the attribution clause of [ADR 0166](0166-tracking-mechanics-in-core-storage-and-domain-outside.md).
Serves **I3**, **I4**, **I13**.

## Context

A consuming application classifies channels on its server so the browser need not carry a host database.
Putting an inferred source and medium into `utm` erases the distinction between a campaign tag and a guess
from a referrer. The server then either trusts a second classifier or loses the original evidence.

## Decision

The browser carries actual `utm_*`, a referrer and an optional click-marker name. It does not classify a
source, medium or channel. Campaign tags retain their case and whitespace within the wire limit; a tag
without a source is still a fact. Credentials are masked before the client stores or sends them.

The application configures an ordered `clickIdParams` list. The first configured parameter with a nonempty
value becomes `clickId`; the value is discarded, and masked wherever the referrer repeats it — a referrer
from the same site carries the landing query in full. The framework has no built-in marker or referrer list.
Both the attribution schema and the visit-entry schema carry the same optional marker field.

First-touch persists with its capture time and TTL. Current-touch is the current capture's raw context,
without a previous campaign filled in. Last-non-direct retention is application policy. A versioned storage
format invalidates unversioned attribution because the provenance of its campaign tags is unknowable.
Unavailable storage does not prevent bootstrap from collecting current facts.

Attribution is a fact of the visit's entry, so the visit bootstrap carries it and an event batch does
not. A batch-level campaign would describe the page at the moment of sending rather than the page its
events happened on, and after a navigation the landing page's events would arrive without their campaign.

## Alternatives

- A separate client-classification field: rejected because it preserves two classifiers and requires the
  browser to carry application data that the server already owns.
- Retaining inferred tags under `utm`: rejected because downstream code cannot recover their provenance.
- Keeping a built-in list of advertisement parameters: rejected because recognised markers are application
  policy and can change independently of the tracking transport.

## Consequences

Consumers remove `referrerMap`, `ReferrerRule`, `parseReferrer` and the resolver's `hostname`. Existing stored
first-touch resets once. Browser storage is optional; without it first-touch cannot persist across captures.
`tests/tracking-attribution.test.ts` exercises the client through HTTP bootstrap, alongside direct storage,
TTL and marker controls. The browser entrypoint imports no Zod and stays under its size ceiling.
