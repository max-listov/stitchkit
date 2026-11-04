import { type ReactNode, useEffect, useState } from 'react';
import { layoutTerminalDetails } from '../core/json';
import type { TerminalKeyBinding } from '../core/key-hints';
import { terminalMeter } from '../core/meter';
import {
  formatTerminalDuration,
  type TerminalAsyncState,
  type TerminalSpinnerKind,
  terminalIndeterminateBlock,
  terminalProgress,
  terminalSpinnerFrame,
  terminalSpinners,
} from '../core/progress';
import {
  sanitizeTerminalText,
  terminalTextWidth,
  truncateTerminalText,
  wrapTerminalText,
} from '../core/text';
import type { TerminalTone } from '../core/theme';
import { useTerminalFocused, useTerminalLabels } from './context';
import { TerminalKeyPriority, useTerminalKeyboard } from './keyboard';
import { useTerminalPalette } from './theme';

/** Re-render every `intervalMs` while mounted; returns the clock of the last tick. */
export function useTerminalClock(intervalMs: number, clock: () => number = Date.now): number {
  const [now, setNow] = useState(clock);
  useEffect(() => {
    const timer = setInterval(() => setNow(clock()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, clock]);
  return now;
}

/** `⠹ Loading catalogue · 2.4s` — a frame, a label and the time since `startedAt`. */
export function TerminalSpinner({
  label,
  startedAt,
  kind = 'dots',
  tone = 'accent',
  clock,
}: {
  label: string;
  startedAt: number;
  kind?: TerminalSpinnerKind;
  tone?: TerminalTone;
  clock?: () => number;
}) {
  const palette = useTerminalPalette();
  const now = useTerminalClock(terminalSpinners[kind].intervalMs, clock);
  const elapsed = now - startedAt;
  return (
    <text wrapMode='none'>
      <span fg={palette[tone]}>{`${terminalSpinnerFrame(kind, elapsed)} `}</span>
      <span fg={palette.primary}>{sanitizeTerminalText(label)}</span>
      <span fg={palette.muted}>{` · ${formatTerminalDuration(elapsed)}`}</span>
    </text>
  );
}

/** A progress bar: determinate with percent, rate and time left, or a moving block while the total is unknown. */
export function TerminalProgressBar({
  done,
  total,
  startedAt,
  now,
  width,
  label,
  unit = '',
}: {
  done: number | null;
  total: number | null;
  startedAt: number;
  now: number;
  width: number;
  label?: string;
  unit?: string;
}) {
  const palette = useTerminalPalette();
  const progress = terminalProgress({ done, total, startedAt, now });
  const tail =
    progress.ratio === null
      ? ` ${formatTerminalDuration(progress.elapsedMs)}`
      : ` ${Math.round(progress.ratio * 100)}%${progress.etaMs === null ? '' : ` · ${formatTerminalDuration(progress.etaMs)}`}${
          progress.rate === null || unit === ''
            ? ''
            : ` · ${progress.rate.toFixed(1)} ${unit}/s`
        }`;
  const head = label ? `${sanitizeTerminalText(label)} ` : '';
  const barWidth = Math.max(1, width - terminalTextWidth(head) - terminalTextWidth(tail));
  if (progress.ratio === null) {
    const [start, length] = terminalIndeterminateBlock(barWidth, progress.elapsedMs);
    return (
      <text wrapMode='none'>
        <span fg={palette.primary}>{head}</span>
        <span fg={palette.panelRaised}>{'━'.repeat(start)}</span>
        <span fg={palette.accent}>{'━'.repeat(length)}</span>
        <span fg={palette.panelRaised}>
          {'━'.repeat(Math.max(0, barWidth - start - length))}
        </span>
        <span fg={palette.muted}>{tail}</span>
      </text>
    );
  }
  const bar = terminalMeter({
    value: progress.ratio,
    max: 1,
    width: barWidth,
    thresholds: [
      { ratio: 0, tone: 'accent' },
      { ratio: 1, tone: 'success' },
    ],
  });
  return (
    <text wrapMode='none'>
      <span fg={palette.primary}>{head}</span>
      <span fg={palette[bar.tone]}>{bar.filled}</span>
      <span fg={palette.panelRaised}>
        {'━'.repeat(Math.max(0, barWidth - Array.from(bar.filled).length))}
      </span>
      <span fg={palette.muted}>{tail}</span>
    </text>
  );
}

/** Loading, error, empty or the content: the four faces of anything fetched. */
export function TerminalAsyncView<DATA>({
  state,
  width,
  children,
  clock,
}: {
  state: TerminalAsyncState<DATA>;
  width: number;
  children(data: DATA): ReactNode;
  clock?: () => number;
}) {
  const palette = useTerminalPalette();
  const labels = useTerminalLabels();
  if (state.status === 'loading') {
    return (
      <TerminalSpinner
        label={state.label ?? labels.loading}
        startedAt={state.startedAt}
        {...(clock && { clock })}
      />
    );
  }
  if (state.status === 'error') {
    return (
      <box style={{ flexDirection: 'column' }}>
        <text fg={palette.danger} wrapMode='none'>{`✕ ${labels.error}`}</text>
        {wrapTerminalText(sanitizeTerminalText(state.message), Math.max(1, width))
          .slice(0, 6)
          .map((line, index) => (
            <text key={index} fg={palette.primary} wrapMode='none'>
              {line}
            </text>
          ))}
      </box>
    );
  }
  if (state.status === 'empty') {
    return <text fg={palette.muted}>{state.message ?? labels.empty}</text>;
  }
  return <>{children(state.data)}</>;
}

/** Aligned key/value pairs, k9s-describe style. */
export function TerminalDetails({
  pairs,
  width,
}: {
  pairs: readonly { key: string; value: string; tone?: TerminalTone }[];
  width: number;
}) {
  const palette = useTerminalPalette();
  return (
    <box style={{ flexDirection: 'column' }}>
      {layoutTerminalDetails(pairs, width).map((pair, index) => (
        <text key={index} wrapMode='none'>
          <span fg={palette.muted}>{pair.key}</span>
          <span fg={palette[pair.tone]}>{pair.value}</span>
        </text>
      ))}
    </box>
  );
}

/**
 * A confirmation over the screen: Enter or `y` confirms, Esc or `n` cancels,
 * ←→ move between the two buttons. It takes the keyboard while it is open.
 */
export function TerminalDialog({
  title,
  message,
  tone = 'warning',
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
  width = 56,
  focusId,
  focused,
}: {
  title: string;
  message: string;
  tone?: TerminalTone;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm(): void;
  onCancel(): void;
  width?: number;
  focusId?: string;
  focused?: boolean;
}) {
  const palette = useTerminalPalette();
  const labels = useTerminalLabels();
  const active = useTerminalFocused(focusId, focused);
  const [choice, setChoice] = useState<'confirm' | 'cancel'>('cancel');
  useTerminalKeyboard(
    (key) => {
      if (key.name === 'y') onConfirm();
      else if (key.name === 'n' || key.name === 'escape') onCancel();
      else if (key.name === 'left' || key.name === 'right' || key.name === 'tab')
        setChoice((current) => (current === 'confirm' ? 'cancel' : 'confirm'));
      else if (key.name === 'return' || key.name === 'enter')
        (choice === 'confirm' ? onConfirm : onCancel)();
      // A dialog holds the keyboard: nothing under it acts while it is open.
      return !(key.ctrl && key.name === 'c');
    },
    { active, priority: TerminalKeyPriority.layer },
  );
  const inner = Math.max(10, width - 4);
  const button = (text: string, selected: boolean) =>
    selected ? `[ ${text} ]` : `  ${text}  `;
  return (
    <box
      border
      borderStyle='rounded'
      borderColor={palette[tone]}
      title={` ${truncateTerminalText(sanitizeTerminalText(title), inner - 2)} `}
      titleColor={palette[tone]}
      backgroundColor={palette.panel}
      style={{ flexDirection: 'column', width, paddingLeft: 1, paddingRight: 1 }}
    >
      {wrapTerminalText(sanitizeTerminalText(message), inner)
        .slice(0, 8)
        .map((line, index) => (
          <text key={index} fg={palette.primary} wrapMode='none'>
            {line}
          </text>
        ))}
      <text wrapMode='none'>
        <span fg={choice === 'confirm' ? palette[tone] : palette.muted}>
          {button(`${confirmLabel ?? labels.yes} (y)`, choice === 'confirm')}
        </span>
        <span fg={choice === 'cancel' ? palette.primary : palette.muted}>
          {button(`${cancelLabel ?? labels.no} (n)`, choice === 'cancel')}
        </span>
      </text>
    </box>
  );
}

/** Every binding of a screen, grouped, for a `?` help overlay. */
export function TerminalHelp({
  groups,
  width,
}: {
  groups: readonly { title: string; bindings: readonly TerminalKeyBinding[] }[];
  width: number;
}) {
  const palette = useTerminalPalette();
  return (
    <box style={{ flexDirection: 'column', width }}>
      {groups.map((group) => (
        <box key={group.title} style={{ flexDirection: 'column', marginBottom: 1 }}>
          <text fg={palette.accent}>{sanitizeTerminalText(group.title)}</text>
          {group.bindings.map((binding) => (
            <text key={binding.id} wrapMode='none'>
              <span fg={palette.primary}>{`  ${binding.keys.join(' ').padEnd(16)}`}</span>
              <span fg={palette.muted}>
                {truncateTerminalText(
                  sanitizeTerminalText(binding.label),
                  Math.max(1, width - 18),
                )}
              </span>
            </text>
          ))}
        </box>
      ))}
    </box>
  );
}
