---
title: Composable terminal host
description: Layering, state ownership and lifecycle boundaries for the optional terminal package.
type: architecture
status: active
created: 2026-08-30
updated: 2026-11-04
---

# Composable terminal host

`stitchkit-tui` is an optional package with four ownership layers:

| Layer | Owns | Does not own |
| --- | --- | --- |
| `stitchkit-tui/core` | pure state: collections, feed, panes, commands, operations, tables, lists, forms, tabs, navigation, focus, notices, charts, meters, progress, keymaps, text measurement and sanitizing, palettes, labels | React, OpenTUI, agent records, processes |
| `stitchkit-tui/widgets` | OpenTUI React widgets over that state: app shell, panels, status bar, key hints, table, list, form, text and JSON viewers, meters, charts, tabs, spinner, progress, dialog, details, notices | the agent runtime, domain data, the application's screens |
| root `stitchkit-tui` | official OpenTUI agent projection, controller and authenticated local attachment | provider policy, tools, process supervision |
| embedding application | model catalog, context, harness composition, workspace and terminal product shell | durable agent transitions already owned by the harness |

The core entrypoint imports only Zod. The widgets entrypoint adds React and OpenTUI, which the
application provides as peers so one copy of each drives its tree; it never loads `stitchkit`, so a
monitor or a CLI front-end installs no agent runtime. Importing the root entrypoint opts into the
maintained agent application. `tests/import-graph.test.ts` holds these directions.

`stitchkit-tui-gallery` renders every widget live — a method catalogue (sections, fuzzy search,
form, confirmation, spinner, JSON result, toasts), a process monitor and the small widgets — in
both palettes and both bundled languages. It is the reference for what the kit offers.

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

### Tables, lists and forms

A table keeps its rows, sort, expanded keys and filter, and stores the projection the screen draws,
so a data update, a sort and the selection move in one transition: there is no frame with a new
order and an old selection. Equal values tie on the row key, so rows at rest never trade places;
a missing value sorts last in both directions and shows `—`. Collapsing a row over the selection
moves it to that row; expanded keys of rows that left the data are forgotten, so a monitor that
runs for days holds only the expansion of rows that exist.

A list groups items under sections; a query flattens them and ranks matches (substring before
scattered letters, word starts before middles) with the ranges to highlight. A form reads its
fields from a JSON Schema (string enums become choices, `password` a secret, structured values
JSON) and shows a field's error once the reader leaves it or submits. Text edits are relative
actions (`insert`, `erase`), so keys arriving faster than renders — a paste — all land.

### Keys, focus and words

A keymap is data: the same bindings answer keys and draw the footer, which shortens labels and then
drops the least important hints to fit the width. Focus is a ring of widget ids plus layers; a
dialog opens a layer, takes the keyboard and returns it to the widget that had it. Every word a
widget draws comes from `TerminalLabels` (English and Russian are bundled), and every piece of
foreign text passes `sanitizeTerminalText`, so an escape sequence in data never reaches the
terminal as a command.

### Long-lived screens

React's development build records a performance measure, with a props diff, for every component
render, and Bun keeps them all: a table re-rendered once a second grew the process by about 150 KB
a tick. The bundled binaries set `NODE_ENV=production` before React loads; an application that
renders a live screen does the same. In production the 1 000-row monitor fixture held its resident
size flat over ten minutes of one-second updates.

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
