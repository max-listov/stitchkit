import { useMemo } from 'react';
import type { TerminalKeyBinding } from '../core/key-hints';
import { terminalTabsKey, terminalTabsKeymap } from '../core/keys';
import type { TerminalTabsAction, TerminalTabsState } from '../core/tabs';
import { sanitizeTerminalText } from '../core/text';
import { useTerminalFocused, useTerminalLabels } from './context';
import { useTerminalKeyboard } from './keyboard';
import { useTerminalPalette } from './theme';

export interface TerminalTabsProps {
  state: TerminalTabsState;
  onAction(action: TerminalTabsAction): void;
  focusId?: string;
  /** Whether Tab, Shift-Tab and 1–9 switch these tabs; overrides `focusId`. */
  focused?: boolean;
  keymap?: readonly TerminalKeyBinding[];
}

/** One line of views: ` 1 Processes 412 │ 2 Network ` with the selected one raised. */
export function TerminalTabs({
  state,
  onAction,
  focusId,
  focused,
  keymap,
}: TerminalTabsProps) {
  const palette = useTerminalPalette();
  const labels = useTerminalLabels();
  const active = useTerminalFocused(focusId, focused);
  const bindings = useMemo(() => keymap ?? terminalTabsKeymap(labels), [keymap, labels]);
  useTerminalKeyboard(
    (key) => {
      const action = terminalTabsKey(key, bindings);
      if (action === null) return false;
      onAction(action);
      return true;
    },
    { active },
  );
  return (
    <text wrapMode='none'>
      {state.tabs.map((tab, index) => {
        const selected = tab.id === state.selectedId;
        return (
          <span
            key={tab.id}
            fg={selected ? palette.primary : palette.muted}
            {...(selected && { bg: palette.panelRaised })}
          >
            {`${index === 0 ? '' : ' '} ${index < 9 ? `${index + 1} ` : ''}${sanitizeTerminalText(tab.label)}${
              tab.badge === null ? '' : ` ${tab.badge}`
            } `}
          </span>
        );
      })}
    </text>
  );
}
