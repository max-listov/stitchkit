import { useEffect, useRef } from 'react';
import type { TerminalFormAction, TerminalFormState } from '../core/form';
import {
  defineTerminalKeymap,
  matchTerminalKey,
  type TerminalKeyBinding,
} from '../core/key-hints';
import type { TerminalLabels } from '../core/labels';
import {
  fitTerminalText,
  sanitizeTerminalText,
  terminalTextEdit,
  truncateTerminalText,
  wrapTerminalText,
} from '../core/text';
import { useTerminalFocused, useTerminalLabels } from './context';
import { TerminalKeyPriority, useTerminalKeyboard } from './keyboard';
import { useTerminalPalette } from './theme';

export function terminalFormKeymap(
  labels: TerminalLabels,
  cancel = true,
): TerminalKeyBinding[] {
  return defineTerminalKeymap([
    {
      id: 'next',
      keys: ['tab', 'down'],
      shift: false,
      display: 'Tab',
      label: labels.next,
      priority: 1,
    },
    {
      id: 'previous',
      keys: ['tab', 'up'],
      shift: true,
      display: '⇧Tab',
      label: labels.next,
      hidden: true,
    },
    {
      id: 'previous-arrow',
      keys: ['up'],
      shift: false,
      display: '↑',
      label: labels.next,
      hidden: true,
    },
    {
      id: 'change',
      keys: ['left', 'right', 'space'],
      display: '←→',
      label: labels.change,
      priority: 2,
    },
    {
      id: 'submit',
      keys: ['return', 'enter'],
      display: 'Enter',
      label: labels.submit,
      priority: 0,
    },
    ...(cancel
      ? [{ id: 'cancel', keys: ['escape'], display: 'Esc', label: labels.back, priority: 0 }]
      : []),
  ]);
}

export interface TerminalFormProps {
  state: TerminalFormState;
  onAction(action: TerminalFormAction): void;
  /** Called with the read values when Enter submits a form whose every field reads. */
  onSubmit(values: Record<string, unknown>): void;
  onCancel?(): void;
  width: number;
  focusId?: string;
  focused?: boolean;
  keymap?: readonly TerminalKeyBinding[];
}

/**
 * A form edited in place: one row per field with its label, the value (typed,
 * or cycled with ←→ for booleans and choices, masked for secrets), the focused
 * field's description, and each field's error once it was left or submitted.
 * Enter on any field submits: a form with errors moves to the first of them.
 */
export function TerminalForm({
  state,
  onAction,
  onSubmit,
  onCancel,
  width,
  focusId,
  focused,
  keymap,
}: TerminalFormProps) {
  const palette = useTerminalPalette();
  const labels = useTerminalLabels();
  const active = useTerminalFocused(focusId, focused);
  const bindings = keymap ?? terminalFormKeymap(labels, onCancel !== undefined);
  const current = state.fields[state.focus];
  const cycles = current?.kind === 'boolean' || current?.kind === 'choice';

  // Submission travels through the state, so Enter right after typing submits what was typed.
  const delivered = useRef(state.accepted?.serial ?? 0);
  useEffect(() => {
    const accepted = state.accepted;
    if (!accepted || accepted.serial === delivered.current) return;
    delivered.current = accepted.serial;
    onSubmit(accepted.values);
  }, [state.accepted, onSubmit]);

  useTerminalKeyboard(
    (key) => {
      const id = matchTerminalKey(bindings, key)?.id;
      // A form without fields has nothing to type into: Enter runs it, Esc leaves.
      if (!current) {
        if (id === 'submit') onAction({ type: 'submit' });
        else if (id === 'cancel' && onCancel) onCancel();
        else return false;
        return true;
      }
      // A typed field takes Space and the arrows as text, not as cycling.
      if (id === 'change' && cycles)
        onAction({ type: 'cycle', delta: key.name === 'left' ? -1 : 1 });
      else if (id === 'next') onAction({ type: 'move', delta: 1 });
      else if (id === 'previous' || id === 'previous-arrow')
        onAction({ type: 'move', delta: -1 });
      else if (id === 'cancel' && onCancel) onCancel();
      else if (id === 'submit') onAction({ type: 'submit' });
      else if (!cycles) {
        const edit = terminalTextEdit(key);
        if (edit === null || edit.kind === 'commit' || edit.kind === 'clear') return false;
        onAction({ type: 'edit', edit });
      } else return false;
      return true;
    },
    { active, priority: TerminalKeyPriority.input },
  );

  // Label, required mark and one cell of air before the value.
  const labelWidth = Math.min(
    Math.max(
      4,
      ...state.fields.map(
        ({ label, required }) => Array.from(label).length + (required ? 2 : 0) + 1,
      ),
    ),
    Math.floor(width / 3),
  );
  if (state.fields.length === 0) {
    return (
      <box style={{ flexDirection: 'column', width }}>
        <text fg={palette.muted} wrapMode='none'>
          {truncateTerminalText(labels.noFields, width)}
        </text>
      </box>
    );
  }
  return (
    <box style={{ flexDirection: 'column', width }}>
      {state.fields.map((field, index) => {
        const isFocused = index === state.focus && active;
        const draft = state.drafts[field.name] ?? '';
        const error = state.errors[field.name];
        const shown =
          field.kind === 'secret'
            ? '•'.repeat(Array.from(draft).length)
            : field.kind === 'boolean' || field.kind === 'choice'
              ? `‹ ${sanitizeTerminalText(draft) || '—'} ›`
              : sanitizeTerminalText(draft);
        const placeholder =
          draft === '' && field.kind !== 'boolean' && field.kind !== 'choice'
            ? (field.placeholder ?? (field.required ? labels.required : ''))
            : '';
        const valueWidth = Math.max(1, width - labelWidth - 2);
        const value = truncateTerminalText(
          shown +
            (isFocused && field.kind !== 'boolean' && field.kind !== 'choice' ? '▏' : ''),
          valueWidth,
        );
        const description =
          isFocused && field.description
            ? wrapTerminalText(
                sanitizeTerminalText(field.description),
                Math.max(1, width - labelWidth - 2),
              ).slice(0, 2)
            : [];
        return (
          <box key={field.name} style={{ flexDirection: 'column' }}>
            <text wrapMode='none' {...(isFocused && { bg: palette.panelRaised })}>
              <span fg={isFocused ? palette.accent : palette.muted}>
                {isFocused ? '› ' : '  '}
              </span>
              <span fg={error ? palette.danger : isFocused ? palette.primary : palette.muted}>
                {fitTerminalText(
                  `${sanitizeTerminalText(field.label)}${field.required ? ' *' : ''}`,
                  labelWidth,
                )}
              </span>
              <span fg={palette.primary}>{value}</span>
              <span fg={palette.muted}>
                {fitTerminalText(
                  placeholder,
                  Math.max(0, valueWidth - Array.from(value).length),
                )}
              </span>
            </text>
            {description.map((line, offset) => (
              <text key={offset} fg={palette.muted} wrapMode='none'>
                {' '.repeat(labelWidth + 2) + line}
              </text>
            ))}
            {error ? (
              <text fg={palette.danger} wrapMode='none'>
                {' '.repeat(labelWidth + 2) +
                  truncateTerminalText(error, Math.max(1, width - labelWidth - 2))}
              </text>
            ) : null}
          </box>
        );
      })}
    </box>
  );
}
