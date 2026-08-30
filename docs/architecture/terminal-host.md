---
title: Composable terminal host
description: Layering, state ownership and lifecycle boundaries for the optional terminal package.
type: architecture
status: active
created: 2026-08-30
updated: 2026-08-30
---

# Composable terminal host

`stitchkit-tui` is an optional package with three ownership layers:

| Layer | Owns | Does not own |
| --- | --- | --- |
| `stitchkit-tui/core` | pure collection, feed, pane, command and operation state | React, OpenTUI, agent records, processes |
| root `stitchkit-tui` | official OpenTUI agent projection, controller and authenticated local attachment | provider policy, tools, process supervision |
| embedding application | model catalog, context, harness composition, workspace and terminal product shell | durable agent transitions already owned by the harness |

The core entrypoint imports only Zod. A session supervisor can keep its own renderer, cards,
process identities and lifecycle actions while reusing the state machines. Importing the root
entrypoint opts into the maintained agent application and its OpenTUI/React dependencies.

## State machines

### Live collection

Caller-owned keys are the identity source of truth. Reconciliation preserves the selected key
through sorting and insertion. If it disappears, the element at the same previous position wins,
clamped to the nearest survivor. The visible window moves only enough to reveal keyboard selection;
manual scroll may move the window without changing identity.

### Feed viewport

`followTail` distinguishes watching live output from reading history. Append follows only while the
reader is at the tail; otherwise it increments `unseen`. Prepending history preserves the visible
anchor. `end` is the explicit transition back to live following.

### Panes

Split mode enforces caller-declared minimum sizes. When the terminal cannot contain both panes the
state becomes single-pane and exposes only the focused pane. The consumer retains both panes' domain
state and chooses when enough width permits split mode again.

### Commands and operations

Command names and aliases are validated together and collisions fail before rendering. Filtering
may select a candidate, but dispatch resolves only an exact name or alias. Confirmed operations
move through `idle → confirming → pending → succeeded|failed`; a pending operation refuses a second
request until it settles or the consumer resets its terminal result.

## Runtime and process boundary

The root agent host has one controller over one `HeadlessAgentHarness`. External clients submit and
interrupt through its authenticated Unix socket instead of creating another runtime writer.
Descriptors are accepted as live only after an authenticated status response proves the session ID;
a PID alone is not identity. Every ordinary launch creates a fresh conversation, while explicit
resume selects durable history.

Recovery resumes queued work. Acquired work is skipped unless the embedding host provides positive
replay evidence. Approval continuation reads its model from the admitted durable input, not from a
later interactive selection. Shutdown destroys terminal input ownership first, then closes the
socket, harness and diagnostic journal through one idempotent promise.

Process placement, restart policy, native provider adapters, fleet routing and operating-system
isolation remain outside Stitchkit. A supervisor composes the published harness and core primitives;
it never needs a copied inference loop or a generic execution gateway.
