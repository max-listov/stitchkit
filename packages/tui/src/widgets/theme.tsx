import { TextAttributes } from '@opentui/core';
import { useRenderer } from '@opentui/react';
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  resolveTerminalPalette,
  type TerminalPalette,
  type TerminalThemeMode,
  type TerminalTone,
  terminalPalettes,
} from '../core/theme';

/**
 * The text attribute that carries a tone where colour does not: `danger` and
 * `warning` are bold, `muted` is dim. A terminal without colour, `NO_COLOR` or
 * a reader who does not tell red from green still sees which rows stand out.
 */
export function terminalToneAttributes(tone: TerminalTone | undefined): number {
  if (tone === 'danger' || tone === 'warning') return TextAttributes.BOLD;
  if (tone === 'muted') return TextAttributes.DIM;
  return TextAttributes.NONE;
}

const PaletteContext = createContext<TerminalPalette>(terminalPalettes.dark);

/** The palette widgets draw with: the nearest provider's, or the dark one. */
export function useTerminalPalette(): TerminalPalette {
  return useContext(PaletteContext);
}

/**
 * Follow the terminal's background: `auto` reads what the terminal reports
 * (OSC colour query) and switches when it changes; until it answers, and on a
 * terminal that never does, the palette is dark.
 */
export function useTerminalThemeMode(mode: TerminalThemeMode | 'auto'): TerminalThemeMode {
  const renderer = useRenderer();
  const [reported, setReported] = useState<TerminalThemeMode | null>(renderer.themeMode);
  useEffect(() => {
    if (mode !== 'auto') return;
    const update = (next: TerminalThemeMode): void => setReported(next);
    renderer.on('theme_mode', update);
    setReported(renderer.themeMode);
    return () => {
      renderer.off('theme_mode', update);
    };
  }, [mode, renderer]);
  return mode === 'auto' ? (reported ?? 'dark') : mode;
}

export function TerminalThemeProvider({
  mode = 'auto',
  palette,
  children,
}: {
  mode?: TerminalThemeMode | 'auto';
  /** Colours to change in the chosen palette. */
  palette?: Partial<TerminalPalette>;
  children: ReactNode;
}) {
  const resolved = useTerminalThemeMode(mode);
  const value = useMemo(() => resolveTerminalPalette(resolved, palette), [resolved, palette]);
  return <PaletteContext.Provider value={value}>{children}</PaletteContext.Provider>;
}
