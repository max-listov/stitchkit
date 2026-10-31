---
title: Keyboard layers and list zones
description: One listener decides which part of a screen gets a key; lists move real focus with the arrows
type: guide
status: active
created: 2026-09-29
updated: 2026-10-31
---

# Keyboard layers and list zones

`stitchkit/react/keyboard` answers one question for a React screen: **who gets
this key?** It is headless — three hooks and no component, no styles, no
router. The application keeps its URL, its sections and its markup; the hooks
decide which part of the screen hears a key and move focus through lists.

```bash
bun add react   # the only peer
```

## Why layers

A screen with a menu, a dialog, a list and section shortcuts usually grows a
`keydown` listener per concern, and they run in the order they mounted:
Escape closes the dialog *and* the page behind it, an arrow in a dialog also
switches the section underneath, a hidden panel still reacts. Here every
concern is a layer on one stack, and the stack asks them in a fixed order until
one takes the key:

| Kind | What it is | Example |
|---|---|---|
| `overlay` | something modal; while one is live nothing below hears any key | a dialog |
| `local` | a component with the user's attention, not modal | an open command menu |
| `route` | the page's "up one level" | Escape closes the open entity |
| `zone` | a list the arrows move through (see below) | the chat list |
| `global` | shortcuts of the whole screen | ← / → switch sections |

Within a kind the innermost layer wins: of two layers whose elements nest, the
inner one, otherwise the one activated last. One press of Escape closes one
level, and holding Escape does not close several.

The stack listens on the window, in the bubbling phase. Everything closer to the
key hears it first — a widget's own `onKeyDown`, a text field, a popover that
closes on Escape — and keeps it with `preventDefault()` or `stopPropagation()`.
A layer only gets what nobody nearer wanted, so third-party components keep
working unchanged.
One kind of layer may ask for the opposite: a menu over a text field takes the
arrows before the field does — see [A menu over a text field](#a-menu-over-a-text-field).

## Shortcuts and Escape

```tsx
import { useRef } from 'react'
import { useEscapeLayer, useKeyLayer } from 'stitchkit/react/keyboard'

function Workspace({ next, previous, children }) {
  useKeyLayer({
    kind: 'global',
    onKey: (event) => {
      if (event.key === 'ArrowRight') next()
      else if (event.key === 'ArrowLeft') previous()
      else return false // not taken: the key keeps its default
      return true
    },
  })
  return children
}

function EntityPanel({ close }) {
  const panel = useRef<HTMLElement>(null)
  useEscapeLayer({ kind: 'route', scope: panel, onEscape: close })
  return <section ref={panel}>…</section>
}
```

`onKey` returns `true` when it took the key: its default is prevented and no
layer below hears it. `onEscape` returns `false` when there was nothing to close,
and the next layer is asked.

**`scope`** ties a layer to an element. A scoped layer is heard only while the
element is mounted, visible and outside any `inert` subtree — a panel kept
mounted in the background stops hearing keys without an `active` flag — and it
outranks layers of its kind whose elements contain it. React runs a child's
effects before its parent's, so when a page and the panel inside it mount
together, only `scope` tells the stack which one is inside.

**`active`** (default `true`) switches a layer off without unmounting it;
becoming active again puts it on top of its kind.

**Fields keep their keys.** Keys pressed in an input, a text area, a select, an
editable region, a combobox, a slider or any area marked `data-local-keys` do not
reach layers — except Escape, which a field that wants it keeps with
`preventDefault()`. `fields: 'include'` lets a layer hear them anyway.
`isKeyFieldTarget(event.target)` is the same test, for a handler of your own.

## List zones

A zone is a list the arrows move through with **real focus**: one item is the
tab stop (roving `tabIndex`), Tab enters the list at it and leaves the list, the
arrows move DOM focus between items. Screen readers follow it, `:focus-visible`
draws it, the browser scrolls to it.

```tsx
import { useNavZone } from 'stitchkit/react/keyboard'

function ChatList({ chats, openId, open }) {
  const zone = useNavZone({
    items: chats.map((chat) => chat.id),
    value: openId,
    onChange: (id) => open(id),
    label: 'Chats',
  })
  return (
    <ul {...zone.zoneProps}>
      {chats.map((chat) => (
        <li key={chat.id} {...zone.itemProps(chat.id)}>
          {chat.title}
        </li>
      ))}
    </ul>
  )
}
```

| Option | Default | Meaning |
|---|---|---|
| `items`, `value`, `onChange` | — | the ids in order, the chosen one, and the report of a choice; the zone never holds the value |
| `mode` | `'select'` | `'select'`: an arrow chooses (`onChange(id, 'arrow')`). `'highlight'`: an arrow only moves focus, Enter chooses (`onChange(id, 'confirm')`). `'focus'`: an arrow only moves focus and the items choose for themselves — see [below](#links-and-buttons-that-choose-for-themselves) |
| `orientation` | `'vertical'` | which arrows move; the other axis enters and exits |
| `role` | `'listbox'` | `'listbox'` of options or `'tablist'` of tabs, marked `aria-selected`; `'none'` keeps the items' own semantics (links, buttons) and marks the chosen one `aria-current` |
| `loop` | `false` | wrap past the ends instead of calling `onBoundary` |
| `onEnter(id)` | — | → in a vertical zone (↓ in a horizontal one), and Enter in select mode: go into what the item opens |
| `onExit()` | — | ← in a vertical zone (↑ in a horizontal one) |
| `onBoundary(side)` | — | a move past `'start'` or `'end'`: hand focus to the neighbouring zone |
| `active` | `true` | whether arrows pressed outside every zone land here |
| `label` | — | the zone's accessible name |
| `outside` | `'focus'` | what the first arrow does when focus is in no zone: `'focus'` puts focus on the current item and nothing else; `'move'` moves from it and, in select mode, chooses the neighbour — see [below](#the-first-arrow-from-outside-a-zone) |
| `ignore(event)` | — | a key that is the application's own right now — return `true` and the zone leaves it whole; see [dragging](#a-zone-inside-a-drag-and-drop-list) |
| `onReveal(id)` | — | focus went to an item with no element yet — a row of a virtualized list outside the rendered range; scroll it in, and focus lands on it when it mounts |

The callbacks return `false` to leave the key to the page, anything else takes
it. A key the zone does not take bubbles on to the layers — in a vertical list
← and → are not the list's keys, so the section switch above hears them.

Each zone keeps its own focused item; two zones never share one. When focus is
in no zone at all — right after the page loads — the first arrow on the zone's
axis puts focus on the active zone's current item. To move between zones
(sidebar → table), call `zone.focus(id?)` of the other zone from `onEnter` or
`onBoundary`. `zone.element` is the zone's element, for a layer scoped to it.

## Links and buttons that choose for themselves

In `select` and `highlight` mode the zone reports a choice, and in `highlight` it takes
Enter for it. A list of `<a>` and `<button>` elements has a choice built in: Enter
clicks the focused one. Taking Enter would replace that with a handler you must
write to click the element yourself.

`mode: 'focus'` is for those lists — a menu, a toolbar, a row of tabs that are
links. The arrows move focus; Enter, and Space on a button, stay with the focused
element; the zone reports nothing, so there is no `onChange`. `value` is optional
and only marks the page you are on (`aria-current` with `role: 'none'`).

```tsx
function Toolbar({ actions }) {
  const zone = useNavZone({
    items: actions.map((action) => action.id),
    mode: 'focus',
    role: 'none',
    orientation: 'horizontal',
    label: 'Formatting',
  })
  return (
    <div {...zone.zoneProps}>
      {actions.map((action) => (
        <button key={action.id} type="button" onClick={action.run} {...zone.itemProps(action.id)}>
          {action.label}
        </button>
      ))}
    </div>
  )
}
```

In a focus zone Enter is never taken, even when `onEnter` is set: `onEnter` is
the cross-axis key (→ in a vertical zone).

## Props, refs and other libraries

Spread the zone's props **last** on an element another library also configures, so
the roving `tabIndex` is the one that counts. A prop without a value is absent, not
`undefined`: `role` is there only for a listbox or a tablist, `aria-selected` only
outside `role: 'none'`, `aria-label` only with a `label`. A `role="button"` the
element carries from another library, or an `aria-label` you wrote before the
spread, survives it.

`ref` is the one prop two libraries both need. `mergeRefs` makes one callback of
several refs; spread the zone's props, then replace `ref`:

```tsx
import { mergeRefs, useNavZone } from 'stitchkit/react/keyboard'

function Row({ id, zone }) {
  const sortable = useSortable({ id })
  const own = zone.itemProps(id)
  return (
    <li
      {...sortable.attributes}
      {...sortable.listeners}
      {...own}
      ref={mergeRefs(own.ref, sortable.setNodeRef)}
    >
      {id}
    </li>
  )
}
```

The same goes for `zone.zoneProps.ref` beside a scroll container's or a measuring
hook's ref. `mergeRefs` returns a new function on every call and React re-attaches a
callback ref whose identity changed; a component that renders often keeps the
result in `useMemo`.

`useNavZone` also returns a new object on every render. An effect that should run
when a menu *opens* depends on that, not on `zone`; keep the latest zone in a ref.

## A zone inside a drag-and-drop list

A sortable list is a zone whose rows can also be lifted with the keyboard: Space
lifts a row, the arrows move it, Space drops it. The arrows are then the drag's,
not the zone's, and a zone that also moves focus on them makes the focus ring jump
from row to row while the row moves.

`ignore` hands the zone a question about every key it would act on. dnd-kit marks
the lifted activator `aria-pressed="true"` for the length of the drag:

```tsx
const zone = useNavZone({
  items: order,
  mode: 'focus',
  role: 'none',
  ignore: (event) =>
    event.target instanceof Element && event.target.closest('[aria-pressed="true"]') !== null,
})
```

The zone leaves an ignored key entirely: it does not move, does not take the key and
does not call `preventDefault`, whether the key came from inside the zone or from
a page whose focus is in no zone. The test is the application's on purpose. A
toggle button also carries `aria-pressed="true"`, and a toolbar of toggles must
keep its arrows; only the application knows whether a pressed element is a drag.

## A menu or a popover opened by the pointer

A script's `focus()` shows the focus ring when the element that had focus before it
was showing one — and when nothing had. A menu opened by a right click, with focus
on `body`, would put a ring on its first item although nobody pressed a key. Decide
at the moment of opening: in the handler that opens the menu, before anything moves
focus, ask `openedByKeyboard()`.

```tsx
const byKeyboard = useRef(false)
const container = useRef<HTMLDivElement>(null)

function show() {
  byKeyboard.current = openedByKeyboard() // before the menu takes focus
  setOpen(true)
}

useLayoutEffect(() => {
  if (!open) return
  if (byKeyboard.current) zone.focus() // the first item, with its ring
  else container.current?.focus() // the menu itself
}, [open])
```

`openedByKeyboard()` is whether the element with focus right now matches
`:focus-visible`; it is `false` on a server and in a browser without that selector.
Give the container `outline: none`: it only holds focus, and a browser may count a
focus that starts on `body` as keyboard focus. The first arrow with focus on the
zone's own element lands on the current item, not one step beyond it, so the menu
opened by a click is a normal menu from the first key.

A focus manager that also puts initial focus on opening fights this for the first
item. Floating UI's `FloatingFocusManager` documents `initialFocus={-1}` as "ignore
the initial focus" and `initialFocus={refs.floating}` as focusing the container;
either leaves the first item to the handler above. (This repository's browser probe
covers the pattern with a plain element, not Floating UI.)

## The first arrow from outside a zone

With focus in no zone — right after a click on the page, or on the empty part of a
screen — the first arrow on an active zone's axis puts focus on its current item.
That is the safe answer: the person sees where they are before anything changes,
and a zone whose arrows choose does not change the choice on a key that only
announced the list.

A list that has always answered the first arrow with a change (a chat list whose
arrows open the next chat) can say so: `outside: 'move'` acts as if focus were
already on the current item, so the arrow moves from it and, in `select` mode,
calls `onChange` for the neighbour. It is opt-in and per zone; `ignore` is asked
first in both.

## A panel that keeps its keys around a zone

`data-local-keys` marks an area whose keys belong to it rather than to the page:
layers skip keys pressed inside it, so a section switch on ← and → leaves a
dropdown panel alone. A zone inside such a panel still has its arrows. The zone is
the part of the area that handles them, so only a field *inside the zone* — an
input in one of its rows — keeps its keys from the zone; an area that contains the
zone, or the zone's own element carrying the mark, does not. ← and → are not a
vertical zone's keys, so they bubble on to the layers, which skip them in that
panel: the zone moves, the section does not.

## A menu over a text field

A layer hears a key after everything closer to it, and a text field is as close as
it gets: the field acts on an arrow or Enter first. A menu that hangs over the
field — slash commands, quick replies — keeps focus in the field and needs those
keys *before* it does, and the field's own Enter (send the message) must not also
run.

`phase: 'capture'` is for that, and for a `local` layer only (any other kind
refuses it when it mounts): the layer is asked before the element that has focus,
and a key it takes — `preventDefault` and `stopPropagation` — reaches nothing
nearer.

```tsx
function CommandMenu({ open, items, pick }) {
  const menu = useRef<HTMLDivElement>(null)
  const [index, setIndex] = useState(0)
  useKeyLayer({
    kind: 'local',
    phase: 'capture',
    fields: 'include', // the key is pressed in the field
    scope: menu, // heard only while the menu is on the page
    active: open,
    onKey: (event) => {
      if (event.key === 'ArrowDown') setIndex((i) => Math.min(i + 1, items.length - 1))
      else if (event.key === 'ArrowUp') setIndex((i) => Math.max(i - 1, 0))
      else if (event.key === 'Enter') pick(items[index])
      else return false // typing, Backspace, everything else stays the field's
      return true
    },
  })
  return open ? <div ref={menu} role="listbox">…</div> : null
}
```

`fields: 'include'` is needed because the default skips keys pressed in a field;
`scope` and `active` keep the layer from taking keys when there is no menu. An
`overlay` above still stops it: a live overlay is a barrier for layers of either
phase. In `createKeyboardTestBed`, `press` runs the capture phase first and
stops there when a layer took the key (`event.propagationStopped`).

## Moving from a stack of zones of your own

A hand-written zone stack and `stitchkit/react/keyboard` name the same ideas
differently:

| Yours | Here |
|---|---|
| a flag that arrows choose at once (`instant`) | `mode: 'select'`; `'highlight'` when choosing is expensive |
| wrapping (often the default) | `loop` — `false` by default; set it on the lists that wrapped |
| the current section | `active` for which zone takes the first arrow, `scope` for which layer is live |
| one shared "highlighted id" | each zone's own focused item; read `zone.current` |
| an attribute that marks areas with their own keys | `data-local-keys` |
| Escape closing the innermost thing | `useEscapeLayer` — one Escape closes one level |

## Testing without a DOM

`stitchkit/react/keyboard/testing` has no React and no DOM in it: a window that
remembers its listener, elements with a parent, `inert` and visibility, and key
events with `preventDefault`. A test adds the layers a screen declares, presses
keys on elements and reads who heard what.

```ts
import { createKeyboardTestBed } from 'stitchkit/react/keyboard/testing'

test('Escape closes the dialog and not the page behind it', () => {
  const bed = createKeyboardTestBed()
  const heard: string[] = []
  const page = bed.element()
  const dialog = bed.element()
  bed.stack.add({ kind: 'route', scope: () => page, onKey: () => (heard.push('page'), true) })
  bed.stack.add({ kind: 'overlay', scope: () => dialog, onKey: () => (heard.push('dialog'), true) })
  bed.press('Escape')
  expect(heard).toEqual(['dialog'])
  page.inert = true // the page behind a dialog
  dialog.hidden = true
  bed.press('Escape')
  expect(heard).toEqual(['dialog'])
})
```

`createNavZone` is the zone without React: build it with the items' fake elements
(`bed.element({ zone: true })` and its `child()` rows count `focus()` and scrolling),
call `zone.keyDown(bed.key('ArrowDown', { target: row }), zoneElement)`. A real
focus ring, scrolling and screen readers are a browser's: this is for the order of
layers, `scope`/`inert` and the edges of a zone.

## What stays in the application

The URL, the router, sections and which screen is open. A layer calls the
application's own functions — `router.push`, `close()` — and nothing here reads
or writes a location. Keep entity coordinates in the path and filters in the
query, parse and build them in one pure module with tests, and use explicit
`push` / `replace` rather than a positional flag.
