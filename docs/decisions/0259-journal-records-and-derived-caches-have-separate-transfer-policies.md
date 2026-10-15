---
title: "ADR 0259: Journal records and derived caches have separate transfer policies"
description: "Persisted streaming records share one vocabulary while branches discard application caches and restore history through replay."
type: decision
status: accepted
created: 2026-10-15 13:27 +07:00
updated: 2026-10-15 13:36 +07:00
---

# ADR 0259 — Journal records and derived caches have separate transfer policies

**Invariants:** I3, I8, I12, I13, I15.

## Context

A runtime checkpoint input contains the complete streaming assistant. Its persisted journal
record retains a hash, byte count and numeric part count to bound repeated draft storage. A
SQLite conversation export also carries materialized application projections beside the runtime
snapshot. Treating every projection as a snapshot, or every journal record as an executable
mutation, refuses an ordinary export created by the runtime itself.

## Decision

`AgentStoreTransitionRecordSchema` describes persisted full transitions and shortened checkpoint
observations. The writer and branch replay share its checkpoint schema. Executable mutations keep
their existing `AgentStoreTransitionSchema`. Inspection establishes shape; branch still validates
the entire source, exact settled boundary and reference closure before writing.

Companion projections use one envelope schema shared with SQLite import. A branch checks envelope
shape, unique names and checkpoints within the journal, then discards their application-defined
cache values. Destination projections fold from its rekeyed ledger. State and effect events remain
inert observations, never live rows or authority. A later companion cache cannot affect an earlier
selected prefix.

Archive import and branch share the writer for replayed history, run and admission effects. This
retains compacted history absent from the active snapshot. Branch additionally clears execution
owners and fences; ordinary same-identity import retains its operational snapshot and exact live
draft. Unknown opaque journal fields still refuse before a branch mutates its destination.

## Consequences

Existing SQLite schema v4 exports remain branchable without application journal edits. A
consumer can inspect both checkpoint forms using the public record contract. A branch does not
copy opaque application caches; it rebuilds projections from historical facts under the new
identity. The installed consumer proof exercises fresh and public 0.109.4 streaming archives on
Bun and Node, with tools, compaction, artifacts and inert state/effect observations.

