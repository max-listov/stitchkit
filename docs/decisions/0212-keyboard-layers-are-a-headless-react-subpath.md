---
title: "ADR 0212: Keyboard layers are a headless React subpath"
description: "Which part of a screen gets a key is decided by one window listener over ordered layers, and lists move real focus; it ships as the isolated subpath stitchkit/react/keyboard with react as its only peer — no component, no router, no new package."
type: decision
status: accepted
created: 2026-09-29
updated: 2026-09-29
---

# ADR 0212 — Keyboard layers are a headless React subpath

## Context

A consuming project with a keyboard-driven workspace — sections switched with
← and →, lists walked with the arrows, Escape closing one level at a time — had
built that behaviour itself, and measured what such code tends to become:

- one "highlighted" id shared by every list on the page, and highlight instead
  of focus: no roles, no `aria-activedescendant`, no scrolling to the item in
  most lists, nothing a screen reader could follow;
- Escape caught by two independent `document` listeners whose order was the
  order they mounted in, neither preventing the default of what it handled;
- seventeen more hand-written `keydown` listeners beside the system, each with
  its own guard for text fields.

A second project carried the same arrows-and-guard code in its feed list, and a
third its own grid navigation. The logic is small and the defects are the same
everywhere: the question "who gets this key" has no owner.

stitchkit does not own frontend routing or rendering (ADR 0060), and the terminal
UI moved out of core because it brings a renderer (ADR 0133). The question here
is neither: it is not where the user is, and it draws nothing.

## Decision

**Keys go to layers on one stack, asked in a fixed order.** One listener per
window, in the bubbling phase, asks the live layers `overlay` → `local` →
`route` → `zone` → `global` until one takes the key; a live overlay is a barrier
for everything below it. Within a kind the innermost layer wins — by element
containment when both are scoped, else by activation order — because React runs
a child's effects before its parent's and activation order alone would let a
page shadow the panel inside it. Being in the bubbling phase is what makes this
safe beside other components: a widget, a field or a popover hears the key first
and keeps it with `preventDefault` or `stopPropagation`. Keys typed in fields
pass layers by, except Escape; a held Escape closes one level.

**A list is a zone with real focus.** Roving `tabIndex`, arrows moving DOM focus,
`listbox`/`tablist` roles or the items' own semantics with `aria-current`, each
zone with its own pointed item. Modes `select` and `highlight`, the cross axis
as `onEnter`/`onExit`, the ends as `onBoundary` or a loop. A key the zone does
not take bubbles on to the layers.

**It is headless and owns no location.** Three hooks — `useKeyLayer`,
`useEscapeLayer`, `useNavZone` — and no component, no provider, no styles. A
layer calls the application's functions; nothing reads or writes the URL, so
ADR 0060's boundary holds: the router, sections and rendering stay in the
application.

**It is an isolated subpath of core, not a package (I7, I8).** `react` is already
an optional peer of core and `stitchkit/react` already a subpath; the entrypoint
registry, the optional-peer matrix on the packed artifact and the surface gates
already prove a leaf like this one. A separate package would add a release
target to every piece of the release machinery for the same result, and the
reason ADR 0133 moved the TUI out — a renderer in core — does not apply to
hooks that render nothing. No list library is taken on either: roving focus is
a few dozen lines, and a new peer for them would cost every consumer more than it
saves.

**The logic has no framework in it.** The stack and the zone are plain objects
driven by tests without a DOM; the hooks bind them to React and are tested in a
rendered DOM.

## Consequences

- Applications drop their own `keydown` listeners for layers and zones; a
  component library can register its dialogs as `overlay` layers so that Escape
  is right without the application doing anything.
- A screen gets accessibility it did not have — focus, roles, names — as a side
  effect of using the zone, not as separate work.
- Global shortcut registries, key-combination parsing and grid (two-axis)
  navigation are out of scope; a layer's `onKey` receives the event and decides.
- The entrypoint starts evolving (ADR 0103, ADR 0198).
