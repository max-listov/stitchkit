import type { ReactNode } from 'react';
import { fitTerminalKeyHints, type TerminalKeyBinding } from '../core/key-hints';
import type { TerminalNoticesState } from '../core/notices';
import {
  fitTerminalText,
  sanitizeTerminalText,
  terminalTextWidth,
  truncateTerminalText,
} from '../core/text';
import type { TerminalTone } from '../core/theme';
import { useTerminalPalette } from './theme';

export interface TerminalSegment {
  text: string;
  tone?: TerminalTone;
}

/** A bordered box with a title, a badge on the right of it, and a brighter frame while focused. */
export function TerminalPanel({
  title,
  badge,
  focused = false,
  width,
  height,
  grow,
  children,
}: {
  title?: string;
  badge?: string | number;
  focused?: boolean;
  width?: number;
  height?: number;
  /** Take the space left in the parent's direction. */
  grow?: boolean;
  children: ReactNode;
}) {
  const palette = useTerminalPalette();
  const heading =
    title === undefined ? undefined : ` ${title}${badge === undefined ? '' : ` · ${badge}`} `;
  return (
    <box
      border
      borderStyle='rounded'
      borderColor={focused ? palette.borderActive : palette.border}
      {...(heading !== undefined && {
        title: heading,
        titleColor: focused ? palette.accent : palette.muted,
      })}
      style={{
        flexDirection: 'column',
        paddingLeft: 1,
        paddingRight: 1,
        ...(width !== undefined && { width }),
        ...(height !== undefined && { height }),
        ...(grow && { flexGrow: 1 }),
      }}
    >
      {children}
    </box>
  );
}

/** One line of toned segments separated by ` · `, cut to the width. */
export function TerminalStatusBar({
  segments,
  width,
  separator = ' · ',
}: {
  segments: readonly TerminalSegment[];
  width: number;
  separator?: string;
}) {
  const palette = useTerminalPalette();
  let left = width;
  const parts: { text: string; tone: TerminalTone }[] = [];
  segments.forEach((segment, index) => {
    if (left <= 0) return;
    const prefix = index === 0 ? '' : separator;
    const text = truncateTerminalText(prefix + sanitizeTerminalText(segment.text), left);
    left -= terminalTextWidth(text);
    parts.push({ text, tone: segment.tone ?? 'muted' });
  });
  return (
    <text wrapMode='none'>
      {parts.map((part, index) => (
        <span key={index} fg={palette[part.tone]}>
          {part.text}
        </span>
      ))}
    </text>
  );
}

/** The footer of key hints, fitted to the width from the screen's own keymap. */
export function TerminalKeyHints({
  bindings,
  width,
}: {
  bindings: readonly TerminalKeyBinding[];
  width: number;
}) {
  const palette = useTerminalPalette();
  return (
    <text fg={palette.muted} wrapMode='none'>
      {fitTerminalText(fitTerminalKeyHints(bindings, width), width)}
    </text>
  );
}

/** Toasts, newest last, toned by kind. */
export function TerminalNotices({
  state,
  width,
}: {
  state: TerminalNoticesState;
  width: number;
}) {
  const palette = useTerminalPalette();
  return (
    <box style={{ flexDirection: 'column' }}>
      {state.notices.map((notice) => (
        <text
          key={notice.id}
          fg={palette[notice.tone]}
          bg={palette.panelRaised}
          wrapMode='none'
        >
          {fitTerminalText(` ${sanitizeTerminalText(notice.text)} `, Math.min(width, 60))}
        </text>
      ))}
    </box>
  );
}

/**
 * An application screen: breadcrumbs, status lines and a rule on top, the body
 * in the space left, key hints at the bottom, and toasts over the top-right
 * corner. Every line has a fixed place, so a screen never jumps while it updates.
 */
export function TerminalAppShell({
  breadcrumbs,
  status = [],
  bindings = [],
  notices,
  width,
  height,
  children,
}: {
  breadcrumbs: readonly string[];
  /** One or more status lines under the breadcrumbs. */
  status?: readonly (readonly TerminalSegment[])[];
  bindings?: readonly TerminalKeyBinding[];
  notices?: TerminalNoticesState;
  width: number;
  height: number;
  children: ReactNode;
}) {
  const palette = useTerminalPalette();
  const crumbs = breadcrumbs.map((crumb) => sanitizeTerminalText(crumb));
  const last = crumbs.length - 1;
  return (
    <box style={{ flexDirection: 'column', width, height }}>
      <text wrapMode='none'>
        {crumbs.map((crumb, index) => (
          <span key={index} fg={index === last ? palette.accent : palette.muted}>
            {`${index === 0 ? '' : ' › '}${crumb}`}
          </span>
        ))}
      </text>
      {status.map((segments, index) => (
        <TerminalStatusBar key={index} segments={segments} width={width} />
      ))}
      <text fg={palette.border} wrapMode='none'>
        {'─'.repeat(Math.max(0, width))}
      </text>
      <box style={{ flexDirection: 'column', flexGrow: 1, flexShrink: 1, overflow: 'hidden' }}>
        {children}
      </box>
      {bindings.length > 0 ? <TerminalKeyHints bindings={bindings} width={width} /> : null}
      {notices && notices.notices.length > 0 ? (
        <box style={{ position: 'absolute', top: 1, right: 1, zIndex: 10 }}>
          <TerminalNotices state={notices} width={width} />
        </box>
      ) : null}
    </box>
  );
}
