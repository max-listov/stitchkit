---
title: "0269 — Compaction evidence does not settle effects"
description: Failed-turn evidence, provider chronology and effect receipts have separate authority.
type: decision
status: accepted
created: 2026-10-25
---

# Compaction evidence does not settle effects

## Context

The default history evidence policy omits failed assistants. Compaction selects a
contiguous complete prefix, so an omitted failed turn also protects completed turns after
it. The existing explicit `assistant-marked` policy admits that failed evidence once the
whole tool chronology is complete. A summarizer receives raw records; a failure that has
no provider content must still be identifiable when those records are projected.

A matching error tool result can close the provider exchange while its external effect
remains uncertain. Treating those two facts as one would either repeat a side effect or
block compaction permanently for a receipt the canonical journal already retains.

## Decision

Keep the existing selector and explicit shared evidence policy. Default omission remains
a barrier. Every opted-in failed assistant, including an empty one, projects a non-success
marker. The summarizer owns its schema and prompt and must preserve failed and uncertain
outcomes rather than promote partial evidence to success. A record that cannot be safely
projected is a reason to refuse that summary, not to delete the record from its range.

Compaction replaces one exact contiguous history range under snapshot CAS; it does not
erase canonical events, effect proofs or retained terminal admission receipts. Effect
recovery keeps using its original conversation/run/name identity: accepted returns the
proof, intent reconciles, uncertain never repeats the effect. A new identity is new work,
and a standalone caller still owns its exclusive execution lease.

## Consequences

Applications can explicitly compact settled failed turns without rewriting statuses,
inventing another selector or losing effect recovery. Incomplete tool exchanges remain
barriers. Provider-valid chronology is not proof that an external operation succeeded,
failed or is safe to retry. The model's summary never becomes execution authority.
