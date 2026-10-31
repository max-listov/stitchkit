---
title: "ADR 0212: Keyboard layers are a headless React subpath"
description: "Which part of a screen gets a key is decided by one window listener over ordered layers, and lists move real focus; it ships as the isolated subpath stitchkit/react/keyboard with react as its only peer — no component, no router, no new package."
type: decision
status: accepted
created: 2026-09-29
updated: 2026-10-31
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

## Amendment (0.114.1): what the first large adoption needed

A large application moved its list navigation onto the zone and reported what it
had to work around. Each point is additive; the decisions above stand.

- **A third mode, `focus`, instead of a flag on `highlight`.** `mode` already
  names what moving means. In `highlight` the zone owns Enter, so a list of links
  or buttons lost its native click and the page wrote `document.activeElement.click()`
  to get it back. A zone whose items choose for themselves reports nothing and
  takes no Enter; it has no `onChange`, so it is a second options shape
  (`FocusZoneOptions`) and `useNavZone` takes the union (`ZoneOptions`).
- **`mergeRefs`, not a second `ref` argument.** A zone's `ref` meets a drag
  handle's or a measuring hook's on the same element; one helper covers both
  `zoneProps.ref` and `itemProps(id).ref`, where an argument would cover one and
  duplicate the other. A prop with no value is now absent, so a spread no longer
  erases a `role` or `aria-label` the element carried from elsewhere.
- **`ignore`, decided by the application.** Keyboard dragging uses the arrows the
  zone also reads. The zone could skip any key from an element with
  `aria-pressed="true"`, but a toolbar of toggle buttons carries the same
  attribute and must keep its arrows: only the application knows a pressed
  element is a drag. `ignore(event)` leaves the key whole — no move, not taken, no
  `preventDefault` — inside the zone and outside it.
- **`openedByKeyboard()`, called at the moment of opening.** A script's `focus()`
  shows a ring when the element that had focus before showed one, and when nothing
  had. A menu opened by a right click would ring its first item. The answer is
  `document.activeElement.matches(':focus-visible')` read before anything moves
  focus; a tracked modality would be a global listener for one question. A zone
  whose own element has focus lands the first arrow on the current item, so the
  menu that took focus on the pointer is an ordinary menu from the first key.
- **The zone is adopted at commit.** `update` ran during render and reset the
  pointed item when `value` changed: a render React started and discarded — a
  suspended transition — left the zone with the discarded render's options. The
  options are adopted in a layout effect and the render works out its own tab stop
  from its own options (`resolveZoneIndex`). The hook still subscribes to the tab
  stop, not to the raw pointed item, so moving focus onto the item that is already
  the tab stop renders nothing.
- **No index map.** Asked for, and measured: building a `Map` of 20 000 ids takes
  about 2 000 µs, one scan to the middle 9–52 µs. `items` usually arrives as a new
  array each render, so the map would cost more than the scans it removes. The
  count of scans per key is what was cut (one per move instead of three or more),
  and the ref callbacks cached per id are dropped with their element.
- **A test bed.** The stack and the zone were already plain objects driven by
  fakes in this repository's own tests; those fakes are now
  `stitchkit/react/keyboard/testing`, so a consumer without a DOM tests the order
  of layers, `scope`/`inert` and the edges of a zone the same way.

## Amendment (0.114.1, second wave): the first arrow, the panel, the field

The same application moved every list, Escape and section shortcut onto the hooks
and reported what was still worked around.

- **`outside: 'focus' | 'move'`, default as before.** Putting focus on the current
  item before anything changes is the safe first answer, and a list whose arrows
  choose should not change the choice on a key that only announced it. A list that
  has always answered the first arrow with a change opts in per zone. The word is
  not `'enter'`: `onEnter` is the cross-axis key.
- **A field is a field of the zone, not an area around it.** `data-local-keys`
  keeps page shortcuts out of an area; a zone inside it is the part of the area
  that handles arrows, and switching it off there left the panel without keys and
  without a message. The zone now treats as a field only what is inside it. The
  alternative, a development warning, would have kept a trap and named it.
- **`phase: 'capture'`, for `local` layers only.** The window listener runs after
  everything closer to the key, so a menu over a text field cannot get the arrows
  and Enter before the field acts on them, and no ordering inside the bubble
  phase changes that. A second listener in the capture phase exists only while a
  layer asks for it; a key it takes is consumed whole, because a field that also
  sent the message would make the menu pointless. Capture is refused for the
  other kinds: a `route` Escape that ran before a dialog's own would close the
  page behind the dialog. A live overlay still stops layers of either phase.
  The refusal is a readable error when the layer mounts and not a union type:
  an `Omit<KeyLayerOptions, …>` in a consumer's wrapper must keep compiling.
- **`insertCompare` for the entity cache.** `compare` sorts the whole array after
  every create and update, which presumes the row carries its own rank. Where the
  server's order depends on facts outside the row, no `compare` exists and a wrong
  one scrambles the list. `insertCompare` places only the row entering the list,
  by the rule `compare` followed for ties, and leaves every other row and every
  updated row where it is; a list takes one of the two.
