import type { CliRenderer, KeyEvent } from '@opentui/core';
import { useRenderer } from '@opentui/react';
import { useEffect, useRef } from 'react';

/**
 * Who sees a key first. OpenTUI calls every `useKeyboard` subscriber in mount
 * order and `preventDefault` does not stop the others, so two widgets on one
 * screen would both act on one key. The kit routes keys itself: one listener
 * per renderer, handlers by priority, and the first that takes a key ends it.
 */
export const TerminalKeyPriority = Object.freeze({
  /** A widget taking typed text (a filter, a query, a form field): it sees keys before anyone. */
  input: 300,
  /** A layer over the screen, such as a dialog. */
  layer: 200,
  /** A focused widget. */
  widget: 100,
  /** Application-wide keys: page switches, quit. They get what no widget took. */
  global: 0,
});

/** Return `true` when the handler took the key; it then reaches nobody else. */
export type TerminalKeyHandler = (key: KeyEvent) => boolean;

interface Registration {
  readonly order: number;
  priority: number;
  handler: TerminalKeyHandler;
}

class KeyRouter {
  private readonly registrations = new Set<Registration>();
  private next = 0;

  constructor(renderer: CliRenderer) {
    renderer.keyInput.on('keypress', (key: KeyEvent) => this.route(key));
  }

  register(priority: number, handler: TerminalKeyHandler): Registration {
    const registration = { order: this.next, priority, handler };
    this.next += 1;
    this.registrations.add(registration);
    return registration;
  }

  unregister(registration: Registration): void {
    this.registrations.delete(registration);
  }

  private route(key: KeyEvent): void {
    if (key.propagationStopped) return;
    // Higher priority first; equal priority in the order the handlers mounted.
    const ordered = [...this.registrations].sort(
      (a, b) => b.priority - a.priority || a.order - b.order,
    );
    for (const registration of ordered) {
      if (registration.handler(key)) {
        key.preventDefault();
        key.stopPropagation();
        return;
      }
    }
  }
}

const routers = new WeakMap<CliRenderer, KeyRouter>();

function routerFor(renderer: CliRenderer): KeyRouter {
  const existing = routers.get(renderer);
  if (existing) return existing;
  const created = new KeyRouter(renderer);
  routers.set(renderer, created);
  return created;
}

/**
 * Subscribe to keys through the kit's router. The handler always reads the
 * latest render's props; an inactive handler takes nothing.
 */
export function useTerminalKeyboard(
  handler: TerminalKeyHandler,
  options: { priority?: number; active?: boolean } = {},
): void {
  const renderer = useRenderer();
  const priority = options.priority ?? TerminalKeyPriority.widget;
  const active = options.active ?? true;
  const latest = useRef(handler);
  latest.current = handler;
  const live = useRef(active);
  live.current = active;
  useEffect(() => {
    const router = routerFor(renderer);
    const entry = router.register(priority, (key) => live.current && latest.current(key));
    return () => router.unregister(entry);
  }, [renderer, priority]);
}
