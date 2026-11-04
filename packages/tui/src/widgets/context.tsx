import { createContext, type ReactNode, useContext, useMemo } from 'react';
import type { TerminalFocusAction, TerminalFocusState } from '../core/focus';
import { type TerminalLabels, terminalLabelsEn } from '../core/labels';

const LabelsContext = createContext<TerminalLabels>(terminalLabelsEn);

/** The words every widget below draws; English without a provider. */
export function TerminalLabelsProvider({
  labels,
  children,
}: {
  labels: TerminalLabels;
  children: ReactNode;
}) {
  return <LabelsContext.Provider value={labels}>{children}</LabelsContext.Provider>;
}

export function useTerminalLabels(): TerminalLabels {
  return useContext(LabelsContext);
}

interface FocusContextValue {
  state: TerminalFocusState;
  dispatch(action: TerminalFocusAction): void;
}

const FocusContext = createContext<FocusContextValue | null>(null);

/**
 * Shares one focus state (from `createTerminalFocus`, owned by the host) with
 * the widgets below; a widget given `focusId` answers the keyboard only while
 * that id is focused.
 */
export function TerminalFocusProvider({
  state,
  dispatch,
  children,
}: FocusContextValue & { children: ReactNode }) {
  const value = useMemo(() => ({ state, dispatch }), [state, dispatch]);
  return <FocusContext.Provider value={value}>{children}</FocusContext.Provider>;
}

export function useTerminalFocusContext(): FocusContextValue | null {
  return useContext(FocusContext);
}

/**
 * Whether a widget answers the keyboard: an explicit `focused` prop wins, then
 * the provider's focus for `focusId`, and a widget outside any provider is focused.
 */
export function useTerminalFocused(focusId?: string, focused?: boolean): boolean {
  const context = useContext(FocusContext);
  if (focused !== undefined) return focused;
  if (focusId === undefined || context === null) return true;
  return context.state.focused === focusId;
}
