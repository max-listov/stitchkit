---
title: Keyboard layers and list zones
description: One listener decides which part of a screen gets a key; lists move real focus with the arrows
type: guide
status: active
created: 2026-09-29
updated: 2026-09-29
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
| `mode` | `'select'` | `'select'`: an arrow chooses (`onChange(id, 'arrow')`). `'highlight'`: an arrow only moves focus, Enter chooses (`onChange(id, 'confirm')`) |
| `orientation` | `'vertical'` | which arrows move; the other axis enters and exits |
| `role` | `'listbox'` | `'listbox'` of options or `'tablist'` of tabs, marked `aria-selected`; `'none'` keeps the items' own semantics (links, buttons) and marks the chosen one `aria-current` |
| `loop` | `false` | wrap past the ends instead of calling `onBoundary` |
| `onEnter(id)` | — | → in a vertical zone (↓ in a horizontal one), and Enter in select mode: go into what the item opens |
| `onExit()` | — | ← in a vertical zone (↑ in a horizontal one) |
| `onBoundary(side)` | — | a move past `'start'` or `'end'`: hand focus to the neighbouring zone |
| `active` | `true` | whether arrows pressed outside every zone land here |
| `label` | — | the zone's accessible name |
| `onReveal(id)` | — | focus went to an item with no element yet — a row of a virtualized list outside the rendered range; scroll it in, and focus lands on it when it mounts |

The callbacks return `false` to leave the key to the page, anything else takes
it. A key the zone does not take bubbles on to the layers — in a vertical list
← and → are not the list's keys, so the section switch above hears them.

Each zone keeps its own focused item; two zones never share one. When focus is
in no zone at all — right after the page loads — the first arrow on the zone's
axis puts focus on the active zone's current item. To move between zones
(sidebar → table), call `zone.focus(id?)` of the other zone from `onEnter` or
`onBoundary`. `zone.element` is the zone's element, for a layer scoped to it.

## What stays in the application

The URL, the router, sections and which screen is open. A layer calls the
application's own functions — `router.push`, `close()` — and nothing here reads
or writes a location. Keep entity coordinates in the path and filters in the
query, parse and build them in one pure module with tests, and use explicit
`push` / `replace` rather than a positional flag.
