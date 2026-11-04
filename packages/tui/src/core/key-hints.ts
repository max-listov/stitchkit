import { z } from 'zod';
import type { TerminalKey } from './keys';
import { terminalTextWidth, truncateTerminalText } from './text';

export const TerminalKeyBindingSchema = z
  .object({
    id: z.string().min(1),
    /** Key names as the renderer reports them (`up`, `return`, `escape`, `f5`) or typed characters (`/`, `q`). */
    keys: z.array(z.string().min(1)).min(1),
    /** What the hint shows for the keys, `↑↓` rather than `up down`. */
    display: z.string().min(1),
    label: z.string().min(1),
    /** A shorter label for narrow terminals. */
    short: z.string().min(1).optional(),
    /** Lower stays longer when the footer runs out of room. */
    priority: z.int().nonnegative().default(1),
    ctrl: z.boolean().default(false),
    shift: z.boolean().optional(),
    /** Listed in the help but not in the footer. */
    hidden: z.boolean().default(false),
  })
  .strict();

export type TerminalKeyBinding = z.output<typeof TerminalKeyBindingSchema>;
export type TerminalKeyBindingInput = z.input<typeof TerminalKeyBindingSchema>;

/**
 * One list of bindings is both what a screen answers and what its footer says,
 * so a hint can never advertise a key the screen ignores or hide one it takes.
 */
export function defineTerminalKeymap(
  bindings: readonly TerminalKeyBindingInput[],
): TerminalKeyBinding[] {
  const parsed = z.array(TerminalKeyBindingSchema).parse(bindings);
  const ids = new Set<string>();
  const chords = new Map<string, string>();
  for (const binding of parsed) {
    if (ids.has(binding.id))
      throw new Error(`Terminal key binding ${binding.id} is declared twice`);
    ids.add(binding.id);
    for (const key of binding.keys) {
      // A binding that does not name shift answers both with and without it.
      const shifts = binding.shift === undefined ? [false, true] : [binding.shift];
      for (const shift of shifts) {
        const chord = `${binding.ctrl ? 'ctrl+' : ''}${shift ? 'shift+' : ''}${key}`;
        const owner = chords.get(chord);
        if (owner) throw new Error(`Key ${chord} is bound to both ${owner} and ${binding.id}`);
        chords.set(chord, binding.id);
      }
    }
  }
  return parsed;
}

/** The binding a key event triggers, or `null`. */
export function matchTerminalKey(
  bindings: readonly TerminalKeyBinding[],
  key: TerminalKey,
): TerminalKeyBinding | null {
  for (const binding of bindings) {
    if (binding.ctrl !== Boolean(key.ctrl)) continue;
    if (binding.shift !== undefined && binding.shift !== Boolean(key.shift)) continue;
    if (binding.keys.some((name) => name === key.name || name === key.sequence))
      return binding;
  }
  return null;
}

/**
 * The footer for `width` cells: full labels while they fit, then short labels,
 * then the highest-priority-number hints dropped one by one.
 */
export function fitTerminalKeyHints(
  bindings: readonly TerminalKeyBinding[],
  width: number,
  separator = ' · ',
): string {
  const shown = bindings.filter(({ hidden }) => !hidden);
  const render = (items: readonly TerminalKeyBinding[], short: boolean): string =>
    items
      .map(
        (binding) =>
          `${binding.display} ${short ? (binding.short ?? binding.label) : binding.label}`,
      )
      .join(separator);
  let items = [...shown];
  for (;;) {
    const full = render(items, false);
    if (terminalTextWidth(full) <= width) return full;
    const short = render(items, true);
    if (terminalTextWidth(short) <= width) return short;
    if (items.length <= 1) return truncateTerminalText(short, width);
    let drop = 0;
    items.forEach((binding, index) => {
      if (binding.priority >= (items[drop]?.priority ?? 0)) drop = index;
    });
    items = items.filter((_, index) => index !== drop);
  }
}
