/**
 * Type test: the zone's props spread onto the elements an application writes
 * in JSX — a list, a navigation of links, a row of tab buttons — and the hook
 * refuses what the zone cannot mean. Checked by `tsc`, never run.
 */
import { useEscapeLayer, useKeyLayer, useNavZone } from '../src/entrypoints/react/keyboard';

export function Chats(props: {
  readonly ids: readonly string[];
  readonly open: string | null;
}) {
  const zone = useNavZone({
    items: props.ids,
    value: props.open,
    onChange: (id: string) => void id,
    label: 'Chats',
  });
  return (
    <ul {...zone.zoneProps}>
      {props.ids.map((id) => (
        <li key={id} {...zone.itemProps(id)}>
          {id}
        </li>
      ))}
    </ul>
  );
}

export function Sections(props: { readonly ids: readonly number[] }) {
  const zone = useNavZone({
    items: props.ids,
    value: props.ids[0] ?? null,
    onChange: () => undefined,
    role: 'none',
    orientation: 'horizontal',
    onBoundary: (side) => side === 'end',
  });
  useEscapeLayer({ kind: 'route', scope: zone.element, onEscape: () => false });
  useKeyLayer({ kind: 'global', onKey: (event) => event.key === 'ArrowRight' });
  // @ts-expect-error — an id the zone does not list is not an item
  zone.itemProps('first');
  // @ts-expect-error — Escape layers are overlay, local or route; a zone is not closed
  useEscapeLayer({ kind: 'zone', onEscape: () => undefined });
  return (
    <nav {...zone.zoneProps}>
      {props.ids.map((id) => (
        <a key={id} href={`#${id}`} {...zone.itemProps(id)}>
          {id}
        </a>
      ))}
    </nav>
  );
}
